#!/usr/bin/env bash
# Builds the Ghostkeys.app bundle: compiles the renderer/main process with electron-vite, then
# packages it with electron-builder, using packaging/electron-builder.icons.yml to supply the
# real AppIcon.icns, the tray images, and the ghostkeysd daemon binary as extraResources —
# without editing anything inside app/.
#
# Usage: packaging/build-app.sh
#
# Requires: pnpm installed, app/ dependencies already installed (pnpm --dir app install),
# and a built daemon binary (this script builds one via build-daemon.sh if missing).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/app"
PKG_DIR="$ROOT_DIR/packaging"
DAEMON_BIN="$PKG_DIR/build/ghostkeysd"
ICON="$ROOT_DIR/assets/icon/AppIcon.icns"

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "error: $APP_DIR/package.json not found" >&2
  exit 1
fi

if [[ ! -f "$ICON" ]]; then
  echo "error: $ICON not found — run this from a checkout that has assets/icon/AppIcon.icns" >&2
  exit 1
fi

if [[ ! -x "$DAEMON_BIN" ]]; then
  echo "==> No daemon binary at $DAEMON_BIN yet, building it first"
  "$PKG_DIR/build-daemon.sh"
fi

echo "==> electron-vite build"
(cd "$APP_DIR" && pnpm run build)

echo "==> electron-builder --mac --arm64 (icon + daemon binary overridden via packaging/electron-builder.icons.yml)"
(cd "$APP_DIR" && pnpm exec electron-builder --mac --dir --arm64 --config "$PKG_DIR/electron-builder.icons.yml")

echo "==> done: see $APP_DIR/release/"
