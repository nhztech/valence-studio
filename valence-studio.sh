#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# VALENCE STUDIO — one command, fully automatic (Termux friendly)
#
#   sh valence-studio.sh [port]
#
# 1. Installs REQUIRED packages automatically if missing (Node.js, via apt).
# 2. Checks the whole build toolchain — Java, Android SDK, cmake shims,
#    NDK, Gradle — and auto-downloads whatever is missing.
# 3. Serves the Studio + APK builder (default http://localhost:8080).
#
# Installed pieces are skipped instantly; nothing ever re-downloads.
# Global command after `sh install.sh`: `valence-studio`.
#
# Opt-outs:
#   VALENCE_SKIP_SETUP=1 sh valence-studio.sh   # skip the toolchain check
#   VALENCE_SKIP_NDK=1   sh valence-studio.sh   # skip the large NDK
#                                                # download (only C/C++
#                                                # projects ever need it)
#   sh valence-studio.sh --fast [port]          # same as SKIP_SETUP
# ─────────────────────────────────────────────────────────────────────────
DIR=$(cd "$(dirname "$0")" && pwd)
. "$DIR/tools/env.sh"

valence_require_node || exit 1
valence_warn_storage

for arg in "$@"; do
  case "$arg" in
    --fast|--no-setup) export VALENCE_SKIP_SETUP=1 ;;
    --skip-ndk) export VALENCE_SKIP_NDK=1 ;;
    [0-9]*) export VALENCE_PORT="$arg" ;;
  esac
done
[ "${VALENCE_SKIP_SETUP:-0}" = "1" ] || export VALENCE_SETUP=1
exec node "$DIR/server/local-builder.mjs"
