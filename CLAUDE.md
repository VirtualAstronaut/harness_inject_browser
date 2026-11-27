# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Harness Bridge: a macOS proof of concept that lets Gemini, ChatGPT and Claude web chats run shell commands and file edits on the local Mac. The model writes a `local-exec` JSON block. A Chrome MV3 extension detects it and relays it through a native messaging host to a Tauri menu-bar app. The app checks trust and policy, runs the command under `sandbox-exec`, and the result is pasted back into the chat. `README.md` covers user-facing behavior in detail (danger rules, sandbox scope, redaction, limits).

## Commands

```sh
# Rust app (both binaries): run from app/
cd app && cargo build
cd app && cargo test                         # policy, trust, sandbox, files, redact tests
cd app && cargo test policy::tests           # one module
cd app && cargo test <test_name_substring>   # one test
HARNESS_BRIDGE_AUTO_APPROVE=1 cargo run -- /path/to/project   # dev only: skips every prompt

# Extension tests (jsdom, no browser needed)
cd tests/extension && npm install && npm test
node tests/extension/sites.test.mjs          # just the per-site adapter tests
node tests/extension/flow.test.mjs           # just the full approval/result flow

# Build + register native host for Chrome-family browsers + symlink `harness-bridge` onto PATH
scripts/install-host.sh [--release]
```

`install-host.sh` reads the extension ID from `.dev/ext-id.txt` (git-ignored, derived from the `key` in `extension/manifest.json`; the ID is `ckmjfebniegheoplafhgknkchhipjhmj`). After extension changes, reload the unpacked extension in `chrome://extensions`.

## Architecture

```
chat tab ─ content.js ─ background.js ─ native messaging ─ bridge-host ─ Unix socket ─ harness-bridge (menu-bar app)
```

- **`extension/content.js`**: one script for all sites. The `SITES` table at the top holds per-site selectors (`input`, `send`, `stop`, `streaming`, `insert: paste|type`). Action blocks are found by scanning the whole page for code-like elements whose text parses as an action, not by walking reply containers. Blocks auto-run only in replies that arrive after the user presses Send. Older blocks get a "Run locally" button. The panel lives in a shadow root, and its buttons act only on `isTrusted` clicks, so a page script can't fake an approval.
- **`extension/background.js`**: checks `sender.origin` against `ALLOWED_ORIGINS`, serves `protocol.md`, and holds the `connectNative('com.harness.bridge')` port. **Adding a site takes three edits:** `SITES` in content.js, `ALLOWED_ORIGINS` in background.js, `matches` in manifest.json.
- **`app/src/bin/bridge-host.rs`**: started by the browser. It only translates native-messaging framing (length-prefixed) to newline-delimited JSON on `~/Library/Application Support/harness-bridge/bridge.sock` and relays `progress` messages back. It never executes anything.
- **`app/src/main.rs`**: the Tauri app (tray only, no windows; `app/dist/index.html` is a placeholder). Each socket connection carries one request line, a `Request` enum tagged by `type`: `ping`, `exec`, `file`, `stop`, `trust`, `allow_always`, `set_project`. The reply is a `Response`. `handle_exec` holds a global `gate` mutex (one approval/execution at a time) and goes in this order:
  1. **Trust** (`trust.rs`): the cwd plus every `cd`/`pushd` target must be trusted. A target it can't resolve, such as `cd $DIR`, needs approval. Returns `needs_trust` with `paths`.
  2. **Policy** (`policy.rs`): `Policy::decide` against `danger_rules`/`danger_paths` (regex, matched after removing quotes and backslashes, with optional `unless`), `auto_allow` and `always_allow`. Returns `needs_approval` unless the request has `approved: true`.
  3. **Sandbox** (`sandbox.rs` + `seatbelt_*.sbpl`, included with `include_str!`): writable roots are the trusted folders in use, plus temp folders and `extra_writable`. Network is enabled only for `network_allow` prefixes or a `network: true` retry. `looks_blocked` sets `sandbox_blocked`.
  4. **Run** `zsh -lc` in its own process group with a timeout, streaming `progress` chunks. The output is passed through `redact.rs` *before* it is clipped to 16k chars, then written to `audit.log`.
- **The approval round-trip is stateless.** The app returns `needs_trust`/`needs_approval`. The extension shows a card, and on a user click it re-sends the same request with `approved`, `trust_once`, `network` or `unsandboxed` set. `file` requests (`read_file`/`write_file`/`apply_patch`, logic in `files.rs`) work the same way: the first reply carries a `diff` for review, and the re-send with `approved` applies it. File tools run in the app process, outside the sandbox.
- **State** lives in `~/Library/Application Support/harness-bridge/`: `policy.json` (approval mode, rules, sandbox config, `redact`), `trusted.json`, `audit.log`, `bridge.sock`. `harness-bridge FOLDER` sets the project. If an instance is already running, it sends `set_project` over the socket and exits.

## Conventions

- `extension/protocol.md` is the model-facing instruction text that the extension bundles. `prompts/instructions.md` is a copy of it. Keep the two files identical when editing.
- When changing the wire protocol (request fields, statuses, result fields), update `main.rs`, `content.js`, `protocol.md`/`instructions.md`, and the fake `reply` functions in `tests/extension/*.test.mjs` together.
- When adding a danger rule, add cases to the dangerous/ordinary command lists in the `policy.rs` tests.
- `tests/extension/harness.mjs` loads `content.js` into jsdom with fake `chrome.*` APIs and dispatches trusted events through jsdom internals. Extend it rather than adding a real-browser test setup.
