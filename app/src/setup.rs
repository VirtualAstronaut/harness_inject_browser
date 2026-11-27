//! `harness-bridge setup`: registers the `bridge-host` native messaging host with
//! Chrome-family browsers, so the extension can reach the app.
//!
//! Homebrew cannot write into `~/Library`, so each user runs this once after install.

use std::{
    fs,
    io::{BufRead, IsTerminal, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde_json::json;

/// Fixed by the `key` field in `extension/manifest.json`.
pub const EXTENSION_ID: &str = "ckmjfebniegheoplafhgknkchhipjhmj";
pub const HOST_NAME: &str = "com.harness.bridge";

/// (profile folder under `~/Library/Application Support`, app name for `open -a`).
const BROWSERS: &[(&str, &str)] = &[
    ("Google/Chrome", "Google Chrome"),
    ("Google/Chrome Beta", "Google Chrome Beta"),
    ("Google/Chrome Canary", "Google Chrome Canary"),
    ("Chromium", "Chromium"),
    ("BraveSoftware/Brave-Browser", "Brave Browser"),
    ("Microsoft Edge", "Microsoft Edge"),
    ("Arc/User Data", "Arc"),
];

/// Puts `text` on the macOS clipboard.
fn copy_to_clipboard(text: &str) -> bool {
    let Ok(mut child) = Command::new("pbcopy").stdin(Stdio::piped()).spawn() else { return false };
    let wrote = child.stdin.take().is_some_and(|mut s| s.write_all(text.as_bytes()).is_ok());
    child.wait().is_ok_and(|s| s.success()) && wrote
}

/// Opens the extensions page in the first of `apps` that macOS can find. Returns its name.
fn open_extensions_page<'a>(apps: &[&'a str]) -> Option<&'a str> {
    apps.iter().copied().find(|app| {
        Command::new("open")
            .args(["-a", app, "chrome://extensions"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    })
}

/// Formula name, as in `<prefix>/Cellar/harness-bridge/<version>/`.
const FORMULA: &str = "harness-bridge";

/// Turns Homebrew's versioned path (`<prefix>/Cellar/harness-bridge/<version>/…`) into the
/// `<prefix>/opt/harness-bridge/…` link, which survives `brew upgrade`. Other paths are unchanged.
pub fn stable_path(p: &Path) -> PathBuf {
    let parts: Vec<_> = p.components().collect();
    let in_cellar = |i: usize| parts[i].as_os_str() == "Cellar" && parts[i + 1].as_os_str() == FORMULA;
    if let Some(i) = (0..parts.len().saturating_sub(1)).find(|&i| in_cellar(i)) {
        if parts.len() > i + 3 {
            let mut out: PathBuf = parts[..i].iter().collect();
            out.push("opt");
            out.push(parts[i + 1]);
            out.extend(&parts[i + 3..]);
            return out;
        }
    }
    p.to_path_buf()
}

pub fn manifest(host: &Path) -> String {
    serde_json::to_string_pretty(&json!({
        "name": HOST_NAME,
        "description": "Harness Bridge native host",
        "path": host.display().to_string(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    }))
    .unwrap()
}

/// First existing path among `candidates`, resolved and made upgrade-proof.
fn find(candidates: &[PathBuf], want_dir: bool) -> Option<PathBuf> {
    candidates
        .iter()
        .filter_map(|c| c.canonicalize().ok())
        .find(|c| if want_dir { c.is_dir() } else { c.is_file() })
        .map(|c| stable_path(&c))
}

/// Where the native messaging manifest lives for the browser profile folder `dir`.
fn manifest_path(support: &Path, dir: &str) -> PathBuf {
    support.join(dir).join("NativeMessagingHosts").join(format!("{HOST_NAME}.json"))
}

/// True if any browser already has the Harness Bridge manifest.
pub fn is_registered(home: &Path) -> bool {
    let support = home.join("Library/Application Support");
    BROWSERS.iter().any(|(dir, _)| manifest_path(&support, dir).is_file())
}

/// True when a person can answer prompts: not `brew test`, CI or a pipe.
pub fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Asks a yes/no question. Empty answer → `default`. End of input → no.
pub fn ask_yes(input: &mut impl BufRead, out: &mut impl Write, prompt: &str, default: bool) -> bool {
    let hint = if default { "[Y/n]" } else { "[y/N]" };
    loop {
        let _ = write!(out, "{prompt} {hint} ");
        let _ = out.flush();
        let mut line = String::new();
        if input.read_line(&mut line).unwrap_or(0) == 0 {
            let _ = writeln!(out);
            return false;
        }
        match line.trim().to_ascii_lowercase().as_str() {
            "" => return default,
            "y" | "yes" => return true,
            "n" | "no" => return false,
            _ => {
                let _ = writeln!(out, "Please type y or n.");
            }
        }
    }
}

/// Asks which of the `found` browsers (folder, app name) to connect. Empty answer → all.
fn choose<'a>(
    input: &mut impl BufRead,
    out: &mut impl Write,
    found: &[(&'a str, &'a str)],
    support: &Path,
) -> Vec<(&'a str, &'a str)> {
    if let [(_, app)] = found {
        let ok = ask_yes(input, out, &format!("Connect Harness Bridge to {app}?"), true);
        return if ok { found.to_vec() } else { vec![] };
    }
    let _ = writeln!(out, "Which browsers should Harness Bridge connect to?");
    for (i, (dir, app)) in found.iter().enumerate() {
        let note = if manifest_path(support, dir).is_file() { "  (already connected)" } else { "" };
        let _ = writeln!(out, "  {}) {app}{note}", i + 1);
    }
    loop {
        let _ = write!(out, "Type numbers separated by spaces, or press Return for all: ");
        let _ = out.flush();
        let mut line = String::new();
        if input.read_line(&mut line).unwrap_or(0) == 0 {
            let _ = writeln!(out);
            return vec![];
        }
        let line = line.trim().to_ascii_lowercase();
        if line.is_empty() || line == "all" || line == "a" {
            return found.to_vec();
        }
        let picks: Option<Vec<usize>> = line
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|t| !t.is_empty())
            .map(|t| t.parse::<usize>().ok().filter(|n| (1..=found.len()).contains(n)))
            .collect();
        match picks {
            Some(mut p) if !p.is_empty() => {
                p.sort_unstable();
                p.dedup();
                return p.into_iter().map(|n| found[n - 1]).collect();
            }
            _ => {
                let _ = writeln!(out, "Please type numbers from 1 to {}, for example: 1 2", found.len());
            }
        }
    }
}

