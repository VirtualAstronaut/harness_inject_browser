//! Chrome Native Messaging host for Harness Bridge.
//!
//! Chrome starts this process when the extension calls `connectNative`.
//! It relays each framed message (u32 length + JSON on stdin) to the running
//! menu-bar app over its Unix socket, and frames the reply back on stdout.
//! It never runs commands itself.

use std::{
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

use serde_json::{json, Value};

/// Chrome's limit for host -> browser messages is 1 MB.
const MAX_REPLY: usize = 1024 * 1024;

fn socket_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    PathBuf::from(home).join("Library/Application Support/harness-bridge/bridge.sock")
}

fn read_message(stdin: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match stdin.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_ne_bytes(len) as usize;
    let mut buf = vec![0u8; len];
    stdin.read_exact(&mut buf)?;
    Ok(Some(buf))
}

fn write_message(out: &Mutex<io::Stdout>, v: &Value) {
    let mut bytes = v.to_string().into_bytes();
    if bytes.len() > MAX_REPLY {
        bytes = json!({
            "type": "result", "id": v.get("id"), "status": "error",
            "error": "reply exceeded 1 MB native messaging limit",
        })
        .to_string()
        .into_bytes();
    }
    let mut out = out.lock().unwrap();
    let _ = out.write_all(&(bytes.len() as u32).to_ne_bytes());
    let _ = out.write_all(&bytes);
    let _ = out.flush();
}

/// Sends the request and forwards every `progress` line; returns the final reply.
fn relay(msg: &Value, on_progress: &dyn Fn(&Value)) -> Result<Value, String> {
    let mut conn = UnixStream::connect(socket_path())
        .map_err(|_| "Harness Bridge app is not running (start the menu-bar app)".to_string())?;
    conn.write_all(msg.to_string().as_bytes()).map_err(|e| e.to_string())?;
    conn.write_all(b"\n").map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(conn);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("app closed the connection without a result".into());
        }
        let v: Value = serde_json::from_str(&line).map_err(|e| format!("bad reply from app: {e}"))?;
        if v["type"] == "progress" {
            on_progress(&v);
        } else {
            return Ok(v);
        }
    }
}

fn main() {
    // argv[1] is the caller origin, e.g. chrome-extension://<id>/
    let origin = std::env::args().nth(1).unwrap_or_default();
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let mut stdin = io::stdin().lock();

    loop {
        let raw = match read_message(&mut stdin) {
            Ok(Some(raw)) => raw,
            _ => break, // Chrome closed the port
        };
        let stdout = stdout.clone();
        let origin = origin.clone();
        thread::spawn(move || {
            let msg: Value = match serde_json::from_slice(&raw) {
                Ok(v) => v,
                Err(e) => {
                    write_message(&stdout, &json!({"type": "result", "status": "error", "error": format!("bad json: {e}")}));
                    return;
                }
            };
            let reply = relay(&msg, &|p| write_message(&stdout, p)).unwrap_or_else(|err| {
                json!({
                    "type": if msg["type"] == "ping" { "pong" } else { "result" },
                    "id": msg.get("id"),
                    "status": "error",
                    "error": err,
                    "origin": origin,
                })
            });
            write_message(&stdout, &reply);
        });
    }
}
