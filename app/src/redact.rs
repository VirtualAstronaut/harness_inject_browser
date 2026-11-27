//! Secret masking: replaces API keys, tokens and private keys in command output
//! and file reads before anything is sent back to the chat site.

use std::sync::OnceLock;

use regex::{Captures, Regex};

struct Rule {
    kind: &'static str,
    re: Regex,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let r = |kind, pat: &str| Rule { kind, re: Regex::new(pat).unwrap() };
        vec![
            // Order matters: specific formats before generic ones.
            r("private-key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
            r("anthropic-key", r"sk-ant-[A-Za-z0-9_\-]{20,}"),
            r("openai-key", r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{20,}"),
            r("github-token", r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"),
            r("aws-access-key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
            r("google-api-key", r"\bAIza[0-9A-Za-z_\-]{35}"),
            r("slack-token", r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"),
            r("stripe-key", r"\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}"),
            r("jwt", r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
            r("url-password", r"(?i)\b[a-z][a-z0-9+.\-]*://[^\s:/@]+:[^\s@/]{6,}@"),
        ]
    })
}

/// `NAME = value` where NAME mentions a secret and value looks like one.
fn assignment_rule() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b([A-Za-z0-9_\-]*(?:password|passwd|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|client[_\-]?secret|auth[_\-]?key|credentials?)[A-Za-z0-9_\-]*)(["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-+/=]{12,})"#,
        )
        .unwrap()
    })
}

/// Looks random enough to be a secret rather than a word or identifier.
fn looks_secret(v: &str) -> bool {
    let digits = v.chars().any(|c| c.is_ascii_digit());
    let letters = v.chars().any(|c| c.is_ascii_alphabetic());
    digits && letters
}

/// Returns the masked text and how many secrets were replaced.
pub fn redact(text: &str) -> (String, usize) {
    let mut out = text.to_string();
    let mut count = 0;
    for rule in rules() {
        if !rule.re.is_match(&out) {
            continue;
        }
        out = rule
            .re
            .replace_all(&out, |c: &Captures| {
                count += 1;
                if rule.kind == "url-password" {
                    // keep scheme://user: and @, mask only the password
                    let m = &c[0];
                    let colon = m.rfind(':').unwrap_or(0);
                    format!("{}[REDACTED:password]@", &m[..=colon])
                } else {
                    format!("[REDACTED:{}]", rule.kind)
                }
            })
            .into_owned();
    }
    out = assignment_rule()
        .replace_all(&out, |c: &Captures| {
            if looks_secret(&c[3]) {
                count += 1;
                format!("{}{}[REDACTED:secret]", &c[1], &c[2])
            } else {
                c[0].to_string()
            }
        })
        .into_owned();
    (out, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(s: &str) -> String {
        redact(s).0
    }

    #[test]
    fn masks_known_formats() {
        let cases = [
            ("OPENAI_API_KEY=sk-proj-abcDEF1234567890ghijKLMNOP", "openai-key"),
            ("key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx-123", "anthropic-key"),
            ("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12", "github-token"),
            ("aws_access_key_id = AKIAIOSFODNN7EXAMPLE", "aws-access-key"),
            ("AIzaSyA1234567890abcdefghijklmnopqrstuv", "google-api-key"),
            ("SLACK=xoxb-1234567890-abcdefghij", "slack-token"),
            ("sk_live_51HxYzAbCdEfGhIjKlMn", "stripe-key"),
            ("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"),
        ];
        for (input, kind) in cases {
            let out = masked(input);
            assert!(out.contains(&format!("[REDACTED:{kind}]")), "{input} -> {out}");
        }
    }

    #[test]
    fn masks_private_keys_and_url_passwords() {
        let pem = "a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nz";
        assert_eq!(masked(pem), "a\n[REDACTED:private-key]\nz");
        assert_eq!(
            masked("DATABASE_URL=postgres://app:Sup3rS3cret!@db.example.com:5432/app"),
            "DATABASE_URL=postgres://app:[REDACTED:password]@db.example.com:5432/app"
        );
    }

    #[test]
    fn masks_secret_looking_assignments() {
        assert_eq!(masked("DB_PASSWORD=Sup3rS3cretPass9"), "DB_PASSWORD=[REDACTED:secret]");
        assert_eq!(masked(r#""client_secret": "a1b2c3d4e5f6g7h8""#), r#""client_secret": "[REDACTED:secret]""#);
        assert_eq!(redact("API_KEY=abc123def456ghi789\nTOKEN: zz9988776655xx").1, 2);
    }

    #[test]
    fn leaves_ordinary_code_alone() {
        for s in [
            "const token = getToken();",
            "password: ${DB_PASSWORD}",
            "let secret = config.secret;",
            "auth_token = request.headers.get('Authorization')",
            "PASSWORD_MIN_LENGTH=12",
            "sk-short",
            "Tokenizer tokenizes tokens",
            "git log --oneline -5",
        ] {
            assert_eq!(redact(s), (s.to_string(), 0), "should be unchanged: {s}");
        }
    }
}