/// `harness-bridge setup`. Asks before changing anything when run in a terminal;
/// otherwise connects every browser found and opens nothing.
/// `starting`: called on the app's first start, which goes on to run the app.
pub fn run(home: &Path, starting: bool) -> i32 {
    let exe = match std::env::current_exe().and_then(|p| p.canonicalize()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("harness-bridge setup: cannot locate this program: {e}");
            return 1;
        }
    };
    let bin = exe.parent().unwrap_or(Path::new("/"));

    // Homebrew keeps bridge-host in libexec; a source build has it next to harness-bridge.
    let Some(host) = find(&[bin.join("../libexec/bridge-host"), bin.join("bridge-host")], false) else {
        eprintln!("harness-bridge setup: bridge-host not found next to {}", exe.display());
        return 1;
    };

    let support = home.join("Library/Application Support");
    let found: Vec<(&str, &str)> = BROWSERS.iter().copied().filter(|(dir, _)| support.join(dir).is_dir()).collect();
    if found.is_empty() {
        eprintln!("✕ no Chrome-family browser found under {}", support.display());
        eprintln!("  Supported: Chrome, Brave, Edge, Chromium and Arc. Open one once, then run setup again.");
        return 1;
    }

    let ask = interactive();
    let (stdin, stdout) = (std::io::stdin(), std::io::stdout());
    let (mut input, mut out) = (stdin.lock(), stdout.lock());
    let chosen = if ask { choose(&mut input, &mut out, &found, &support) } else { found.clone() };
    if chosen.is_empty() {
        println!("Nothing changed. Run `harness-bridge setup` when you're ready.");
        return 1;
    }

    let body = manifest(&host);
    let mut registered: Vec<&str> = vec![];
    for (dir, app) in &chosen {
        let file = manifest_path(&support, dir);
        let written = file.parent().map_or(Ok(()), fs::create_dir_all).and_then(|_| fs::write(&file, &body));
        match written {
            Ok(()) => {
                println!("✓ connected {app}");
                registered.push(app);
            }
            Err(e) => eprintln!("✕ {app}: {e}"),
        }
    }
    if registered.is_empty() {
        return 1;
    }

    // Homebrew: <prefix>/share/harness-bridge/extension. Source build: app/target/<profile>/ → repo root.
    let Some(ext) = find(&[bin.join("../share/harness-bridge/extension"), bin.join("../../../extension")], true)
    else {
        println!("\nNext: open chrome://extensions, turn on Developer mode and load the extension/ folder.");
        return 0;
    };
    let ext = ext.display().to_string();

    let first = registered[0];
    let help = ask
        && ask_yes(
            &mut input,
            &mut out,
            &format!("\nOpen {first}'s extensions page and copy the extension folder path to your clipboard?"),
            true,
        );
    let copied = help && copy_to_clipboard(&ext);
    let opened = if help { open_extensions_page(&[first]) } else { None };

    println!("\nNext, load the extension in {first}:");
    match opened {
        Some(app) => println!("  1. In the {app} tab that just opened, turn on Developer mode (top right)."),
        None => println!("  1. Go to chrome://extensions and turn on Developer mode (top right)."),
    }
    println!("  2. Click Load unpacked.");
    if copied {
        println!("  3. Press ⌘⇧G, then ⌘V to paste the folder path (it's on your clipboard), and press Return:");
    } else {
        println!("  3. Press ⌘⇧G, paste this folder path and press Return:");
    }
    println!("       {ext}");
    println!("  4. Click Select.");
    if registered.len() > 1 {
        println!("\nRepeat these steps in {} (also at chrome://extensions).", registered[1..].join(", "));
    }
    if !starting {
        println!("\nThen start a session in your project:  cd ~/projects/my-app && harness-bridge .");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cellar_path_becomes_opt_link() {
        let p = Path::new("/opt/homebrew/Cellar/harness-bridge/0.1.0/libexec/bridge-host");
        assert_eq!(stable_path(p), PathBuf::from("/opt/homebrew/opt/harness-bridge/libexec/bridge-host"));
        let share = Path::new("/usr/local/Cellar/harness-bridge/0.2.0_1/share/harness-bridge/extension");
        assert_eq!(stable_path(share), PathBuf::from("/usr/local/opt/harness-bridge/share/harness-bridge/extension"));
    }

    #[test]
    fn other_paths_unchanged() {
        let p = Path::new("/Users/me/src/harness/app/target/release/bridge-host");
        assert_eq!(stable_path(p), p);
        let short = Path::new("/opt/homebrew/Cellar/harness-bridge");
        assert_eq!(stable_path(short), short);
        let checkout = Path::new("/Users/me/Cellar/projects/harness/app/target/debug/bridge-host");
        assert_eq!(stable_path(checkout), checkout);
    }

    fn yes(answers: &str, default: bool) -> bool {
        ask_yes(&mut answers.as_bytes(), &mut Vec::new(), "Go?", default)
    }

    #[test]
    fn ask_yes_answers() {
        assert!(yes("\n", true));
        assert!(!yes("\n", false));
        assert!(yes("Y\n", false));
        assert!(!yes("no\n", true));
        assert!(yes("maybe\nyes\n", false), "re-asks after an unclear answer");
        assert!(!yes("", true), "end of input means no");
    }

    const TWO: &[(&str, &str)] = &[("Google/Chrome", "Google Chrome"), ("BraveSoftware/Brave-Browser", "Brave Browser")];

    fn pick(answers: &str, found: &[(&'static str, &'static str)]) -> Vec<&'static str> {
        let none = Path::new("/nonexistent");
        choose(&mut answers.as_bytes(), &mut Vec::new(), found, none).into_iter().map(|(_, app)| app).collect()
    }

    #[test]
    fn choose_browsers() {
        assert_eq!(pick("\n", TWO), ["Google Chrome", "Brave Browser"], "Return picks all");
        assert_eq!(pick("all\n", TWO), ["Google Chrome", "Brave Browser"]);
        assert_eq!(pick("2\n", TWO), ["Brave Browser"]);
        assert_eq!(pick("2, 1 2\n", TWO), ["Google Chrome", "Brave Browser"], "sorted, no duplicates");
        assert_eq!(pick("3\n1\n", TWO), ["Google Chrome"], "re-asks when out of range");
        assert_eq!(pick("chrome\n2\n", TWO), ["Brave Browser"], "re-asks when not a number");
        assert!(pick("", TWO).is_empty(), "end of input picks nothing");
    }

    #[test]
    fn choose_single_browser_is_yes_no() {
        assert_eq!(pick("\n", &TWO[..1]), ["Google Chrome"]);
        assert!(pick("n\n", &TWO[..1]).is_empty());
    }

    #[test]
    fn manifest_allows_only_the_extension() {
        let v: serde_json::Value = serde_json::from_str(&manifest(Path::new("/x/bridge-host"))).unwrap();
        assert_eq!(v["name"], HOST_NAME);
        assert_eq!(v["path"], "/x/bridge-host");
        assert_eq!(v["allowed_origins"], json!(["chrome-extension://ckmjfebniegheoplafhgknkchhipjhmj/"]));
    }
}
