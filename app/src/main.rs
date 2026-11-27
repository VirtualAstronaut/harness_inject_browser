//! Harness Bridge — macOS menu-bar app.
//!
//! Usage: `harness-bridge [FOLDER]`. With a folder (e.g. `.`), that folder becomes the
//! project: it is trusted (and remembered in trusted.json) and actions without a `cwd`
//! run there. If the app is already running, the folder is handed to it instead.
//!
//! Listens on a Unix socket for NDJSON requests relayed by `bridge-host`
//! (the Chrome Native Messaging host). Checks folder trust and the approval
//! policy, runs commands inside a macOS sandbox while streaming their output,
//! performs file reads/edits, and replies with a final result line.

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

mod files;
mod policy;
mod redact;
mod sandbox;
mod setup;
mod trust;

use files::FileRequest;
use policy::{Decision, Policy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, RunEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use trust::TrustStore;

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Max characters of stdout / stderr returned (head + tail are kept).
const MAX_OUTPUT_CHARS: usize = 16_000;
/// Max characters streamed live per command.
const MAX_STREAM_CHARS: usize = 200_000;
/// Commands longer than this are refused: the user must be able to read what they approve.
const MAX_CMD_CHARS: usize = 2_000;
const MAX_DIFF_CHARS: usize = 40_000;
const DEFAULT_TIMEOUT_S: u64 = 60;
const MAX_TIMEOUT_S: u64 = 600;

// ---------- protocol ----------

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Ping,
    Exec(ExecRequest),
    File(FileRequest),
    /// Stop a running command.
    Stop { id: String },
    /// User clicked "Trust folder".
    Trust { paths: Vec<String> },
    /// User clicked "Always allow" (kind = "cmd") or "auto-accept edits" (kind = "edits").
    AllowAlways { kind: String, cmd: Option<String> },
    /// `harness-bridge FOLDER` while the app is already running.
    SetProject { path: String },
}

#[derive(Deserialize)]
struct ExecRequest {
    id: String,
    cmd: String,
    cwd: Option<String>,
    timeout_s: Option<u64>,
    source: Option<String>,
    /// Set by the extension only after a trusted click on Run.
    #[serde(default)]
    approved: bool,
    /// User clicked "Allow once" on the folder-trust prompt.
    #[serde(default)]
    trust_once: bool,
    /// User clicked "Retry with network".
    #[serde(default)]
    network: bool,
    /// User clicked "Retry without sandbox".
    #[serde(default)]
    unsandboxed: bool,
}

#[derive(Serialize)]
struct Response {
    r#type: &'static str,
    id: String,
    /// ok | denied | timeout | stopped | error | needs_approval | needs_trust
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    paths: Option<Vec<String>>,
    /// How it was approved: dev-auto | policy | inline | dialog
    #[serde(skip_serializing_if = "Option::is_none")]
    approval: Option<&'static str>,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
    duration_ms: u128,
    /// Sandbox used: workspace-write | workspace-write+network | off
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox: Option<&'static str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    sandbox_blocked: bool,
    /// How many secrets were masked in stdout/stderr.
    #[serde(skip_serializing_if = "is_zero")]
    redacted: usize,
    /// File edits: unified diff (for review, or of what was applied).
    #[serde(skip_serializing_if = "Option::is_none")]
    diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

impl Response {
    fn new(id: impl Into<String>, status: &'static str) -> Self {
        Self {
            r#type: "result",
            id: id.into(),
            status,
            paths: None,
            approval: None,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
            duration_ms: 0,
            sandbox: None,
            sandbox_blocked: false,
            redacted: 0,
            diff: None,
            note: None,
            error: None,
        }
    }
    fn fail(id: impl Into<String>, status: &'static str, error: impl Into<String>) -> Self {
        Self { error: Some(error.into()), ..Self::new(id, status) }
    }
}

// ---------- paths ----------

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}
fn support_dir() -> PathBuf {
    home().join("Library/Application Support/harness-bridge")
}
fn socket_path() -> PathBuf {
    support_dir().join("bridge.sock")
}
fn audit_path() -> PathBuf {
    support_dir().join("audit.log")
}
fn policy_path() -> PathBuf {
    support_dir().join("policy.json")
}
fn trust_path() -> PathBuf {
    support_dir().join("trusted.json")
}

fn auto_approve() -> bool {
    std::env::var("HARNESS_BRIDGE_AUTO_APPROVE").as_deref() == Ok("1")
}

// ---------- server ----------

