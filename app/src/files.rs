//! File tools: read_file, write_file, apply_patch (exact find-and-replace edits).
//! Writes produce a unified diff the user can review before they're applied.

use serde::Deserialize;

/// Max characters returned by read_file in one call.
pub const MAX_READ_CHARS: usize = 30_000;
/// Files larger than this are not read or edited.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Deserialize)]
pub struct FileRequest {
    pub id: String,
    /// read | write | patch
    pub op: String,
    pub path: String,
    pub cwd: Option<String>,
    pub content: Option<String>,
    pub edits: Option<Vec<Edit>>,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
    pub source: Option<String>,
    #[serde(default)]
    pub approved: bool,
    #[serde(default)]
    pub trust_once: bool,
}

#[derive(Deserialize)]
pub struct Edit {
    pub old: String,
    pub new: String,
}

/// Apply edits in order; each `old` must match exactly once.
pub fn apply_edits(text: &str, edits: &[Edit]) -> Result<String, String> {
    if edits.is_empty() {
        return Err("apply_patch needs at least one edit".into());
    }
    let mut out = text.to_string();
    for (i, e) in edits.iter().enumerate() {
        let n = i + 1;
        if e.old.is_empty() {
            return Err(format!("edit {n}: \"old\" is empty (use write_file to create files)"));
        }
        match out.matches(&e.old).count() {
            0 => {
                return Err(format!(
                    "edit {n}: old text not found. Copy it exactly from read_file output (same indentation and line breaks)."
                ))
            }
            1 => out = out.replacen(&e.old, &e.new, 1),
            k => return Err(format!("edit {n}: old text appears {k} times; include more surrounding lines so it is unique")),
        }
    }
    Ok(out)
}

pub fn unified_diff(path: &str, old: &str, new: &str) -> String {
    similar::TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string()
}

/// (+added, -removed) line counts.
pub fn diff_stats(old: &str, new: &str) -> (usize, usize) {
    use similar::ChangeTag;
    let d = similar::TextDiff::from_lines(old, new);
    let mut add = 0;
    let mut del = 0;
    for c in d.iter_all_changes() {
        match c.tag() {
            ChangeTag::Insert => add += 1,
            ChangeTag::Delete => del += 1,
            ChangeTag::Equal => {}
        }
    }
    (add, del)
}

/// Slice 1-based inclusive lines; returns (text, total_lines, note).
pub fn read_range(text: &str, start: Option<usize>, end: Option<usize>) -> (String, usize, Option<String>) {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let total = lines.len();
    let s = start.unwrap_or(1).max(1);
    let e = end.unwrap_or(total).min(total);
    if s > e {
        return (String::new(), total, Some(format!("empty range; file has {total} lines")));
    }
    let mut out = String::new();
    let mut last = s - 1;
    for line in &lines[s - 1..e] {
        if out.len() + line.len() > MAX_READ_CHARS {
            break;
        }
        out.push_str(line);
        last += 1;
    }
    let note = (last < e || s > 1 || e < total)
        .then(|| format!("showing lines {s}-{last} of {total}; use start_line/end_line for more"));
    (out, total, note)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed(old: &str, new: &str) -> Edit {
        Edit { old: old.into(), new: new.into() }
    }

    #[test]
    fn edits_apply_in_order() {
        let t = "a = 1\nb = 2\n";
        assert_eq!(apply_edits(t, &[ed("a = 1", "a = 10"), ed("b = 2", "b = 20")]).unwrap(), "a = 10\nb = 20\n");
    }

    #[test]
    fn edit_errors_are_helpful() {
        assert!(apply_edits("x\nx\n", &[ed("x", "y")]).unwrap_err().contains("2 times"));
        assert!(apply_edits("abc", &[ed("zzz", "y")]).unwrap_err().contains("not found"));
        assert!(apply_edits("abc", &[]).is_err());
    }

    #[test]
    fn diff_and_ranges() {
        let d = unified_diff("f.txt", "a\nb\n", "a\nc\n");
        assert!(d.contains("-b") && d.contains("+c") && d.contains("b/f.txt"));
        assert_eq!(diff_stats("a\nb\n", "a\nc\nd\n"), (2, 1));
        let (t, total, note) = read_range("1\n2\n3\n4\n", Some(2), Some(3));
        assert_eq!((t.as_str(), total), ("2\n3\n", 4));
        assert!(note.unwrap().contains("2-3 of 4"));
        assert!(read_range("1\n2\n", None, None).2.is_none());
    }
}
