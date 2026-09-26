#!/usr/bin/env bash
# Builds ghostkeysd (the Swift daemon) in release mode and drops the binary at
# packaging/build/ghostkeysd, where build-app.sh picks it up as an Electron extraResource.
#
# This script never writes into daemon/ or app/ — only into packaging/build/ — so it is safe
# to run against a daemon/ checkout that other tooling also owns.
#
# Usage: packaging/build-daemon.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$ROOT_DIR/daemon"
OUT_DIR="$ROOT_DIR/packaging/build"
BIN_NAME="ghostkeysd"

if [[ ! -f "$DAEMON_DIR/Package.swift" ]]; then
  echo "error: $DAEMON_DIR/Package.swift not found" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "==> Building $BIN_NAME (release)"

# Prefer a universal (arm64 + x86_64) binary. This needs the x86_64 half of the macOS SDK
# installed (it usually is, via Xcode or the Command Line Tools); if it isn't, swift build
# fails fast and we fall back to a single-arch release build for the host machine.
UNIVERSAL_LOG="$(mktemp -t ghostkeys-build-daemon)"
if (cd "$DAEMON_DIR" && swift build -c release --arch arm64 --arch x86_64 --product "$BIN_NAME") \
    > "$UNIVERSAL_LOG" 2>&1; then
  BUILT_BIN="$(cd "$DAEMON_DIR" && swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/$BIN_NAME"
  echo "==> Universal (arm64 + x86_64) build succeeded"
else
  echo "warning: universal build failed, falling back to a host-architecture-only release build" >&2
  echo "         (see $UNIVERSAL_LOG for the original error — usually a missing x86_64 SDK slice)" >&2
  (cd "$DAEMON_DIR" && swift build -c release --product "$BIN_NAME")
  BUILT_BIN="$(cd "$DAEMON_DIR" && swift build -c release --show-bin-path)/$BIN_NAME"
fi

if [[ ! -f "$BUILT_BIN" ]]; then
  echo "error: expected binary not found at $BUILT_BIN" >&2
  exit 1
fi

file "$BUILT_BIN"
cp "$BUILT_BIN" "$OUT_DIR/$BIN_NAME"
chmod +x "$OUT_DIR/$BIN_NAME"
echo "==> $OUT_DIR/$BIN_NAME"
