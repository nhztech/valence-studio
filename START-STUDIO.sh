#!/bin/sh
# VALENCE STUDIO — start website + APK builder on localhost (Termux friendly)
# usage: sh START-STUDIO.sh [port]
DIR=$(cd "$(dirname "$0")" && pwd)
command -v node >/dev/null 2>&1 || { echo "Node.js is required: pkg install nodejs"; exit 1; }
[ -n "$1" ] && export VALENCE_PORT="$1"
exec node "$DIR/server/local-builder.mjs"
