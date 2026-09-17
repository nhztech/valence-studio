#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# VALENCE CLI — the framework itself, flag-driven.
#
# The Web Studio is only a convenience layer on top of this same engine;
# everything it does can be done here without a browser.
#
#   sh valence-cli.sh                                  interactive menu
#   sh valence-cli.sh init . --name App --id com.example.app
#   sh valence-cli.sh validate .
#   sh valence-cli.sh doctor .
#   sh valence-cli.sh dev . --port 4173                live preview
#   sh valence-cli.sh pack . --out app.cart
#   sh valence-cli.sh unpack app.cart --out project
#   sh valence-cli.sh build . --target apk|aab|android [--out path]
#   sh valence-cli.sh apk [project] [output.apk]
#   sh valence-cli.sh --help
#
# Auto-installs missing requirements (Node.js, via apt) and checks the
# whole toolchain (Java, SDK, cmake shims, NDK, Gradle) first.
# Global command after `sh install.sh`: `valence`.
# Opt-outs: VALENCE_SKIP_SETUP=1, VALENCE_SKIP_NDK=1
# ─────────────────────────────────────────────────────────────────────────
DIR=$(cd "$(dirname "$0")" && pwd)
. "$DIR/tools/env.sh"

valence_require_node || exit 1

if [ "${VALENCE_SKIP_SETUP:-0}" != "1" ]; then
  VALENCE_TOOLCHAIN_ONLY=1 node "$DIR/server/local-builder.mjs" || {
    echo "[valence] toolchain check reported problems — continuing anyway" >&2
  }
fi
exec node "$DIR/backend/valence-framework/cli/valence.mjs" "$@"