struct Ctx {
    app: AppHandle,
    last_item: MenuItem<Wry>,
    project_item: MenuItem<Wry>,
    /// Current project folder (default cwd for actions).
    project: Mutex<Option<PathBuf>>,
    /// One approval + execution at a time.
    gate: Mutex<()>,
    /// Stop flags of running commands, by id.
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn start_server(ctx: Arc<Ctx>) -> std::io::Result<()> {
    let dir = support_dir();
    fs::create_dir_all(&dir)?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;

    let sock = socket_path();
    if sock.exists() {
        if UnixStream::connect(&sock).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "another Harness Bridge instance is already running",
            ));
        }
        fs::remove_file(&sock)?; // stale socket from a crashed run
    }
    let listener = UnixListener::bind(&sock)?;
    fs::set_permissions(&sock, fs::Permissions::from_mode(0o600))?;

    thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let ctx = ctx.clone();
            thread::spawn(move || {
                if let Err(e) = handle_conn(&ctx, conn) {
                    eprintln!("[bridge] connection error: {e}");
                }
            });
        }
    });
    Ok(())
}

fn handle_conn(ctx: &Ctx, conn: UnixStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;

    let writer = Mutex::new(conn);
    let send = |v: &Value| {
        let mut w = writer.lock().unwrap();
        let _ = w.write_all(v.to_string().as_bytes());
        let _ = w.write_all(b"\n");
    };

    let reply = match serde_json::from_str::<Request>(&line) {
        Ok(Request::Ping) => {
            let p = Policy::load_or_create(&policy_path());
            let project = ctx.project.lock().unwrap().clone();
            json!({
                "type": "pong", "version": VERSION, "auto_approve": auto_approve(),
                "approval": p.approval, "sandbox": p.sandbox.enabled, "auto_accept_edits": p.auto_accept_edits,
                "project": project.as_ref().map(|d| d.display().to_string()),
                "project_name": project.as_ref().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().to_string()),
            })
        }
        Ok(Request::Exec(req)) => {
            let id = req.id.clone();
            let progress = |stream: &str, chunk: &str| {
                send(&json!({"type": "progress", "id": id, "stream": stream, "chunk": chunk}));
            };
            serde_json::to_value(handle_exec(ctx, req, &progress)).unwrap()
        }
        Ok(Request::File(req)) => serde_json::to_value(handle_file(ctx, req)).unwrap(),
        Ok(Request::Stop { id }) => {
            let flag = ctx.running.lock().unwrap().get(&id).cloned();
            if let Some(f) = &flag {
                f.store(true, Ordering::SeqCst);
            }
            json!({"type": "stopped", "id": id, "found": flag.is_some()})
        }
        Ok(Request::Trust { paths }) => {
            let _guard = ctx.gate.lock().unwrap_or_else(|p| p.into_inner());
            let mut store = TrustStore::load(&trust_path());
            let mut added = vec![];
            let mut errors = vec![];
            for p in &paths {
                match store.add(&trust::expand_tilde(p, &home())) {
                    Ok(c) => added.push(c.display().to_string()),
                    Err(e) => errors.push(e),
                }
            }
            if let Err(e) = store.save(&trust_path()) {
                errors.push(format!("could not save trusted.json: {e}"));
            }
            audit_event(json!({ "event": "trust", "added": added, "errors": errors }));
            json!({ "type": "trusted", "added": added, "errors": errors })
        }
        Ok(Request::AllowAlways { kind, cmd }) => {
            let _guard = ctx.gate.lock().unwrap_or_else(|p| p.into_inner());
            let p = policy_path();
            let mut pol = Policy::load_or_create(&p);
            let rule = match (kind.as_str(), cmd) {
                ("edits", _) => {
                    pol.auto_accept_edits = true;
                    "auto_accept_edits".to_string()
                }
                ("cmd", Some(c)) => pol.always_allow_rule(&c),
                _ => String::new(),
            };
            let ok = !rule.is_empty() && pol.save(&p).is_ok();
            audit_event(json!({ "event": "always_allow", "kind": kind, "rule": rule, "ok": ok }));
            json!({ "type": "allowed", "rule": rule, "ok": ok })
        }
        Ok(Request::SetProject { path }) => match set_project(ctx, Path::new(&path)) {
            Ok(dir) => json!({ "type": "project", "path": dir.display().to_string() }),
            Err(e) => json!({ "type": "project", "error": e }),
        },
        Err(e) => serde_json::to_value(Response::fail("", "error", format!("bad request: {e}"))).unwrap(),
    };

    send(&reply);
    Ok(())
}

