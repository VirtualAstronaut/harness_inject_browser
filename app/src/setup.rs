//! `harness-bridge setup`: registers the `bridge-host` native messaging host with
//! Chrome-family browsers, so the extension can reach the app.
//!
//! Homebrew cannot write into `~/Library`, so each user runs this once after install.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::json;

/// Fixed by the `key` field in `extension/manifest.json`.
pub const EXTENSION_ID: &str = "ckmjfebniegheoplafhgknkchhipjhmj";
pub const HOST_NAME: &str = "com.harness.bridge";

/// Browser profile folders under `~/Library/Application Support`.
const BROWSERS: &[&str] = &[
    "Google/Chrome",
    "Google/Chrome Beta",
    "Google/Chrome Canary",
    "Chromium",
    "BraveSoftware/Brave-Browser",
    "Microsoft Edge",
    "Arc/User Data",
];

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

pub fn run(home: &Path) -> i32 {
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
    let body = manifest(&host);
    let mut registered = 0;
    for dir in BROWSERS {
        let base = support.join(dir);
        if !base.is_dir() {
            continue;
        }
        let target = base.join("NativeMessagingHosts");
        let file = target.join(format!("{HOST_NAME}.json"));
        match fs::create_dir_all(&target).and_then(|_| fs::write(&file, &body)) {
            Ok(()) => {
                println!("✓ registered for {dir}");
                registered += 1;
            }
            Err(e) => eprintln!("✕ {dir}: {e}"),
        }
    }
    if registered == 0 {
        eprintln!("✕ no Chrome-family browser found under {}", support.display());
        return 1;
    }

    println!("\nHost program : {}", host.display());
    println!("Extension ID : {EXTENSION_ID}");
    // Homebrew: <prefix>/share/harness-bridge/extension. Source build: app/target/<profile>/ → repo root.
    let ext = find(&[bin.join("../share/harness-bridge/extension"), bin.join("../../../extension")], true);
    println!("\nNext:");
    match ext {
        Some(e) => println!(
            "  1. Open chrome://extensions, turn on Developer mode, click Load unpacked and choose:\n     {}",
            e.display()
        ),
        None => println!("  1. Open chrome://extensions, turn on Developer mode and load the extension/ folder."),
    }
    println!("  2. Start a session in your project:  cd ~/projects/my-app && harness-bridge .");
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

    #[test]
    fn manifest_allows_only_the_extension() {
        let v: serde_json::Value = serde_json::from_str(&manifest(Path::new("/x/bridge-host"))).unwrap();
        assert_eq!(v["name"], HOST_NAME);
        assert_eq!(v["path"], "/x/bridge-host");
        assert_eq!(v["allowed_origins"], json!(["chrome-extension://ckmjfebniegheoplafhgknkchhipjhmj/"]));
    }
}
