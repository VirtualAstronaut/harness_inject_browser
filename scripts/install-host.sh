#!/usr/bin/env bash
# For working on Harness Bridge from a source checkout. Users install with Homebrew instead.
# Builds the app, registers the browser connection and puts `harness-bridge` on PATH.
# Usage: scripts/install-host.sh [--release]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE=debug
CARGO_FLAGS=()
if [[ "${1:-}" == "--release" ]]; then PROFILE=release; CARGO_FLAGS=(--release); fi

echo "→ building ($PROFILE)…"
(cd "$ROOT/app" && cargo build ${CARGO_FLAGS[@]+"${CARGO_FLAGS[@]}"})

APP_BIN="$ROOT/app/target/$PROFILE/harness-bridge"

# Put `harness-bridge` on PATH as a symlink to the built app.
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

"$APP_BIN" setup
