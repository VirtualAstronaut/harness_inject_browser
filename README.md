# Harness Bridge

Harness Bridge lets Gemini, ChatGPT and Claude run commands and edit files on your Mac. It works in their normal web apps.

It is a proof of concept. Read every command before you approve it. This was mostly a thought experiment, made with the help of Claude.

## How it works

1. The chat model writes an action as JSON in a code block.
2. A browser extension finds the block and sends it to a menu-bar app.
3. The app checks the action against your rules.
4. The app runs the action in a macOS sandbox.
5. The extension pastes the result into the chat.

```
chat window → extension → native host → menu-bar app
     ↑                                       │
     └──────────── result ───────────────────┘
```

## Set up

You need macOS, [Homebrew](https://brew.sh) and a Chrome-family browser (Chrome, Brave, Edge, Chromium or Arc).

1. Install with Homebrew:

   ```sh
   brew tap virtualastronaut/harness-bridge https://github.com/VirtualAstronaut/harness_inject_browser
   brew install harness-bridge
   ```

   Homebrew builds the app on your Mac, so the first install takes a few minutes. Because it is built locally, macOS does not show an "app is not verified" warning.
2. Connect your browsers to the app:

   ```sh
   harness-bridge setup
   ```

   It prints the extension folder to use in the next step.
3. Open `chrome://extensions`. Turn on **Developer mode**. Click **Load unpacked** and choose the folder that `setup` printed. It is `$(brew --prefix)/opt/harness-bridge/share/harness-bridge/extension`.
4. Start the app in your project folder:

   ```sh
   cd ~/projects/my-app
   harness-bridge .
   ```

   A `>_` icon appears in the menu bar. To stop, press Ctrl+C in the terminal.
5. Open a new chat in Gemini, ChatGPT or Claude. A green dot in the bottom-right panel means the app is connected.
6. Click **Add instructions** in the panel. Type your request below the instructions and press Send. Do this once per chat.

To keep the instructions in a Gemini Gem, a Custom GPT or a Claude Project, click **Copy instructions** and paste them there.

To update, run `brew upgrade harness-bridge`. You don't need to run `setup` or reload the extension again.

## Parts

| Part | Where | What it does |
|---|---|---|
| Menu-bar app | `app/src/main.rs` | Receives actions, checks them, runs them and logs them. |
| Policy | `app/src/policy.rs` | Approval modes and danger rules. |
| Trust | `app/src/trust.rs` | Trusted folders. |
| Sandbox | `app/src/sandbox.rs`, `app/src/seatbelt_*.sbpl` | Sandbox profile. Base rules come from OpenAI Codex (Apache-2.0). |
| File tools | `app/src/files.rs` | Read, write and patch files. |
| Native host | `app/src/bin/bridge-host.rs` | Passes messages between the browser and the app. It never runs commands. |
| Extension | `extension/` | Finds actions, shows the approval panel and sends results back. |
| Instructions | `extension/protocol.md`, copied to `prompts/instructions.md` | Tells the model how to write actions. |

## Use it

### When actions run

- Actions in a new reply run on their own.
- Actions already on the page, from history or a reload, get a **Run locally** button.
- With **auto-send** on, results are sent back to the model automatically. Turn it off to read results first.

### Project folder

`harness-bridge FOLDER` makes FOLDER the project:

- The folder becomes trusted, and stays trusted.
- Actions run there unless they name another folder.
- The panel and menu bar show its name.

If the app is already running, `harness-bridge OTHER_FOLDER` switches it to that folder.

`harness-bridge` with no folder starts without a project. Actions then start in your home folder.

### Trusted folders

The first time an action uses a folder, the panel asks you to **Trust folder**, **Allow once** or **Deny**.

- Trusting a folder also trusts its subfolders.
- The app checks every folder a command moves into with `cd` or `pushd`.
- If it cannot tell the folder in advance, such as `cd $DIR`, it asks you.
- Danger rules still apply in trusted folders.

You can open the list, `trusted.json`, from the menu bar.

### Approval modes

Choose a mode in the menu bar.

| Mode | What runs without asking |
|---|---|
| **Auto** (default) | Everything except dangerous commands |
| **Allowlist** | Only read-only commands in `auto_allow` |
| **Allowlist + native dialog** | Same as Allowlist, but asks in a macOS dialog |

Auto mode asks before commands that:

- delete files (`rm -rf`, `find -delete`, `dd`, disk erase)
- use `sudo`
- change git history or remotes (`push`, `reset --hard`, `clean -f`, `branch -D`, `restore`, `rebase`)
- run downloaded or hidden code (`curl | sh`, `eval`, base64 into a shell)
- send data out (`curl -d`, `scp`, `ssh`, `nc`)
- touch secrets (tokens, keys, keychain, credential files, browser data)
- change the system (`launchctl`, `crontab`, `osascript`, `chmod -R`, `~/.zshrc`, `/etc`)
- publish packages, change cloud resources or install globally
- hide what they do, such as `r''m` or `$X -rf`

**Always allow** on an approval card saves the rule:

- In Auto mode, it saves the exact command.
- In Allowlist mode, it saves a short prefix, such as `npm test`.

Settings are saved in `~/Library/Application Support/harness-bridge/policy.json`. The rules are regular expressions in `danger_rules` and `danger_paths`.

### Sandbox

Commands run in a macOS sandbox unless you turn it off in the menu bar. A sandboxed command:

- can read any file you can read
- can write only in trusted folders it uses, temp folders and package caches
- can use the network only for package installs, `git` and `curl`

Git hooks and `.git/config` stay read-only.

If the sandbox seems to block a command, the panel offers **Keep result**, **Retry with network** or **Retry without sandbox**.

### File edits

The model can also read, write and patch files.

- Writes must go to a trusted folder.
- Each write shows a diff with **Deny**, **Apply** and **Apply & auto-accept edits**.
- Edits in `.git` and to sensitive files always ask.

### Output

- Secrets in output, such as API keys, tokens and passwords, show as `[REDACTED:kind]`. To turn this off, set `"redact": false` in `policy.json`.
- Output is cut to 16,000 characters each for stdout and stderr.
- Commands time out after 60 seconds by default. The maximum is 600.
- Commands longer than 2,000 characters are refused.
- **Stop** in the panel ends a running command.
- If an approval waits while the chat tab is in the background, you get a macOS notification.

## Develop

To run from a source checkout instead of Homebrew, run `scripts/install-host.sh`. It builds the app, puts `harness-bridge` on your PATH and runs `setup`. Load the repo's `extension/` folder in Chrome.

Run the Rust tests:

```sh
cd app && cargo test
```

Run the extension tests:

```sh
cd tests/extension && npm install && npm test
```

To skip all prompts while developing, run `HARNESS_BRIDGE_AUTO_APPROVE=1 cargo run`. The menu bar shows a warning while it is on.

### Release a new version

1. Change `version` in `app/Cargo.toml` and commit.
2. Tag and push:

   ```sh
   git tag v0.2.0
   git push origin main v0.2.0
   ```

GitHub Actions then points `Formula/harness-bridge.rb` at the new tag, commits it to `main`, and test-installs it from source on macOS. The tag must match the version in `Cargo.toml`, or the release stops.

### Fix a site that stopped working

Chat sites change their pages. If a block shows no **Run locally** button, check the grey **Seen on page** line in the panel. It shows what the extension found.

Each site's selectors are in the `SITES` table at the top of `extension/content.js`:

| Field | Meaning |
|---|---|
| `response` | One model reply (for information only) |
| `userQuery` | One user message |
| `input` | The chat box |
| `send`, `stop` | The Send and Stop buttons |
| `streaming` | Shows the reply is still being written |
| `insert` | `paste` for Gemini, `type` for ChatGPT and Claude |

### Add a site

1. Add an entry to `SITES` in `extension/content.js`.
2. Add its origin to `ALLOWED_ORIGINS` in `extension/background.js`.
3. Add its URL to `matches` in `extension/manifest.json`.

## Limits

- The sandbox limits writes and network, not reads.
- File tools and unsandboxed retries run outside the sandbox. Only trust and your approval protect them.
- Any program running as you can connect to the app.
- Text the model reads can trick it (prompt injection). Read each command before you click **Run**.
