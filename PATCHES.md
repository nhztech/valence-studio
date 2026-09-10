# Valence Studio — nhzfix patches (2026-09-03)

Patches on top of `Valence v1` (b039b1b), developed while debugging
nhzterm builds.

## v1.0.3-nhzfix — SDK cmake for arm64: `setup-sdk-cmake-arm.sh`

Google ships no aarch64-host SDK cmake, and Kitware's linux-aarch64
tarballs are glibc (dead on bionic). But Termux maintains arm64-native
cmake/ninja with absolute RPATH — so this installer materializes the
**real SDK-cmake package layout** from them:

```sh
sh backend/valence-framework/setup-sdk-cmake-arm.sh          # fast mode
sh backend/valence-framework/setup-sdk-cmake-arm.sh --exact  # experimental
```

- **Fast mode (default, tested):** `pkg install cmake ninja` → real
  binaries COPIED into `$SDK/cmake/3.22.1/bin/` (+ctest/cpack),
  `package.xml` written so sdkmanager lists it, `3.18.1`/`3.28.3`
  symlink aliases for common version pins. Verified end-to-end in a
  harness (copies run, aliases resolve).
- **`--exact` (experimental):** compiles true CMake 3.22.1 from source
  with Termux clang (~30–60 min) for anyone needing a binary that
  literally reports 3.22.1. Untested on-device — fast mode remains the
  fallback; failure doesn't touch the fast-mode install.
- **Version honesty:** fast mode puts Termux's actual cmake (e.g.
  3.31.x) in the 3.22.1-named folder; AGP matches the FOLDER name and
  doesn't re-check the binary. Projects needing literal 3.22.1 output
  use `--exact`.
- Coexists with the v1.0.2 `ensureArmCmake` shims: the installer's real
  folders are skipped by the shim logic (it only creates missing ones).

## v1.0.2-nhzfix — native-build integration (SDK-cmake + ndk-build)

### Research findings (why these patches look the way they do)
- **Google publishes no aarch64-host SDK cmake.** `sdkmanager "cmake;..."`
  fetches x86_64 binaries — dead on an arm64 Termux host. So "installing
  the real SDK cmake" is impossible on-device.
- **AGP doesn't actually need Google's binaries.** Its resolution order
  (per error `[CXX1300] CMake 'X' was not found in SDK, PATH, or by
  cmake.dir property`) matches SDK cmake by **version-named folder**
  under `$SDK/cmake/`. A folder `3.22.1/` containing shims that
  `exec` Termux's arm64 cmake satisfies AGP completely — this is the
  same wrapping technique Valence already used for broken SDK cmakes,
  extended to create the layout when it doesn't exist at all.
- **ndk-build** just needs GNU `make` (+ `awk`) on PATH — Termux has
  both via pkg; neither was being installed.

### 5. `server/local-builder.mjs` — `ensureArmCmake` rewritten
- Installs missing arm64 tools via pkg: `cmake ninja make gawk`
  (cmake+ninja → AGP CMake path; make+awk → ndk-build path).
- **Creates SDK-cmake shim folders** `$SDK/cmake/{3.18.1,3.22.1,3.28.3}/bin/`
  with executable `cmake`/`ninja`/`ctest`/`cpack` wrappers → Termux
  binaries. 3.22.1 = the AGP 7.x–8.x default; the others cover common
  explicit pins. Projects using `externalNativeBuild { cmake { ... } }`
  now work on-device with zero manual steps.
- Idempotent (skips existing shims); the legacy "wrap unrunnable real
  SDK cmake" loop is preserved for folders it didn't create.
- Verified: extracted-function test harness — 15/15 checks (shims
  created ×3 versions ×4 tools, shim exec reaches the Termux binary,
  idempotent re-run).

### 6. `server/local-builder.mjs` — `detectNdk` learned `.cartridge`
`detectSdk` already checked `~/.cartridge/android-sdk` (newer install
layout — real devices use it), but `detectNdk` only looked at
`~/.valence/android-ndk` and `$PREFIX/opt/android-ndk`, so `ndk.dir`
was never written to `local.properties` on `.cartridge` installs →
own-Gradle native builds couldn't find the NDK. Candidate added.

## v1.0.1-nhzfix — build-tier fixes

1. **Unwrap single top-level folder** — zips that wrap everything in one
   folder (`myapp/settings.gradle.kts`) now get hoisted, so the
   own-Gradle tier triggers instead of silently falling back to the
   WebView template tier. Only fires on that exact shape.
2. **own-Gradle log line** — `[valence] own-Gradle project: APK
   id/version come from build.gradle.kts` (no more form-version
   confusion).
3. **Buildlog tail dedupe** — failure logs no longer double-append.
4. **Import classifier** — zips containing `settings.gradle(.kts)` hit
   the "Android project → NATIVE group" branch, not generic "project
   ZIP".

## Install on device
Replace the changed files in your Studio checkout (or replace the whole
folder if you don't need its data/workspace state), then restart:
```
server/local-builder.mjs
public/index.html
```
`sh START-STUDIO.sh`

## Verified / not verified
- Here: `node --check` clean; extracted-function harness 15/15; hoist
  logic functionally tested (v1.0.1).
- On device (needs a real build): an actual `externalNativeBuild`
  project passing `configureCMakeDebug[arm64-v8a]` via the shims, and
  an `ndkBuild` project linking via Termux make.
