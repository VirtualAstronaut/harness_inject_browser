//! macOS Seatbelt sandbox (`sandbox-exec`) for commands.
//!
//! The base and network rules are vendored from OpenAI Codex (Apache-2.0).
//! Commands may read everything, but write only inside their trusted folder(s),
//! temp dirs and package caches; protected paths such as `.git/hooks` stay
//! read-only. Network is off unless the command matches `network_allow` or the
//! user explicitly allowed it.

use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::policy::rule_matches;
use crate::trust::{canon, expand_tilde};

/// Only ever use the system binary (same choice as Codex).
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

const BASE_POLICY: &str = include_str!("seatbelt_base.sbpl");
const NETWORK_POLICY: &str = include_str!("seatbelt_network.sbpl");

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct SandboxConfig {
    /// Run commands inside sandbox-exec.
    pub enabled: bool,
    /// Command prefixes (like auto_allow rules) that get network access.
    pub network_allow: Vec<String>,
    /// Extra writable folders, mostly package-manager caches.
    pub extra_writable: Vec<String>,
    /// Paths (relative to each writable folder) that stay read-only.
    pub protected: Vec<String>,
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            network_allow: s(&[
                "npm install", "npm i", "npm ci", "npm update", "npm view", "npm outdated", "npx",
                "pnpm install", "pnpm i", "pnpm add", "pnpm update", "pnpm dlx",
                "yarn", "yarn install", "yarn add", "bun install", "bun add",
                "pip install", "pip3 install", "python3 -m pip install", "uv pip install", "uv sync", "uv add",
                "poetry install", "bundle install", "gem install",
                "cargo build", "cargo fetch", "cargo install", "cargo update", "cargo add", "cargo run", "cargo test",
                "go get", "go mod download", "go mod tidy", "go build", "go test",
                "brew install", "brew update", "brew upgrade", "brew info", "brew search",
                "git clone", "git fetch", "git pull", "git push", "git ls-remote", "git submodule",
                "curl", "wget", "ping", "dig", "nslookup", "host",
            ]),
            extra_writable: s(&[
                "~/.npm", "~/.cache", "~/Library/Caches", "~/.cargo/registry", "~/.cargo/git",
                "~/.pnpm-store", "~/Library/pnpm", "~/.yarn", "~/.bun/install/cache",
                "~/go/pkg/mod", "~/.gradle/caches", "~/.m2/repository",
            ]),
            protected: s(&[".git/hooks", ".git/config", ".harness-bridge"]),
        }
    }
}

pub struct Plan {
    /// Trusted roots first, then temp/cache folders.
    pub writable: Vec<PathBuf>,
    /// Absolute paths kept read-only (e.g. <project>/.git/hooks).
    pub protected: Vec<PathBuf>,
    pub network: bool,
}

impl Plan {
    pub fn label(&self) -> &'static str {
        if self.network {
            "workspace-write+network"
        } else {
            "workspace-write"
        }
    }
}

/// Temp + cache folders every process needs (TMPDIR, its sibling cache dir, /tmp).
pub fn system_writable() -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from("/private/tmp"), PathBuf::from("/private/var/tmp")];
    if let Ok(t) = std::env::var("TMPDIR") {
        let t = canon(Path::new(&t));
        if let Some(parent) = t.parent() {
            v.push(parent.join("C")); // DARWIN_USER_CACHE_DIR
        }
        v.push(t);
    }
    v
}

pub fn build_plan(roots: &[PathBuf], cfg: &SandboxConfig, home: &Path, network: bool) -> Plan {
    let mut writable: Vec<PathBuf> = vec![];
    for r in roots {
        let r = canon(r);
        if !writable.contains(&r) {
            writable.push(r);
        }
    }
    // Protect e.g. `.git/hooks` only when its parent exists, so `git init` / `git clone`
    // still work in a fresh folder (Codex makes the same choice for `.git`).
    let mut protected = vec![];
    for root in &writable {
        for prot in &cfg.protected {
            let p = root.join(prot);
            if p.parent().is_some_and(|parent| parent.exists()) {
                protected.push(p);
            }
        }
    }
    for extra in system_writable().into_iter().chain(cfg.extra_writable.iter().map(|p| canon(&expand_tilde(p, home)))) {
        if !writable.contains(&extra) {
            writable.push(extra);
        }
    }
    Plan { writable, protected, network }
}