/// Make `dir` the project: trust it (remembered in trusted.json) and use it as the default cwd.
fn set_project(ctx: &Ctx, dir: &Path) -> Result<PathBuf, String> {
    let dir = trust::canon(dir);
    if !dir.is_dir() {
        return Err(format!("not a folder: {}", dir.display()));
    }
    let _guard = ctx.gate.lock().unwrap_or_else(|p| p.into_inner());
    let mut store = TrustStore::load(&trust_path());
    store.add(&dir)?;
    store.save(&trust_path()).map_err(|e| format!("could not save trusted.json: {e}"))?;
    *ctx.project.lock().unwrap() = Some(dir.clone());
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.display().to_string());
    let _ = ctx.project_item.set_text(format!("Project: {name}"));
    audit_event(json!({ "event": "project", "path": dir.display().to_string() }));
    eprintln!("[bridge] project: {}", dir.display());
    Ok(dir)
}

fn resolve_cwd(ctx: &Ctx, cwd: Option<&str>) -> Result<PathBuf, String> {
    let project = ctx.project.lock().unwrap().clone();
    let path = trust::resolve_dir(cwd, project.as_deref(), &home());
    if path.is_dir() {
        Ok(path)
    } else {
        Err(format!("cwd does not exist or is not a directory: {}", path.display()))
    }
}

fn set_last(ctx: &Ctx, what: &str, status: &str, code: Option<i32>) {
    let short: String = what.chars().take(40).collect();
    let more = if what.chars().count() > 40 { "…" } else { "" };
    let st = code.map_or(status.to_string(), |c| format!("{status} {c}"));
    let _ = ctx.last_item.set_text(format!("Last: [{st}] {short}{more}"));
}

// ---------- commands ----------

fn handle_exec(ctx: &Ctx, req: ExecRequest, progress: &dyn Fn(&str, &str)) -> Response {
    let _guard = ctx.gate.lock().unwrap_or_else(|p| p.into_inner());
    let source = req.source.clone().unwrap_or_else(|| "unknown source".into());

    if req.cmd.trim().is_empty() {
        return Response::fail(req.id, "error", "empty command");
    }
    if req.cmd.chars().count() > MAX_CMD_CHARS {
        return Response::fail(
            req.id,
            "error",
            format!("command longer than {MAX_CMD_CHARS} chars; refused because it can't be reviewed"),
        );
    }
    let cwd = match resolve_cwd(ctx, req.cwd.as_deref()) {
        Ok(p) => p,
        Err(e) => return Response::fail(req.id, "error", e),
    };
    let timeout_s = req.timeout_s.unwrap_or(DEFAULT_TIMEOUT_S).clamp(1, MAX_TIMEOUT_S);

    // 1. Folder trust: the cwd and every `cd` target.
    let store = TrustStore::load(&trust_path());
    let dirs = match trust::workdirs(&req.cmd, &cwd, &home()) {
        Ok(d) => d,
        Err(why) if !req.approved && !auto_approve() => return Response::fail(req.id, "needs_approval", why),
        Err(_) => vec![trust::canon(&cwd)],
    };
    if !auto_approve() && !req.trust_once {
        let untrusted: Vec<String> =
            dirs.iter().filter(|d| !store.is_trusted(d)).map(|d| d.display().to_string()).collect();
        if !untrusted.is_empty() {
            let mut r = Response::fail(req.id, "needs_trust", "folder is not trusted yet");
            r.paths = Some(untrusted);
            return r;
        }
    }

    // 2. Approval policy.
    let policy = Policy::load_or_create(&policy_path());
    let decision = policy.decide(&req.cmd);
    let how: &'static str = if auto_approve() {
        "dev-auto"
    } else if decision == Decision::Auto {
        "policy"
    } else if req.approved {
        "inline"
    } else if policy.approval == "dialog" {
        "dialog"
    } else {
        let reason = match decision {
            Decision::Ask(r) => r,
            Decision::Auto => unreachable!(),
        };
        return Response::fail(req.id, "needs_approval", reason);
    };
    if how == "dialog" {
        let msg = format!(
            "{source} wants to run:\n\n{}\n\nin: {}\ntimeout: {timeout_s}s · id: {}",
            req.cmd,
            cwd.display(),
            req.id
        );
        let ok = ctx
            .app
            .dialog()
            .message(msg)
            .title("Harness Bridge — run this command?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Run".into(), "Deny".into()))
            .blocking_show();
        if !ok {
            let r = Response::fail(req.id.clone(), "denied", "user denied the command");
            audit_exec(&req, &cwd, &source, &r);
            return r;
        }
    }

    // 3. Sandbox plan: writable = the trusted folder(s) the command works in.
    let sb = &policy.sandbox;
    let plan = (sb.enabled && !req.unsandboxed).then(|| {
        let roots: Vec<PathBuf> = dirs.iter().map(|d| store.root_for(d).unwrap_or_else(|| d.clone())).collect();
        let net = req.network || sandbox::wants_network(&req.cmd, &sb.network_allow);
        sandbox::build_plan(&roots, sb, &home(), net)
    });

    // 4. Run, streaming output; Stop requests flip the flag.
    let stop = Arc::new(AtomicBool::new(false));
    ctx.running.lock().unwrap().insert(req.id.clone(), stop.clone());
    let mut resp = run_command(
        &req,
        &cwd,
        Duration::from_secs(timeout_s),
        plan.as_ref(),
        &stop,
        progress,
        policy.redact,
    );
    ctx.running.lock().unwrap().remove(&req.id);

    resp.approval = Some(how);
    resp.sandbox = Some(plan.as_ref().map_or("off", |p| p.label()));
    resp.sandbox_blocked = plan.is_some() && sandbox::looks_blocked(resp.exit_code, &resp.stdout, &resp.stderr);
    audit_exec(&req, &cwd, &source, &resp);
    set_last(ctx, &req.cmd, resp.status, resp.exit_code);
    resp
}

