#!/usr/bin/env bash
# Valence — on-device Android NDK (arm64) installer.
# Google ships no aarch64-host NDK; the community termux-ndk port provides the
# full LLVM cross toolchain at toolchains/llvm/prebuilt/linux-aarch64.
set -eu
say() { printf '\033[1;36m[VALENCE]\033[0m %s\n' "$*"; }
[ -n "${PREFIX:-}" ] || { echo "run this inside Termux"; exit 1; }
NDK_ROOT="${VALENCE_NDK_ROOT:-$HOME/.valence/android-ndk}"

if [ -x "$NDK_ROOT/toolchains/llvm/prebuilt/linux-aarch64/bin/clang" ]; then
  say "NDK already installed at $NDK_ROOT"
else
  for t in wget curl tar unzip; do command -v $t >/dev/null 2>&1 || pkg install -y $t; done
  command -v xz >/dev/null 2>&1 || pkg install -y xz-utils || true
  say "resolving latest termux-ndk release..."
  ASSET_URL="$(curl -fsSL https://api.github.com/repos/lzhiyong/termux-ndk/releases/latest 2>/dev/null | grep -o 'https://[^"]*aarch64[^"]*' | head -1)"
  [ -n "$ASSET_URL" ] || ASSET_URL="https://github.com/lzhiyong/termux-ndk/releases/download/android-ndk/android-ndk-r29-aarch64.tar.xz"
  TDIR="${TMPDIR:-$PREFIX/tmp}"
  mkdir -p "$TDIR" "$HOME/.valence"
  say "downloading termux-ndk (arm64 Android NDK, ~1GB unpacked): $ASSET_URL"
  wget --show-progress -O "$TDIR/valence-ndk.tar.xz" "$ASSET_URL" || curl -fL --progress-bar -o "$TDIR/valence-ndk.tar.xz" "$ASSET_URL"
  [ -s "$TDIR/valence-ndk.tar.xz" ] || { say "NDK download failed (empty file) — check network"; exit 1; }
  mkdir -p "$TDIR/ndkx"
  tar -xJf "$TDIR/valence-ndk.tar.xz" -C "$TDIR/ndkx" || { say "NDK extract failed"; exit 1; }
  rm -rf "$NDK_ROOT"
  mv "$TDIR"/ndkx/android-ndk* "$NDK_ROOT"
  rm -rf "$TDIR/ndkx" "$TDIR/valence-ndk.tar.xz"
  say "NDK installed at $NDK_ROOT" 
fi
chmod -R +x "$NDK_ROOT/toolchains" 2>/dev/null || true

for f in "$HOME/.profile" "$HOME/.bashrc"; do
  touch "$f"
  grep -q "VALENCE NDK" "$f" || printf '\n# >>> VALENCE NDK >>>\nexport ANDROID_NDK_HOME="%s"\nexport PATH="$PATH:$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-aarch64/bin"\n# <<< VALENCE NDK <<<\n' "$NDK_ROOT" >> "$f"
done
export ANDROID_NDK_HOME="$NDK_ROOT"

"$NDK_ROOT/toolchains/llvm/prebuilt/linux-aarch64/bin/aarch64-linux-android21-clang" --version | head -1
say "NDK ready: $NDK_ROOT (ANDROID_NDK_HOME exported)"