/// Seatbelt profile text + the -D parameters it references.
/// Protected paths are excluded from *every* writable root, so e.g. a /tmp root
/// can't re-allow a project's `.git/hooks`.
pub fn profile(plan: &Plan) -> (String, Vec<(String, String)>) {
    let mut params = vec![];
    let mut p = String::from(BASE_POLICY);
    p.push_str(
        r#"
; ---- Harness Bridge additions ----
(allow file-read*)
(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))
(allow file-write-data (regex #"^/dev/(stdout|stderr|tty|fd/[0-9]+)$"))
"#,
    );
    let mut nots = String::new();
    for (k, prot) in plan.protected.iter().enumerate() {
        let pk = format!("PROTECTED_{k}");
        params.push((pk.clone(), prot.display().to_string()));
        nots.push_str(&format!(" (require-not (subpath (param \"{pk}\")))"));
    }
    let mut parts = vec![];
    for (i, root) in plan.writable.iter().enumerate() {
        let key = format!("WRITABLE_ROOT_{i}");
        params.push((key.clone(), root.display().to_string()));
        parts.push(format!("(require-all (subpath (param \"{key}\")){nots})"));
    }
    if !parts.is_empty() {
        p.push_str(&format!("(allow file-write*\n  {}\n)\n", parts.join("\n  ")));
    }
    if plan.network {
        p.push_str(NETWORK_POLICY);
        p.push_str("\n(allow network-outbound)\n(allow network-inbound)\n(allow system-socket)\n");
    }
    (p, params)
}

/// Does any part of the command start with a network-allowed prefix?
pub fn wants_network(cmd: &str, prefixes: &[String]) -> bool {
    let norm: String = cmd.chars().filter(|c| !matches!(c, '\'' | '"' | '\\')).collect();
    let chained = norm.replace("&&", ";").replace("||", ";");
    chained.split([';', '|', '&', '(', ')']).any(|seg| {
        let tokens: Vec<&str> = seg.split_whitespace().collect();
        !tokens.is_empty() && prefixes.iter().any(|p| rule_matches(p, &tokens))
    })
}

/// Heuristic: did a failure come from the sandbox (write or network denied)?
pub fn looks_blocked(exit: Option<i32>, stdout: &str, stderr: &str) -> bool {
    if exit.is_none_or(|c| c == 0) {
        return false;
    }
    let re = Regex::new(
        r"(?i)operation not permitted|read-only file system|could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|nodename nor servname|network is unreachable|failed to connect to|temporary failure in name resolution|\bEPERM\b",
    )
    .unwrap();
    re.is_match(stderr) || re.is_match(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_prefixes() {
        let p = SandboxConfig::default().network_allow;
        assert!(wants_network("npm install", &p));
        assert!(wants_network("cd app && npm ci", &p));
        assert!(wants_network("git pull --rebase", &p));
        assert!(!wants_network("npm test", &p));
        assert!(!wants_network("node evil.js", &p));
        assert!(!wants_network("git status", &p));
    }

    #[test]
    fn profile_has_roots_and_protection() {
        let plan = Plan {
            writable: vec![PathBuf::from("/w"), PathBuf::from("/tmp")],
            protected: vec![PathBuf::from("/w/.git/hooks")],
            network: false,
        };
        let (text, params) = profile(&plan);
        assert!(text.contains("(subpath (param \"WRITABLE_ROOT_0\"))"));
        // the protected path is excluded from *both* roots
        assert_eq!(text.matches("require-not (subpath (param \"PROTECTED_0\"))").count(), 2);
        assert!(!text.contains("network-outbound"));
        assert!(params.contains(&("PROTECTED_0".into(), "/w/.git/hooks".into())));
    }

    #[test]
    fn blocked_heuristic() {
        assert!(looks_blocked(Some(1), "", "zsh:1: operation not permitted: /x"));
        assert!(looks_blocked(Some(6), "", "curl: (6) Could not resolve host: a.com"));
        assert!(!looks_blocked(Some(0), "", "operation not permitted"));
        assert!(!looks_blocked(Some(1), "", "syntax error"));
    }
}