fn run_command(
    req: &ExecRequest,
    cwd: &Path,
    timeout: Duration,
    sandbox: Option<&sandbox::Plan>,
    stop: &AtomicBool,
    progress: &dyn Fn(&str, &str),
    mask: bool,
) -> Response {
    let start = Instant::now();
    let mut cmd = match sandbox {
        Some(plan) => {
            let (profile, params) = sandbox::profile(plan);
            let mut c = Command::new(sandbox::SANDBOX_EXEC);
            c.arg("-p").arg(profile);
            for (k, v) in params {
                c.arg(format!("-D{k}={v}"));
            }
            c.arg("--").arg("/bin/zsh");
            c
        }
        None => Command::new("/bin/zsh"),
    };
    let mut child = match cmd
        .arg("-lc")
        .arg(&req.cmd)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0) // so timeout/stop can kill the whole tree
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Response::fail(req.id.clone(), "error", format!("spawn failed: {e}")),
    };

    let (tx, rx) = mpsc::channel::<(bool, Vec<u8>)>();
    spawn_reader(child.stdout.take().unwrap(), false, tx.clone());
    spawn_reader(child.stderr.take().unwrap(), true, tx);

    let pgid = child.id() as i32;
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let (mut pend_out, mut pend_err) = (String::new(), String::new());
    let mut streamed = 0usize;
    let mut last_emit = Instant::now();
    let mut exit = None;
    let mut status = "ok";
    let mut drain_until: Option<Instant> = None;
    let mut readers_done = false;

    let flush = |pend_out: &mut String, pend_err: &mut String| {
        if !pend_out.is_empty() {
            progress("stdout", &masked(pend_out, mask).0);
            pend_out.clear();
        }
        if !pend_err.is_empty() {
            progress("stderr", &masked(pend_err, mask).0);
            pend_err.clear();
        }
    };

    loop {
        match rx.recv_timeout(Duration::from_millis(30)) {
            Ok((is_err, bytes)) => {
                if streamed < MAX_STREAM_CHARS {
                    let s = String::from_utf8_lossy(&bytes);
                    streamed += s.len();
                    if is_err { &mut pend_err } else { &mut pend_out }.push_str(&s);
                }
                if is_err { &mut err } else { &mut out }.extend_from_slice(&bytes);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                readers_done = true;
                thread::sleep(Duration::from_millis(30));
            }
        }
        if last_emit.elapsed() >= Duration::from_millis(150) {
            flush(&mut pend_out, &mut pend_err);
            last_emit = Instant::now();
        }
        if drain_until.is_none() {
            let kill = |reason: &'static str, status: &mut &'static str| {
                unsafe { libc::killpg(pgid, libc::SIGKILL) };
                *status = reason;
            };
            match child.try_wait() {
                Ok(Some(st)) => exit = st.code(),
                Ok(None) if stop.load(Ordering::SeqCst) => kill("stopped", &mut status),
                Ok(None) if start.elapsed() > timeout => kill("timeout", &mut status),
                Ok(None) => continue,
                Err(_) => {}
            }
            if status != "ok" {
                let _ = child.wait();
            }
            drain_until = Some(Instant::now() + Duration::from_millis(1500));
        }
        if readers_done || drain_until.is_some_and(|d| Instant::now() > d) {
            break;
        }
    }
    flush(&mut pend_out, &mut pend_err);

    // Mask before clipping so a secret can't be cut in half and survive.
    let (out_s, n1) = masked(&String::from_utf8_lossy(&out), mask);
    let (err_s, n2) = masked(&String::from_utf8_lossy(&err), mask);
    let (stdout, t1) = clip_str(&out_s, MAX_OUTPUT_CHARS);
    let (stderr, t2) = clip_str(&err_s, MAX_OUTPUT_CHARS);
    let mut r = Response::new(req.id.clone(), status);
    r.exit_code = exit;
    r.stdout = stdout;
    r.stderr = stderr;
    r.truncated = t1 || t2;
    r.redacted = n1 + n2;
    r.duration_ms = start.elapsed().as_millis();
    r.error = match status {
        "timeout" => Some(format!("killed after {}s timeout", timeout.as_secs())),
        "stopped" => Some("stopped by the user".into()),
        _ => None,
    };
    r
}

