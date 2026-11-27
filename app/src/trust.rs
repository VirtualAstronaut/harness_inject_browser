//! Folder trust: commands may only work in folders the user has trusted
//! (like Claude Code's "Do you trust the files in this folder?").
//! Trusting a folder also trusts everything below it.

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default)]
pub struct TrustStore {
    pub dirs: Vec<String>,
}

impl TrustStore {
    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        fs::write(path, serde_json::to_string_pretty(self)?)
    }

    pub fn is_trusted(&self, dir: &Path) -> bool {
        let d = canon(dir);
        self.dirs.iter().any(|t| d.starts_with(Path::new(t)))
    }

    /// The trusted folder that covers `dir` (the sandbox's writable root).
    pub fn root_for(&self, dir: &Path) -> Option<PathBuf> {
        let d = canon(dir);
        self.dirs
            .iter()
            .map(PathBuf::from)
            .filter(|t| d.starts_with(t))
            .max_by_key(|t| t.components().count())
    }

    /// Adds a folder; returns its canonical form.
    pub fn add(&mut self, dir: &Path) -> Result<PathBuf, String> {
        if !dir.is_dir() {
            return Err(format!("not a directory: {}", dir.display()));
        }
        let c = canon(dir);
        let s = c.to_string_lossy().to_string();
        if !self.dirs.contains(&s) {
            self.dirs.push(s);
        }
        Ok(c)
    }
}

/// Canonical path (symlinks resolved, /tmp -> /private/tmp); falls back to a
/// lexical clean-up for paths that don't exist yet.
/// Folders too broad to trust casually: the disk root, the home folder or anything
/// above it (such as /Users), and the top of a drive (/Volumes/NAME).
pub fn is_broad(dir: &Path, home: &Path) -> bool {
    let d = canon(dir);
    let h = canon(home);
    d == Path::new("/") || h.starts_with(&d) || d.parent() == Some(Path::new("/Volumes"))
}

pub fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| lexical(p))
}

fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub fn expand_tilde(arg: &str, home: &Path) -> PathBuf {
    if arg == "~" {
        home.to_path_buf()
    } else if let Some(rest) = arg.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(arg)
    }
}

/// Where an action runs: no cwd -> the project folder (or home); `~` paths expand;
/// relative paths are inside the project folder (or home).
pub fn resolve_dir(raw: Option<&str>, project: Option<&Path>, home: &Path) -> PathBuf {
    let base = project.unwrap_or(home);
    match raw.map(str::trim) {
        None | Some("") | Some(".") => base.to_path_buf(),
        Some(r) if r == "~" || r.starts_with("~/") => expand_tilde(r, home),
        Some(r) if r.starts_with('/') => PathBuf::from(r),
        Some(r) => base.join(r),
    }
}

/// Every folder the command will work in: its cwd plus each `cd`/`pushd` target.
/// Err when a target can't be known before running (variables, `cd -`, …).
pub fn workdirs(cmd: &str, cwd: &Path, home: &Path) -> Result<Vec<PathBuf>, String> {
    let re = Regex::new(
        r#"(?:^|[;&|({]\s*)(?:builtin\s+)?(?:cd|pushd)(?:\s+(?:-[LPe]+\s+)*(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+)))?"#,
    )
    .unwrap();
    let mut cur = canon(cwd);
    let mut out = vec![cur.clone()];
    for cap in re.captures_iter(cmd) {
        let arg = cap
            .get(1)
            .or(cap.get(2))
            .or(cap.get(3))
            .map(|m| m.as_str())
            .unwrap_or("~");
        if arg == "-" || arg.contains(['$', '`', '*', '?', '[', '{']) {
            return Err(format!("changes to a folder that can't be known in advance (cd {arg})"));
        }
        let p = expand_tilde(arg, home);
        cur = canon(&if p.is_absolute() { p } else { cur.join(p) });
        if !out.contains(&cur) {
            out.push(cur.clone());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(cmd: &str) -> Vec<String> {
        workdirs(cmd, Path::new("/work/proj"), Path::new("/home/me"))
            .unwrap()
            .into_iter()
            .map(|p| p.display().to_string())
            .collect()
    }

    #[test]
    fn broad_folders() {
        let home = Path::new("/Users/me");
        for d in ["/", "/Users", "/Users/me", "/Volumes/OneTeabee"] {
            assert!(is_broad(Path::new(d), home), "{d} is broad");
        }
        for d in ["/Users/me/projects/app", "/Users/me/projects", "/Volumes/OneTeabee/Workspace", "/tmp/x"] {
            assert!(!is_broad(Path::new(d), home), "{d} is a normal project folder");
        }
    }

    #[test]
    fn finds_cd_targets() {
        assert_eq!(dirs("ls"), ["/work/proj"]);
        assert_eq!(dirs("cd src && ls"), ["/work/proj", "/work/proj/src"]);
        assert_eq!(dirs("cd ~/other && rm x"), ["/work/proj", "/home/me/other"]);
        assert_eq!(dirs("cd .. ; ls"), ["/work/proj", "/work"]);
        assert_eq!(dirs("cd"), ["/work/proj", "/home/me"]);
        assert_eq!(dirs("cd \"/My Folder\" && ls"), ["/work/proj", "/My Folder"]);
        assert_eq!(dirs("ls | (cd /nonexistent-x && cat x)"), ["/work/proj", "/nonexistent-x"]);
        assert_eq!(dirs("pushd /tmp/x"), ["/work/proj", "/tmp/x"]);
        assert_eq!(dirs("echo abcd /x"), ["/work/proj"]); // "cd" inside a word is not a cd
    }

    #[test]
    fn dynamic_targets_are_errors() {
        for c in ["cd $DIR", "cd -", "cd `pwd`/..", "cd ~/pro*"] {
            assert!(workdirs(c, Path::new("/w"), Path::new("/h")).is_err(), "{c}");
        }
    }

    #[test]
    fn cwd_defaults_to_project() {
        let (proj, home) = (Path::new("/p/app"), Path::new("/h"));
        let r = |raw: Option<&str>, p: Option<&Path>| resolve_dir(raw, p, home).display().to_string();
        assert_eq!(r(None, Some(proj)), "/p/app");
        assert_eq!(r(Some(""), Some(proj)), "/p/app");
        assert_eq!(r(Some("."), Some(proj)), "/p/app");
        assert_eq!(r(Some("src"), Some(proj)), "/p/app/src");
        assert_eq!(r(Some("/abs/dir"), Some(proj)), "/abs/dir");
        assert_eq!(r(Some("~/x"), Some(proj)), "/h/x");
        assert_eq!(r(None, None), "/h");
        assert_eq!(r(Some("src"), None), "/h/src");
    }

    #[test]
    fn subfolders_inherit_trust() {
        let t = TrustStore { dirs: vec!["/work/proj".into()] };
        assert!(t.is_trusted(Path::new("/work/proj")));
        assert!(t.is_trusted(Path::new("/work/proj/src/deep")));
        assert!(!t.is_trusted(Path::new("/work/project2"))); // prefix but different folder
        assert!(!t.is_trusted(Path::new("/work")));
        assert!(!t.is_trusted(Path::new("/work/proj/../other")));
    }
}
