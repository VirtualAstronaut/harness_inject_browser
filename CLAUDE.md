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

# Source checkout: build, symlink `harness-bridge` onto PATH, then run `harness-bridge setup`
scripts/install-host.sh [--release]

# Lint the Homebrew formula
brew style Formula/harness-bridge.rb
```

After extension changes, reload the unpacked extension in `chrome://extensions`.

## Distribution (Homebrew)

- Users install with `brew tap virtualastronaut/harness-bridge https://github.com/VirtualAstronaut/harness_inject_browser`, `brew trust --formula virtualastronaut/harness-bridge/harness-bridge`, then `brew install harness-bridge`. Current Homebrew refuses formulae from untrusted third-party taps, so keep the `brew trust` step in docs and in the release workflow. The formula builds from source on purpose. Locally built programs aren't quarantined, so no Apple Developer ID or notarisation is needed. Don't switch to a cask or prebuilt binaries.
- The formula moves `bridge-host` to `libexec/` and installs `extension/` and `prompts/` to `pkgshare`.
- `harness-bridge setup` asks before changing anything when stdin and stdout are a terminal: which detected browsers to connect, then whether to open the extensions page (`open -a <app> chrome://extensions`) and copy the extension path with `pbcopy`. Without a terminal (`brew test`, CI) it connects every detected browser and opens nothing; keep that path prompt-free. On the first app start with no browser connected, `first_run_setup` in `main.rs` offers to run setup once per user, whatever the answer or outcome; `setup-offered` in the support folder records it. Prompt helpers take `BufRead`/`Write` so tests can feed them answers.
- Browser quirk: Brave 1.100 on macOS reads native host manifests only from Google Chrome's folder (found with `sudo fs_usage -w -f pathname <brave pid>`), so `manifest_dirs` writes Brave's manifest to both its own and Chrome's folder. A browser counts as installed only if its profile folder has `Local State`. `setup::repair` runs at app start and copies a browser's own manifest to any missing extra folders, which fixes connections made by older versions. To debug "Specified native messaging host not found", start the browser with `--enable-logging=stderr --v=0` and look for `Can't find manifest`.
- `harness-bridge setup` (`app/src/setup.rs`) writes the native host manifests into each browser's `~/Library/Application Support/<browser>/NativeMessagingHosts/`. Homebrew can't write there, so users run it once. It finds `bridge-host` at `../libexec/` (Homebrew) or as a sibling (source build). `stable_path` rewrites `Cellar/<name>/<version>/` to `opt/<name>/`, so the manifests survive `brew upgrade`. The extension ID is hardcoded as `EXTENSION_ID`; it's fixed by the `key` in `extension/manifest.json`.
- Releases: bump `version` in `app/Cargo.toml`, then push a matching `v*` tag. `.github/workflows/release.yml` rewrites `url`/`sha256` in the formula, commits to `main`, then runs `brew install --build-from-source` and `brew test` on macOS. Don't hand-edit `url`/`sha256`. Starting the workflow by hand (`workflow_dispatch`) skips the formula update and only test-installs what's on `main`.

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