fn spawn_reader(mut pipe: impl Read + Send + 'static, is_err: bool, tx: mpsc::Sender<(bool, Vec<u8>)>) {
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 || tx.send((is_err, chunk[..n].to_vec())).is_err() {
                break;
            }
        }
    });
}

fn masked(s: &str, mask: bool) -> (String, usize) {
    if mask {
        redact::redact(s)
    } else {
        (s.to_string(), 0)
    }
}

/// Keep the head and tail of long output.
fn clip_str(s: &str, max: usize) -> (String, bool) {
    let n = s.chars().count();
    if n <= max {
        return (s.to_string(), false);
    }
    let half = max / 2;
    let head: String = s.chars().take(half).collect();
    let tail: String = s.chars().skip(n - half).collect();
    (format!("{head}\n… [{} chars omitted] …\n{tail}", n - 2 * half), true)
}

// ---------- file tools ----------

fn handle_file(ctx: &Ctx, req: FileRequest) -> Response {
    let _guard = ctx.gate.lock().unwrap_or_else(|p| p.into_inner());
    let id = req.id.clone();
    let cwd = match resolve_cwd(ctx, req.cwd.as_deref()) {
        Ok(p) => p,
        Err(e) => return Response::fail(id, "error", e),
    };
    let raw = trust::expand_tilde(req.path.trim(), &home());
    let joined = if raw.is_absolute() { raw } else { cwd.join(raw) };
    let path = match (joined.parent(), joined.file_name()) {
        (Some(parent), Some(name)) => trust::canon(parent).join(name),
        _ => return Response::fail(id, "error", format!("not a file path: {}", req.path)),
    };
    let shown = path.display().to_string();
    let rel = path.strip_prefix(trust::canon(&cwd)).map(|p| p.display().to_string()).unwrap_or(shown.clone());
    let policy = Policy::load_or_create(&policy_path());
    let free = req.approved || auto_approve();

    let lower = shown.to_lowercase();
    if !free {
        if let Some(p) = policy.danger_paths.iter().find(|p| lower.contains(&p.to_lowercase())) {
            return Response::fail(id, "needs_approval", format!("touches sensitive path \"{p}\""));
        }
    }

    let resp = match req.op.as_str() {
        "read" => read_file(&id, &path, &req, policy.redact),
        "write" | "patch" => {
            let parent = path.parent().unwrap_or(Path::new("/")).to_path_buf();
            if !auto_approve() && !req.trust_once && !TrustStore::load(&trust_path()).is_trusted(&parent) {
                let mut r = Response::fail(id, "needs_trust", "folder is not trusted yet");
                r.paths = Some(vec![trust::canon(&parent).display().to_string()]);
                return r;
            }
            let protected = path.components().any(|c| {
                let c = c.as_os_str().to_string_lossy();
                c == ".git" || c == ".harness-bridge"
            });
            if protected && !free {
                return Response::fail(id, "needs_approval", "edits inside .git");
            }
            edit_file(&id, &path, &rel, &req, req.approved || policy.auto_accept_edits || auto_approve())
        }
        other => Response::fail(id, "error", format!("unknown file op \"{other}\"")),
    };

    if resp.status != "needs_approval" {
        audit_event(json!({
            "event": "file", "op": req.op, "path": shown, "id": req.id, "status": resp.status,
            "error": resp.error, "source": req.source,
        }));
        set_last(ctx, &format!("{} {rel}", req.op), resp.status, None);
    }
    resp
}

