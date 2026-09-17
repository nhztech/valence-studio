#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# VALENCE STUDIO installer — one-shot, fully automatic.
#
#   sh install.sh                 toolchain + global commands
#   sh install.sh --skip-setup    only install the commands (no downloads)
#   sh install.sh --skip-ndk      toolchain without the large NDK download
#   sh install.sh --uninstall     remove the global commands
#
# What it does:
#   1. Installs Node.js automatically if missing (apt — never pkg).
#   2. Checks Java, Android SDK, cmake shims, NDK, Gradle and
#      auto-downloads whatever is missing (same engine the Studio uses).
#   3. Installs two global commands into $PREFIX/bin (Termux) or
#      ~/.local/bin (desktop):
#          valence-studio            → Web Studio + APK builder
#          valence <command|flags>   → the flag-driven framework CLI
# ─────────────────────────────────────────────────────────────────────────
DIR=$(cd "$(dirname "$0")" && pwd)

if [ -n "${PREFIX:-}" ] && [ -d "${PREFIX:-}/bin" ]; then
  BIN="$PREFIX/bin"
else
  BIN="$HOME/.local/bin"
fi

# --uninstall works even without Node.js
for arg in "$@"; do
  if [ "$arg" = "--uninstall" ]; then
    rm -f "$BIN/valence" "$BIN/valence-studio"
    echo "[valence] removed: $BIN/valence and $BIN/valence-studio"
    exit 0
  fi
done

. "$DIR/tools/env.sh"
valence_require_node || exit 1
valence_warn_storage

SKIP_SETUP=0
for arg in "$@"; do
  case "$arg" in
    --skip-setup|--fast) SKIP_SETUP=1 ;;
    --skip-ndk) export VALENCE_SKIP_NDK=1 ;;
  esac
done

if [ "$SKIP_SETUP" != "1" ]; then
  VALENCE_TOOLCHAIN_ONLY=1 node "$DIR/server/local-builder.mjs" || {
    echo "[valence] toolchain check reported problems — continuing with command install" >&2
  }
fi

mkdir -p "$BIN"
cat > "$BIN/valence" <<EOF
#!/usr/bin/env sh
exec sh "$DIR/valence-cli.sh" "\$@"
EOF
cat > "$BIN/valence-studio" <<EOF
#!/usr/bin/env sh
exec sh "$DIR/valence-studio.sh" "\$@"
EOF
chmod +x "$BIN/valence" "$BIN/valence-studio"

echo "[valence] installed global commands into $BIN:"
echo "[valence]   valence-studio            start the Web Studio + APK builder"
echo "[valence]   valence --help            the flag-driven framework CLI"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "[valence] note: $BIN is not on PATH — add: export PATH=\"\$PATH:$BIN\"" ;;
esac
