#!/usr/bin/env sh
set -eu

SOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

if [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/bin" ]; then
  BIN="$PREFIX/bin"
  INSTALL_ROOT="$PREFIX/lib/valence-framework"
else
  BIN="${HOME}/.local/bin"
  INSTALL_ROOT="${HOME}/.local/share/valence-framework"
fi

mkdir -p "$BIN" "$(dirname -- "$INSTALL_ROOT")"

# Android shared storage is mounted noexec and does not preserve executable bits.
# Install a private copy rather than symlinking back to the shared-storage source.
if [ "$SOURCE_ROOT" != "$INSTALL_ROOT" ]; then
  rm -rf "$INSTALL_ROOT"
  mkdir -p "$INSTALL_ROOT"
  cp -R "$SOURCE_ROOT/." "$INSTALL_ROOT/"
  printf '%s\n' "$SOURCE_ROOT" > "$INSTALL_ROOT/.install-source"
fi

chmod +x "$INSTALL_ROOT/cli/valence.mjs"
for script in valence.sh valence-apk.sh setup-termux-android.sh; do
  if [ -f "$INSTALL_ROOT/$script" ]; then chmod +x "$INSTALL_ROOT/$script"; fi
done
if [ -f "$INSTALL_ROOT/android/gradlew" ]; then
  chmod +x "$INSTALL_ROOT/android/gradlew"
fi

cat > "$BIN/valence" <<EOF
#!/usr/bin/env sh
exec node "$INSTALL_ROOT/cli/valence.mjs" "\$@"
EOF
chmod +x "$BIN/valence"

cat > "$BIN/valence-apk" <<EOF
#!/usr/bin/env sh
exec bash "$INSTALL_ROOT/valence-apk.sh" "\$@"
EOF
chmod +x "$BIN/valence-apk"

printf 'Installed Valence Framework: %s\n' "$INSTALL_ROOT"
printf 'Installed Valence CLI:       %s/valence\n' "$BIN"
printf 'Installed APK generator:       %s/valence-apk\n' "$BIN"
case ":${PATH}:" in
  *":${BIN}:"*) ;;
  *) printf 'Add this directory to PATH:   %s\n' "$BIN" ;;
esac
"$BIN/valence" --version