fn read_text(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    if meta.len() > files::MAX_FILE_BYTES {
        return Err(format!("file is {} bytes; limit is {}", meta.len(), files::MAX_FILE_BYTES));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "binary or non-UTF-8 file".into())
}

fn read_file(id: &str, path: &Path, req: &FileRequest, mask: bool) -> Response {
    match read_text(path) {
        Ok(text) => {
            let (slice, total, note) = files::read_range(&text, req.start_line, req.end_line);
            let mut r = Response::new(id, "ok");
            r.exit_code = Some(0);
            let (text, n) = masked(&slice, mask);
            r.stdout = text;
            r.redacted = n;
            r.truncated = note.is_some();
            r.note = Some(note.unwrap_or_else(|| format!("{total} lines")));
            r
        }
        Err(e) => Response::fail(id, "error", e),
    }
}

fn edit_file(id: &str, path: &Path, rel: &str, req: &FileRequest, apply: bool) -> Response {
    let exists = path.exists();
    let old = if exists {
        match read_text(path) {
            Ok(t) => t,
            Err(e) => return Response::fail(id, "error", e),
        }
    } else if req.op == "patch" {
        return Response::fail(id, "error", "file does not exist; use write_file to create it");
    } else {
        String::new()
    };
    let new = if req.op == "write" {
        match &req.content {
            Some(c) => c.clone(),
            None => return Response::fail(id, "error", "write_file needs \"content\""),
        }
    } else {
        match files::apply_edits(&old, req.edits.as_deref().unwrap_or_default()) {
            Ok(t) => t,
            Err(e) => return Response::fail(id, "error", e),
        }
    };
    if exists && old == new {
        let mut r = Response::new(id, "ok");
        r.exit_code = Some(0);
        r.stdout = "no changes".into();
        return r;
    }
    let (diff, _) = clip_str(&files::unified_diff(rel, &old, &new), MAX_DIFF_CHARS);
    if !apply {
        let mut r = Response::fail(id, "needs_approval", "review the file changes");
        r.diff = Some(diff);
        r.paths = Some(vec![path.display().to_string()]);
        return r;
    }
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return Response::fail(id, "error", format!("could not create folder: {e}"));
        }
    }
    if let Err(e) = fs::write(path, &new) {
        return Response::fail(id, "error", format!("write failed: {e}"));
    }
    let (add, del) = files::diff_stats(&old, &new);
    let mut r = Response::new(id, "ok");
    r.exit_code = Some(0);
    r.stdout = format!("{} {rel} (+{add} -{del} lines)", if exists { "updated" } else { "created" });
    r.approval = Some(if req.approved { "inline" } else { "policy" });
    r
}

// ---------- audit ----------

fn audit_exec(req: &ExecRequest, cwd: &Path, source: &str, resp: &Response) {
    audit_event(json!({
        "source": source, "id": req.id, "cmd": req.cmd,
        "cwd": cwd.display().to_string(), "status": resp.status,
        "exit_code": resp.exit_code, "duration_ms": resp.duration_ms,
        "approval": resp.approval, "sandbox": resp.sandbox, "sandbox_blocked": resp.sandbox_blocked,
    }));
}

fn audit_event(mut entry: Value) {
    use std::os::unix::fs::OpenOptionsExt;
    if entry.get("ts").is_none() {
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        entry["ts"] = ts.into();
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).mode(0o600).open(audit_path()) {
        let _ = writeln!(f, "{entry}");
    }
}

// ---------- app ----------

fn update_policy(f: impl FnOnce(&mut Policy)) {
    let p = policy_path();
    let mut pol = Policy::load_or_create(&p);
    f(&mut pol);
    if let Err(e) = pol.save(&p) {
        eprintln!("[bridge] could not save policy: {e}");
    }
}

const USAGE: &str = "usage: harness-bridge [FOLDER]
       harness-bridge setup

Starts the Harness Bridge menu-bar app. With FOLDER (for example `.`), that folder
becomes the project: it is trusted (and remembered), and actions from the chat
run there unless they name another folder. If Harness Bridge is already running,
FOLDER is handed to it and this command exits.

`setup` asks which browsers (Chrome, Brave, Edge, Chromium, Arc) to connect, then
helps you load the extension. The first start offers to run it for you.
(For a folder named setup, use `./setup`.)";

