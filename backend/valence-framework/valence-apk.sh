#!/usr/bin/env bash
# Valence source project OR generated Android project -> APK. No .cart intermediate.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
CLI="$ROOT/cli/valence.mjs"
BUILD_DIR=""

cleanup() {
  if [ -n "$BUILD_DIR" ] && [ -d "$BUILD_DIR" ]; then rm -rf "$BUILD_DIR"; fi
}
trap cleanup EXIT INT TERM

say() { printf '\033[1;36m[VALENCE APK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARNING]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

ask() {
  local label="$1" fallback="${2:-}" value=""
  if [ -n "$fallback" ]; then
    read -r -p "$label [$fallback]: " value
    printf '%s\n' "${value:-$fallback}"
  else
    read -r -p "$label: " value
    printf '%s\n' "$value"
  fi
}

yes_no() {
  local label="$1" fallback="${2:-n}" value=""
  if [ "${VALENCE_YES:-0}" = "1" ]; then return 0; fi
  if [ "$fallback" = "y" ]; then read -r -p "$label [Y/n]: " value
  else read -r -p "$label [y/N]: " value
  fi
  value="${value:-$fallback}"
  [ "$value" = "y" ] || [ "$value" = "Y" ] || [ "$value" = "yes" ] || [ "$value" = "YES" ]
}

slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g;s/-\+/-/g;s/^-//;s/-$//'
}

json_name() {
  local file="$1" fallback="$2"
  if [ -f "$file" ] && command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs");try{const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.name||process.argv[2])}catch{process.stdout.write(process.argv[2])}' "$file" "$fallback"
  else
    printf '%s' "$fallback"
  fi
}

java_ok() {
  command -v java >/dev/null 2>&1 || return 1
  local major
  major=$(java -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$major" ] && [ "$major" -ge 17 ]
}

sdk_ok() {
  local sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/.valence/android-sdk}}"
  [ -f "$sdk/platforms/android-34/android.jar" ] && \
  [ -f "$sdk/build-tools/34.0.0/d8" ] && \
  command -v aapt2 >/dev/null 2>&1
}

printf '\n\033[1;36m'
printf '     __      __\n'
printf '     \\ \\    / /\n'
printf '      \\ \\  / /\n'
printf '       \\ \\/ /\n'
printf '        \\__/\n'
printf '      [ APK ]\n'
printf '\033[0m\n'
say "DIRECT DIRECTORY -> APK"

PROJECT="${1:-}"
if [ -z "$PROJECT" ]; then PROJECT=$(ask "Project directory" "."); fi
PROJECT=$(cd "$PROJECT" 2>/dev/null && pwd -P) || die "Project directory not found: $PROJECT"

LAYOUT=""
CONFIG_FILE=""
if [ -f "$PROJECT/public/index.html" ]; then
  LAYOUT="source"
  CONFIG_FILE="$PROJECT/valence.json"
  [ ! -f "$CONFIG_FILE" ] && [ -f "$PROJECT/cartridge.json" ] && CONFIG_FILE="$PROJECT/cartridge.json"
elif [ -f "$PROJECT/app/src/main/assets/public/index.html" ] && \
     [ -f "$PROJECT/settings.gradle.kts" ] && [ -f "$PROJECT/app/build.gradle.kts" ]; then
  LAYOUT="android"
  CONFIG_FILE="$PROJECT/app/src/main/assets/valence.json"
  [ ! -f "$CONFIG_FILE" ] && [ -f "$PROJECT/app/src/main/assets/cartridge.json" ] && CONFIG_FILE="$PROJECT/app/src/main/assets/cartridge.json"
else
  die "Unsupported project layout. Expected either:
  $PROJECT/public/index.html
or:
  $PROJECT/app/src/main/assets/public/index.html"
fi
say "Detected layout: $LAYOUT"

if [ "$LAYOUT" = "source" ]; then
  command -v node >/dev/null 2>&1 || die "Node.js is required for a source project"
  if [ ! -f "$CONFIG_FILE" ]; then
    APP_NAME=$(ask "Application name" "$(basename "$PROJECT")")
    ID_TAIL=$(slug "$APP_NAME" | tr -d '-')
    APP_ID=$(ask "Android application ID" "com.nhztech.${ID_TAIL:-app}")
    INIT_ARGS=(init "$PROJECT" --name "$APP_NAME" --id "$APP_ID")
    if yes_no "Does the app use Firebase or internet?" "n"; then INIT_ARGS+=(--network); fi
    node "$CLI" "${INIT_ARGS[@]}"
  fi
  node "$CLI" validate "$PROJECT"
else
  [ -f "$PROJECT/gradlew" ] || die "Generated Android project is missing gradlew"
  say "Renderer: app/src/main/assets/public/index.html"
fi

