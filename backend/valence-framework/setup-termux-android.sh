#!/usr/bin/env bash
# Valence Android toolchain bootstrap for Termux (ARM64).
# NOTE: keep this file runnable under plain POSIX sh as well — Termux's
# /bin/sh is often dash/busybox, which dies on bash-only `set -o pipefail`
# ("set: Illegal option -o pipefail"). The Studio auto-installer used to
# invoke this with `sh` and crash on exactly that line.
if [ -n "${BASH_VERSION:-}" ]; then
  set -euo pipefail
else
  set -eu
fi

TOOLS_REVISION="9123335"
TOOLS_SHA256="0bebf59339eaa534f4217f8aa0972d14dc49e7207be225511073c661ae01da0a"
PLATFORM="android-34"
BUILD_TOOLS="34.0.0"
TOOLCHAIN_ROOT="${VALENCE_TOOLCHAIN_ROOT:-$HOME/.valence}"
export ANDROID_HOME="${ANDROID_HOME:-$TOOLCHAIN_ROOT/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

say() { printf '\033[1;36m[VALENCE]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARNING]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; return 1; }

is_termux() {
  [ -n "${PREFIX:-}" ] && command -v apt >/dev/null 2>&1
}

java_major() {
  java -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p' | head -n 1
}

find_java_home() {
  for candidate in \
    "${JAVA_HOME:-}" \
    "${PREFIX:-}/lib/jvm/java-21-openjdk" \
    "${PREFIX:-}/lib/jvm/java-17-openjdk"; do
    if [ -n "$candidate" ] && [ -x "$candidate/bin/java" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

write_profile() {
  local begin='# >>> valence android toolchain >>>'
  local end='# <<< valence android toolchain <<<'
  local profile temporary
  mkdir -p "$TOOLCHAIN_ROOT"
  for profile in "$HOME/.profile" "$HOME/.bashrc"; do
    temporary="$TOOLCHAIN_ROOT/$(basename "$profile").tmp"
    if [ -f "$profile" ]; then
      awk -v begin="$begin" -v end="$end" '
        $0 == begin { skip=1; next }
        $0 == end { skip=0; next }
        !skip { print }
      ' "$profile" > "$temporary"
    else
      : > "$temporary"
    fi
    {
      cat "$temporary"
      printf '\n%s\n' "$begin"
      printf 'export JAVA_HOME="%s"\n' "$JAVA_HOME"
      printf 'export ANDROID_HOME="%s"\n' "$ANDROID_HOME"
      printf 'export ANDROID_SDK_ROOT="$ANDROID_HOME"\n'
      printf 'export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/build-tools/%s:$PATH"\n' "$BUILD_TOOLS"
      printf '%s\n' "$end"
    } > "$profile"
    rm -f "$temporary"
  done
}

configure_aapt2() {
  mkdir -p "$HOME/.gradle"
  local properties="$HOME/.gradle/gradle.properties"
  local line="android.aapt2FromMavenOverride=$PREFIX/bin/aapt2"
  if [ -f "$properties" ]; then
    sed -i '/^android\.aapt2FromMavenOverride=/d' "$properties"
  fi
  printf '%s\n' "$line" >> "$properties"
}

install_packages() {
  say "Installing Java and ARM-compatible Android tools (apt)..."
  apt update -y
  apt install -y openjdk-21 aapt aapt2 apksigner wget unzip git
}

install_command_tools() {
  local sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
  if [ -x "$sdkmanager" ]; then return 0; fi
  local cache="$TOOLCHAIN_ROOT/cache"
  local archive="$cache/commandlinetools-${TOOLS_REVISION}.zip"
  local extract="$TOOLCHAIN_ROOT/cmdline-extract"
  mkdir -p "$cache" "$ANDROID_HOME/cmdline-tools"
  if [ ! -f "$archive" ]; then
    say "Downloading Android command-line tools..."
    wget -q --show-progress \
      "https://dl.google.com/android/repository/commandlinetools-linux-${TOOLS_REVISION}_latest.zip" \
      -O "$archive"
  fi
  local actual
  actual=$(sha256sum "$archive" | awk '{print $1}')
  [ "$actual" = "$TOOLS_SHA256" ] || die "Android tools checksum mismatch"
  rm -rf "$extract" "$ANDROID_HOME/cmdline-tools/latest"
  mkdir -p "$extract"
  unzip -q "$archive" -d "$extract"
  mv "$extract/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$extract"
  chmod +x "$ANDROID_HOME/cmdline-tools/latest/bin/"*
}

install_sdk_components() {
  local sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
  if [ -f "$ANDROID_HOME/platforms/$PLATFORM/android.jar" ] && \
     [ -f "$ANDROID_HOME/build-tools/$BUILD_TOOLS/d8" ]; then
    return 0
  fi
  say "Accepting Android SDK licenses..."
  # `yes` dies of SIGPIPE once sdkmanager exits; only bash has pipefail (which
  # would surface that SIGPIPE as a pipeline failure), so toggle it there only.
  # Under plain sh the pipeline status is sdkmanager's anyway — what we want.
  if [ -n "${BASH_VERSION:-}" ]; then set +o pipefail; fi
  yes | "$sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null
  if [ -n "${BASH_VERSION:-}" ]; then set -o pipefail; fi
  say "Installing SDK platform 34 and build tools 34.0.0..."
  "$sdkmanager" --sdk_root="$ANDROID_HOME" \
    "platforms;$PLATFORM" \
    "build-tools;$BUILD_TOOLS"
}

main() {
  if ! is_termux; then
    die "Automatic setup currently supports Termux only. Use Android Studio on desktop."
    return 1
  fi

  local major=""
  if command -v java >/dev/null 2>&1; then major=$(java_major || true); fi
  if [ -z "$major" ] || [ "$major" -lt 17 ] || ! command -v aapt2 >/dev/null 2>&1; then
    install_packages
  fi

  JAVA_HOME=$(find_java_home) || die "Java 17+ was not found after package installation"
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/build-tools/$BUILD_TOOLS:$PATH"

  install_command_tools
  install_sdk_components
  configure_aapt2
  write_profile

  say "Android build toolchain is ready."
  say "JAVA_HOME=$JAVA_HOME"
  say "ANDROID_HOME=$ANDROID_HOME"
  say "AAPT2=$PREFIX/bin/aapt2"
}

main "$@"