/// Parse arguments; hand the folder to a running instance if there is one.
/// Returns the project folder to start with.
fn cli() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{USAGE}");
        std::process::exit(0);
    }
    if args.len() == 1 && args[0] == "setup" {
        std::process::exit(setup::run(&home(), false));
    }
    if args.len() > 1 {
        eprintln!("{USAGE}");
        std::process::exit(2);
    }
    let project = args.first().map(|a| {
        let here = std::env::current_dir().unwrap_or_else(|_| home());
        let dir = trust::canon(&here.join(trust::expand_tilde(a, &home())));
        if !dir.is_dir() {
            eprintln!("harness-bridge: not a folder: {}", dir.display());
            std::process::exit(1);
        }
        dir
    });
    if let Some(dir) = &project {
        confirm_trust(dir);
    }

    // Already running? Hand over the folder (like `code .`) instead of failing.
    if let Ok(mut conn) = UnixStream::connect(socket_path()) {
        let Some(dir) = &project else {
            eprintln!("Harness Bridge is already running. Use `harness-bridge <folder>` to switch project.");
            std::process::exit(1);
        };
        let msg = json!({ "type": "set_project", "path": dir.display().to_string() });
        let _ = conn.write_all(format!("{msg}\n").as_bytes());
        let mut line = String::new();
        let _ = BufReader::new(conn).read_line(&mut line);
        match serde_json::from_str::<Value>(&line) {
            Ok(v) if v.get("error").is_none() => {
                println!("Harness Bridge is already running; switched project to {}", dir.display());
                std::process::exit(0);
            }
            Ok(v) => {
                eprintln!("harness-bridge: {}", v["error"].as_str().unwrap_or("could not switch project"));
                std::process::exit(1);
            }
            Err(_) => {
                eprintln!("harness-bridge: the running app did not answer (is it an older version? quit it and retry)");
                std::process::exit(1);
            }
        }
    }
    for app in setup::repair(&home()) {
        println!("✓ updated the {app} connection");
    }
    first_run_setup();
    project
}

/// `harness-bridge FOLDER` on a folder that isn't trusted yet: ask in the terminal first,
/// with a stricter prompt for very broad folders. Exits if the answer is no, or if there
/// is no terminal to ask in (a script can't trust a new folder silently).
fn confirm_trust(dir: &Path) {
    if auto_approve() || TrustStore::load(&trust_path()).is_trusted(dir) {
        return;
    }
    if !setup::interactive() {
        eprintln!(
            "harness-bridge: {} is not trusted yet. Run `harness-bridge .` there in a terminal to confirm it.",
            dir.display()
        );
        std::process::exit(1);
    }
    println!("Use this folder as the project?\n  {}", dir.display());
    println!("The model will be able to run commands and edit files in it (inside the sandbox).");
    println!("It stays trusted until you remove it from trusted.json (menu bar → Trusted folders…).\n");
    let (mut input, mut out) = (std::io::stdin().lock(), std::io::stdout());
    let ok = if trust::is_broad(dir, &home()) {
        println!("⚠️  This is your home folder, a folder above it, a whole drive or the disk root.");
        println!("   Trusting it lets the model work almost anywhere. A project folder is safer.");
        setup::ask_exact(&mut input, &mut out, "Trust it anyway?", "yes")
    } else {
        setup::ask_yes(&mut input, &mut out, "Trust this folder?", false)
    };
    if !ok {
        println!("Not trusted. Nothing changed.");
        std::process::exit(1);
    }
    println!();
}

/// First start with no browser connected: offer to run setup, once per Mac user,
/// whatever the outcome, so later starts never nag.
fn first_run_setup() {
    let offered = support_dir().join("setup-offered");
    if !setup::interactive() || setup::is_registered(&home()) || offered.exists() {
        return;
    }
    let _ = fs::create_dir_all(support_dir());
    let _ = fs::write(&offered, "");
    println!("Harness Bridge isn't connected to a browser yet.");
    let yes = setup::ask_yes(&mut std::io::stdin().lock(), &mut std::io::stdout(), "Set it up now?", true);
    if yes {
        println!();
        setup::run(&home(), true); // explains how to retry if nothing was connected
        println!();
    } else {
        println!("OK, I won't ask again. Run `harness-bridge setup` any time.\n");
    }
}

