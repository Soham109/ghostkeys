#!/usr/bin/env bash
# Packages a built Ghostkeys.app into a distributable, drag-to-install DMG using the
# background art at assets/dmg/background.png (+@2x). Uses only macOS built-ins (hdiutil,
# osascript driving Finder) — no create-dmg or other third-party tool required.
#
# Usage: packaging/make-dmg.sh [path/to/Ghostkeys.app]
#   If the app path is omitted, this looks for it under app/release/ (build-app.sh's output).
#
# Does not touch app/ or daemon/: it only reads the already-built .app and writes the DMG to
# packaging/build/.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$ROOT_DIR/packaging"
ASSETS_DIR="$ROOT_DIR/assets"
OUT_DIR="$PKG_DIR/build"

VOL_NAME="Ghostkeys"
DMG_NAME="Ghostkeys.dmg"
APP_NAME="Ghostkeys.app"

# Window geometry — must match assets/dmg/background.svg's icon-slot layout (180,170) / (480,170)
# in a 660x400 canvas, offset by the title bar height Finder adds on top.
WINDOW_X=100
WINDOW_Y=100
WINDOW_W=660
WINDOW_H=400
TITLEBAR_H=28
ICON_SIZE=128
APP_ICON_X=180
APP_ICON_Y=170
APPS_ICON_X=480
APPS_ICON_Y=170

APP_PATH="${1:-}"
if [[ -z "$APP_PATH" ]]; then
  APP_PATH="$(find "$ROOT_DIR/app/release" -maxdepth 2 -name "$APP_NAME" -print -quit 2>/dev/null || true)"
fi
if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "error: could not find $APP_NAME — pass its path explicitly, or run packaging/build-app.sh first" >&2
  echo "  usage: packaging/make-dmg.sh path/to/$APP_NAME" >&2
  exit 1
fi
if [[ ! -f "$ASSETS_DIR/dmg/background.png" ]]; then
  echo "error: $ASSETS_DIR/dmg/background.png not found" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAGING_DIR="$(mktemp -d -t ghostkeys-dmg)"
trap 'rm -rf "$STAGING_DIR"' EXIT

echo "==> Staging $APP_PATH"
ditto "$APP_PATH" "$STAGING_DIR/$APP_NAME"
ln -s /Applications "$STAGING_DIR/Applications"
mkdir -p "$STAGING_DIR/.background"
cp "$ASSETS_DIR/dmg/background.png" "$STAGING_DIR/.background/background.png"
cp "$ASSETS_DIR/dmg/background@2x.png" "$STAGING_DIR/.background/background@2x.png"

RW_DMG="$OUT_DIR/.$VOL_NAME-rw.dmg"
rm -f "$RW_DMG"
echo "==> Creating a temporary read-write DMG"
hdiutil create -volname "$VOL_NAME" -srcfolder "$STAGING_DIR" -ov -format UDRW "$RW_DMG" -fs HFS+ -size 300m

echo "==> Mounting it to lay out icons"
MOUNT_DIR="/Volumes/$VOL_NAME"
if [[ -d "$MOUNT_DIR" ]]; then
  hdiutil detach "$MOUNT_DIR" -quiet -force || true
fi
hdiutil attach "$RW_DMG" -readwrite -noverify -noautoopen

# Give the Finder a moment to register the newly mounted volume before scripting it.
for _ in $(seq 1 20); do
  [[ -d "$MOUNT_DIR" ]] && break
  sleep 0.5
done

osascript <<OSA
tell application "Finder"
  tell disk "$VOL_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {$WINDOW_X, $WINDOW_Y, $((WINDOW_X + WINDOW_W)), $((WINDOW_Y + WINDOW_H + TITLEBAR_H))}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to $ICON_SIZE
    set background picture of viewOptions to file ".background:background.png"
    set position of item "$APP_NAME" of container window to {$APP_ICON_X, $APP_ICON_Y}
    set position of item "Applications" of container window to {$APPS_ICON_X, $APPS_ICON_Y}
    close
    open
    update without registering applications
    delay 1
  end tell
end tell
OSA

sync
hdiutil detach "$MOUNT_DIR" -quiet
sleep 1

echo "==> Compressing to the final DMG"
FINAL_DMG="$OUT_DIR/$DMG_NAME"
rm -f "$FINAL_DMG"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$FINAL_DMG"
rm -f "$RW_DMG"

echo "==> $FINAL_DMG"
