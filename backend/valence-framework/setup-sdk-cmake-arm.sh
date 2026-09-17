#!/bin/sh
# setup-sdk-cmake-arm.sh — create the aarch64 "SDK cmake" package Google
# never shipped.
#
#   sh setup-sdk-cmake-arm.sh            fast mode (default)
#   sh setup-sdk-cmake-arm.sh --exact    EXPERIMENTAL: compile CMake
#                                        3.22.1 from source on-device
#
# WHAT IT MAKES
#   $SDK/cmake/3.22.1/bin/{cmake,ctest,cpack,ninja}   real arm64 binaries
#   $SDK/cmake/3.22.1/package.xml                     SDK package metadata
#   $SDK/cmake/{3.18.1,3.28.3} -> 3.22.1              version aliases
#
# WHY IT WORKS: AGP resolves "SDK cmake" by VERSION-NAMED FOLDER under
# $SDK/cmake (error [CXX1300] lists: SDK, PATH, cmake.dir). Google's own
# packages are x86_64-only and Kitware's linux-aarch64 tarballs are
# glibc (dead on bionic/Android) — but Termux maintains arm64-native
# cmake/ninja whose binaries carry absolute RPATH to $PREFIX/lib, so
# copies run fine from inside the SDK tree.
#
# VERSION HONESTY: fast mode puts Termux's ACTUAL cmake (e.g. 3.31.x)
# inside the 3.22.1-named folder. AGP matches the folder name and does
# not re-check the binary's reported version; any project whose
# cmake_minimum_required is <= the real version builds fine. If you
# need a binary that truly reports 3.22.1, use --exact (compiles from
# source, ~30-60 min on a phone, experimental).
#
# Env overrides (also used by the test harness):
#   ANDROID_SDK_ROOT / ANDROID_HOME  SDK location
#   SKIP_APT=1                       don't run apt install (binaries must
#                                    already be on PATH)
set -eu

# apt with self-healing package lists (try direct, else update + retry)
apt_install() { apt install -y "$@" 2>/dev/null || { apt update -y && apt install -y "$@"; }; }

EXACT=0
[ "${1:-}" = "--exact" ] && EXACT=1

CANON="3.22.1"
ALIASES="3.18.1 3.28.3"

# ---- locate the SDK (mirrors local-builder.mjs detectSdk order) ----
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$SDK" ]; then
    for c in "$HOME/.valence/android-sdk" "$HOME/.cartridge/android-sdk"; do
        [ -d "$c/platforms" ] && SDK="$c" && break
    done
fi
[ -n "$SDK" ] && [ -d "$SDK" ] || {
    echo "error: Android SDK not found (set ANDROID_SDK_ROOT, or run a"
    echo "       Valence Studio build once so it installs the SDK)"
    exit 1
}
echo "==> SDK: $SDK"

# ---- make sure arm64 cmake/ninja exist ----
if [ "${SKIP_APT:-0}" != "1" ]; then
    apt_install cmake ninja
fi
command -v cmake >/dev/null 2>&1 || { echo "error: cmake not on PATH"; exit 1; }
command -v ninja >/dev/null 2>&1 || { echo "error: ninja not on PATH"; exit 1; }

REAL="$SDK/cmake/$CANON"
CMAKE_REAL_BIN="$REAL/bin"

if [ "$EXACT" = "1" ]; then
    # ------------------------------------------------------------------
    # EXPERIMENTAL: real CMake 3.22.1, compiled from source with Termux
    # clang. Best-effort: old CMake vs new clang can fail; fast mode
    # remains the fallback. Needs ~2 GB free and patience.
    # ------------------------------------------------------------------
    echo "==> --exact: building CMake $CANON from source (experimental, slow)"
    [ "${SKIP_APT:-0}" != "1" ] && apt_install clang make python libuv rhash expat jsoncpp zlib
    T=$(mktemp -d)
    trap 'rm -rf "$T"' EXIT
    cd "$T"
    curl -fL -o cmake.tar.gz "https://github.com/Kitware/CMake/releases/download/v$CANON/cmake-$CANON.tar.gz"
    tar -xzf cmake.tar.gz
    cd "cmake-$CANON"
    ./bootstrap --prefix="$T/install" --parallel="$(nproc 2>/dev/null || echo 4)" -- \
        -DBUILD_TESTING=OFF -DBUILD_CursesDialog=OFF -DCMAKE_BUILD_TYPE=Release
    make -j"$(nproc 2>/dev/null || echo 4)"
    make install
    [ -x "$T/install/bin/cmake" ] || { echo "error: exact build failed — fast mode untouched"; exit 1; }
    mkdir -p "$CMAKE_REAL_BIN"
    for b in cmake ctest cpack; do
        [ -f "$T/install/bin/$b" ] && cp -f "$T/install/bin/$b" "$CMAKE_REAL_BIN/$b" && chmod 755 "$CMAKE_REAL_BIN/$b"
    done
    NB="$(command -v ninja)"
    cp -f "$NB" "$CMAKE_REAL_BIN/ninja" && chmod 755 "$CMAKE_REAL_BIN/ninja"
else
    # ------------------------------------------------------------------
    # Fast mode: copy Termux's arm64 binaries into the SDK layout.
    # ------------------------------------------------------------------
    mkdir -p "$CMAKE_REAL_BIN"
    for b in cmake ctest cpack ninja; do
        src="$(command -v "$b" 2>/dev/null)" || continue
        cp -f "$src" "$CMAKE_REAL_BIN/$b"
        chmod 755 "$CMAKE_REAL_BIN/$b"
        echo "    copied $b <- $src"
    done
fi

# ---- version aliases (AGP matches by folder name) ----
for v in $ALIASES; do
    ln -sfn "$CANON" "$SDK/cmake/$v"
done

# ---- SDK package metadata (best-effort; AGP itself only needs the
# ---- folder+binaries — this makes sdkmanager list it as installed) ----
cat > "$REAL/package.xml" << XML
<?xml version="1.0" encoding="UTF-8"?>
<ns2:repository xmlns:ns2="http://schemas.android.com/repository/android/common/03"
                xmlns:ns3="http://schemas.android.com/repository/android/generic/02"
                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <localPackage path="cmake;$CANON" obsolete="false">
    <type-details xsi:type="ns3:genericDetailsType"/>
    <revision><major>3</major><minor>22</minor><micro>1</micro></revision>
    <display-name>CMake $CANON (aarch64, Valence)</display-name>
  </localPackage>
</ns2:repository>
XML

# ---- verify ----
echo "==> verifying"
"$CMAKE_REAL_BIN/cmake" --version | head -1
"$CMAKE_REAL_BIN/ninja" --version
for v in $ALIASES; do
    [ -x "$SDK/cmake/$v/bin/cmake" ] || { echo "error: alias $v broken"; exit 1; }
done
echo
echo "==> SDK cmake (arm64) installed:"
ls -la "$SDK/cmake/"
echo
echo "AGP projects can now use: externalNativeBuild { cmake { path(...) } }"
echo "Note: folder presents $CANON for AGP; binary reports its true version"
echo "above (AGP matches the folder name). --exact builds a true $CANON."