fn main() {
    let startup_project = cli();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // no Dock icon

            let status_text = if auto_approve() {
                "⚠️ AUTO-APPROVE ON (dev only)"
            } else {
                "Harness Bridge: listening"
            };
            let status = MenuItem::with_id(app, "status", status_text, false, None::<&str>)?;
            let last = MenuItem::with_id(app, "last", "No commands yet", false, None::<&str>)?;
            let project_item =
                MenuItem::with_id(app, "project", "No project (run: harness-bridge <folder>)", false, None::<&str>)?;
            let log = MenuItem::with_id(app, "log", "Open audit log", true, None::<&str>)?;
            let pol = MenuItem::with_id(app, "policy", "Edit approval policy…", true, None::<&str>)?;
            let trusted = MenuItem::with_id(app, "trusted", "Trusted folders…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Harness Bridge", true, None::<&str>)?;

            let current = Policy::load_or_create(&policy_path());
            let sandbox_item =
                CheckMenuItem::with_id(app, "sandbox", "Sandbox commands", true, current.sandbox.enabled, None::<&str>)?;
            let edits_item = CheckMenuItem::with_id(
                app,
                "edits",
                "Auto-accept file edits",
                true,
                current.auto_accept_edits,
                None::<&str>,
            )?;

            // Approval mode radio group (persisted in policy.json)
            let modes: Vec<(&'static str, CheckMenuItem<Wry>)> = [
                ("auto", "Auto — ask only for dangerous commands"),
                ("inline", "Allowlist — ask unless known read-only"),
                ("dialog", "Allowlist + native dialog"),
            ]
            .into_iter()
            .map(|(id, label)| {
                CheckMenuItem::with_id(app, format!("mode:{id}"), label, true, current.approval == id, None::<&str>)
                    .map(|item| (id, item))
            })
            .collect::<Result<_, _>>()?;
            let mode_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
                modes.iter().map(|(_, i)| i as &dyn tauri::menu::IsMenuItem<Wry>).collect();
            let mode_menu = Submenu::with_items(app, "Approval mode", true, &mode_refs)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[&status, &project_item, &last, &sep, &mode_menu, &sandbox_item, &edits_item, &trusted, &log, &pol, &quit],
            )?;

            let (sandbox_c, edits_c) = (sandbox_item.clone(), edits_item.clone());
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("icon").clone())
                .icon_as_template(true)
                .tooltip("Harness Bridge")
                .menu(&menu)
                .on_menu_event(move |app, ev| match ev.id.as_ref() {
                    id if id.starts_with("mode:") => {
                        let chosen = id[5..].to_string();
                        update_policy(|p| p.approval = chosen.clone());
                        for (mid, item) in &modes {
                            let _ = item.set_checked(*mid == chosen);
                        }
                    }
                    "sandbox" => {
                        let on = sandbox_c.is_checked().unwrap_or(true);
                        update_policy(|p| p.sandbox.enabled = on);
                    }
                    "edits" => {
                        let on = edits_c.is_checked().unwrap_or(false);
                        update_policy(|p| p.auto_accept_edits = on);
                    }
                    "quit" => app.exit(0),
                    "log" => {
                        let p = audit_path();
                        let _ = OpenOptions::new().create(true).append(true).open(&p);
                        let _ = Command::new("open").arg("-t").arg(p).spawn();
                    }
                    "trusted" => {
                        let p = trust_path();
                        if !p.exists() {
                            let _ = TrustStore::default().save(&p);
                        }
                        let _ = Command::new("open").arg("-t").arg(p).spawn();
                    }
                    "policy" => {
                        let p = policy_path();
                        Policy::load_or_create(&p); // writes defaults if missing
                        let _ = Command::new("open").arg("-t").arg(p).spawn();
                    }
                    _ => {}
                })
                .build(app)?;

            let ctx = Arc::new(Ctx {
                app: app.handle().clone(),
                last_item: last,
                project_item,
                project: Mutex::new(None),
                gate: Mutex::new(()),
                running: Mutex::new(HashMap::new()),
            });
            if let Some(dir) = &startup_project {
                set_project(&ctx, dir).map_err(|e| std::io::Error::other(e))?;
            }
            start_server(ctx)?;
            eprintln!("[bridge] listening on {}", socket_path().display());
            match &startup_project {
                Some(dir) => eprintln!("Harness Bridge is running for {}\nPress Ctrl+C to stop.", dir.display()),
                None => eprintln!("Harness Bridge is running (no project folder). Press Ctrl+C to stop."),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Harness Bridge");

    app.run(|_, ev| {
        // No windows: keep running until "Quit" is chosen from the tray.
        if let RunEvent::ExitRequested { api, code, .. } = ev {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
