#!/usr/bin/env bash
# Builds the bridge and registers the Native Messaging host with Chrome-family browsers.
# Usage: scripts/install-host.sh [--release]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE=debug
CARGO_FLAGS=()
if [[ "${1:-}" == "--release" ]]; then PROFILE=release; CARGO_FLAGS=(--release); fi

echo "→ building ($PROFILE)…"
(cd "$ROOT/app" && cargo build ${CARGO_FLAGS[@]+"${CARGO_FLAGS[@]}"})

HOST_BIN="$ROOT/app/target/$PROFILE/bridge-host"
EXT_ID="$(cat "$ROOT/.dev/ext-id.txt" 2>/dev/null || true)"
if [[ -z "$EXT_ID" ]]; then
  echo "✕ .dev/ext-id.txt missing — it is derived from the key in extension/manifest.json" >&2
  exit 1
fi

MANIFEST=$(cat <<EOF
{
  "name": "com.harness.bridge",
  "description": "Harness Bridge native host",
  "path": "$HOST_BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

SUPPORT="$HOME/Library/Application Support"
installed=0
for dir in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" \
           "BraveSoftware/Brave-Browser" "Microsoft Edge" "Arc/User Data"; do
  if [[ -d "$SUPPORT/$dir" ]]; then
    mkdir -p "$SUPPORT/$dir/NativeMessagingHosts"
    echo "$MANIFEST" > "$SUPPORT/$dir/NativeMessagingHosts/com.harness.bridge.json"
    echo "✓ registered for $dir"
    installed=1
  fi
done
[[ $installed == 1 ]] || echo "✕ no Chrome-family browser profile found under $SUPPORT" >&2

# Put `harness-bridge` on PATH as a symlink to the built app.
APP_BIN="$ROOT/app/target/$PROFILE/harness-bridge"
LINK_DIR=""
for d in /opt/homebrew/bin /usr/local/bin; do
  if [[ -d "$d" && -w "$d" ]]; then LINK_DIR="$d"; break; fi
done
if [[ -z "$LINK_DIR" ]]; then
  LINK_DIR="$HOME/.local/bin"
  mkdir -p "$LINK_DIR"
fi
ln -sf "$APP_BIN" "$LINK_DIR/harness-bridge"
echo "✓ linked $LINK_DIR/harness-bridge -> $APP_BIN"
case ":$PATH:" in
  *":$LINK_DIR:"*) ;;
  *) echo "  ! $LINK_DIR is not on your PATH; add it to ~/.zshrc: export PATH=\"$LINK_DIR:\$PATH\"" ;;
esac

echo
echo "Extension ID : $EXT_ID"
echo "Host binary  : $HOST_BIN"
echo "Next: load $ROOT/extension as an unpacked extension, then start a session in your project:"
echo "      cd ~/projects/my-app && harness-bridge ."