APP_NAME=$(json_name "$CONFIG_FILE" "$(basename "$PROJECT")")
DEFAULT_DIR="$HOME"
[ -d "$HOME/storage/downloads" ] && DEFAULT_DIR="$HOME/storage/downloads"
OUTPUT="${2:-}"
if [ -z "$OUTPUT" ]; then OUTPUT=$(ask "Output APK" "$DEFAULT_DIR/$(slug "$APP_NAME").apk"); fi
case "$OUTPUT" in /*) ;; *) OUTPUT="$PWD/$OUTPUT" ;; esac
mkdir -p "$(dirname "$OUTPUT")"

FORCE_ARGS=()
if [ -e "$OUTPUT" ]; then
  if yes_no "Replace existing $OUTPUT?" "n"; then FORCE_ARGS+=(--force)
  else die "Cancelled"
  fi
fi

if ! java_ok || ! sdk_ok; then
  if ! command -v apt >/dev/null 2>&1; then
    die "Java 17+ or Android SDK is missing. Install Android Studio or configure the Android SDK."
  fi
  warn "Android toolchain setup downloads packages and can use over 1 GB of storage."
  if yes_no "Set up the Termux Android toolchain now?" "n"; then
    # Source it so JAVA_HOME and ANDROID_HOME remain available for this build.
    # shellcheck source=/dev/null
    source "$ROOT/setup-termux-android.sh"
  else
    die "Toolchain setup was declined"
  fi
fi

export ANDROID_HOME="${ANDROID_HOME:-$HOME/.valence/android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
if [ -z "${JAVA_HOME:-}" ] && [ -n "${PREFIX:-}" ]; then
  for candidate in "$PREFIX/lib/jvm/java-21-openjdk" "$PREFIX/lib/jvm/java-17-openjdk"; do
    if [ -x "$candidate/bin/java" ]; then export JAVA_HOME="$candidate"; break; fi
  done
fi
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/build-tools/34.0.0:$PATH"

say "Building $APP_NAME from $PROJECT"
if [ "$LAYOUT" = "source" ]; then
  node "$CLI" build "$PROJECT" --target apk --out "$OUTPUT" "${FORCE_ARGS[@]}"
else
  TEMP_BASE="${TMPDIR:-${PREFIX:-$HOME}/tmp}"
  mkdir -p "$TEMP_BASE"
  BUILD_DIR=$(mktemp -d "$TEMP_BASE/valence-android.XXXXXX")
  say "Copying generated Android project to private build storage..."
  cp -R "$PROJECT/." "$BUILD_DIR/"
  # Refresh the runtime in the private build copy so older generated projects
  # receive bridge fixes and native file-picker support. Keep the app-specific
  # ValenceBuildConfig.kt that was generated from its valence.json.
  TEMPLATE_RUNTIME="$ROOT/android/app/src/main/java/tech/nhz/valence/runtime"
  TARGET_RUNTIME="$BUILD_DIR/app/src/main/java/tech/nhz/valence/runtime"
  if [ -d "$TEMPLATE_RUNTIME" ] && [ -d "$TARGET_RUNTIME" ]; then
    for runtime_file in "$TEMPLATE_RUNTIME"/*.kt; do
      [ "$(basename "$runtime_file")" = "ValenceBuildConfig.kt" ] && continue
      cp -f "$runtime_file" "$TARGET_RUNTIME/"
    done
  fi
  # Compatibility repair for any non-standard copy left in the project.
  while IFS= read -r activity; do
    sed -i 's/Array<out String>/Array<String>/g' "$activity"
  done < <(find "$BUILD_DIR/app/src/main/java" -type f -name 'ValenceActivity.kt' 2>/dev/null)

  RENDERER="$BUILD_DIR/app/src/main/assets/public/index.html"
  MANIFEST="$BUILD_DIR/app/src/main/AndroidManifest.xml"
  APP_CONFIG="$BUILD_DIR/app/src/main/java/tech/nhz/valence/runtime/ValenceBuildConfig.kt"
  if grep -Eq 'navigator\.mediaDevices\.getUserMedia|facingMode[[:space:]]*:' "$RENDERER"; then
    say "Detected camera API; enabling Android CAMERA permission..."
    node - "$MANIFEST" "$APP_CONFIG" <<'NODE'
const fs = require('fs');
const manifestFile = process.argv[2];
const configFile = process.argv[3];
let manifest = fs.readFileSync(manifestFile, 'utf8');
if (!manifest.includes('android.permission.CAMERA')) {
  manifest = manifest.replace(/(<manifest\b[^>]*>)/, '$1\n    <uses-permission android:name="android.permission.CAMERA" />');
  fs.writeFileSync(manifestFile, manifest);
}
let source = fs.readFileSync(configFile, 'utf8');
function addToSet(name, value) {
  const expression = new RegExp(`(val ${name}: Set<String> = )(emptySet\\(\\)|setOf\\(([^)]*)\\))`);
  source = source.replace(expression, (_all, prefix, current, body = '') => {
    if (current.includes(`"${value}"`)) return prefix + current;
    const values = current.startsWith('emptySet') || !body.trim() ? `"${value}"` : `${body.trim()}, "${value}"`;
    return `${prefix}setOf(${values})`;
  });
}
addToSet('CAPABILITIES', 'camera');
addToSet('DECLARED_PERMISSIONS', 'camera');
fs.writeFileSync(configFile, source);
NODE
  fi
  chmod +x "$BUILD_DIR/gradlew"
  printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$BUILD_DIR/local.properties"
  (
    cd "$BUILD_DIR"
    ./gradlew --no-daemon assembleDebug
  )
  ARTIFACT="$BUILD_DIR/app/build/outputs/apk/debug/app-debug.apk"
  [ -f "$ARTIFACT" ] || die "Gradle finished without producing app-debug.apk"
  cp -f "$ARTIFACT" "$OUTPUT"
fi

[ -f "$OUTPUT" ] || die "Build finished without producing $OUTPUT"
say "APK READY"
printf '\n  %s\n\n' "$OUTPUT"
if command -v termux-open >/dev/null 2>&1; then
  printf 'Install it with:\n  termux-open "%s"\n\n' "$OUTPUT"
fi
