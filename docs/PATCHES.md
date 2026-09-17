# Valence Studio — nhzfix patches (2026-09-03)

Patches on top of `Valence v1` (b039b1b), developed while debugging
nhzterm builds.

## v1.0.8-nhzfix — broken-node auto-repair (OpenSSL symbol errors) (2026-09-10)

Reported failure on-device:

```
CANNOT LINK EXECUTABLE "node": cannot locate symbol
"OSSL_PROVIDER_add_conf_parameter" referenced by
"/data/data/com.termux/files/usr/bin/node"
```

Cause: partial package upgrade — the installed node was built against a
newer OpenSSL than the installed `openssl` package. The launchers only
checked that node EXISTS, not that it RUNS.

Fix (`tools/env.sh`, used by valence-studio.sh / valence-cli.sh /
install.sh):
- bootstrap now verifies `node --version` actually executes;
- fresh installs pull **openssl + nodejs** together so the symbols match
  from day one;
- broken node triggers an automatic repair ladder:
  1. `apt update -y`
  2. `apt install --reinstall -y openssl nodejs` (realigns the pair)
  3. if still broken: `apt upgrade -y` (the standard cure for
     "cannot locate symbol" on Termux)
  4. if STILL broken: clear manual instructions, exit 1.

- Verified here: `sh -n` clean; simulated broken node (exits 127 with a
  linker message) + fake `apt` → launcher detected it, ran the repair,
  and continued to serve.

## v1.0.7-nhzfix — apt strictly, global commands, root install.sh (2026-09-10)

### 1. `pkg` → `apt` everywhere (strictly)
`pkg` is only a wrapper; the project now calls `apt` directly in every
script and message:
- new shared `apt_install()` helper (try direct install; if package lists
  are stale/empty, `apt update -y` and retry) in `tools/env.sh`,
  `setup-termux-ndk.sh`, `setup-sdk-cmake-arm.sh`;
- `setup-termux-android.sh`: Termux detection now `command -v apt`,
  package step `apt update -y && apt install -y ...`;
- `server/local-builder.mjs`: cmake/ninja/make/gawk + unzip installs;
- `valence-apk.sh`: toolchain gate;
- `setup-sdk-cmake-arm.sh`: env knob renamed `SKIP_PKG` → `SKIP_APT`.
Untouched: `data/workspace/**` (sample project data) and historical
PATCHES entries.

### 2. Root `install.sh` + global commands ("the cmd")
`valence-cli.sh`/`valence-studio.sh` were scripts; now `sh install.sh`
also installs real commands into `$PREFIX/bin` (Termux) or
`~/.local/bin` (desktop):

```bash
valence-studio            # start the Web Studio + builder
valence <flags>           # framework CLI (valence --help)
```

Both wrappers route through this checkout's launchers, so commands get
the same auto toolchain check and stay in sync with the Studio.
`install.sh` itself: auto-installs Node.js (apt), runs the full
toolchain check, supports `--skip-setup`, `--skip-ndk`, `--uninstall`.

### 3. `tools/env.sh` — shared bootstrap
The Node.js bootstrap (PATH repair + apt auto-install) and the
shared-storage warning moved out of the two launchers into one sourced
file, used by `valence-studio.sh`, `valence-cli.sh`, and `install.sh`.
One place to change install behavior from now on.

- Verified here: `sh -n` clean on every script; `node --check` clean;
  grep audit shows zero `pkg install` left in code; `install.sh
  --skip-setup` → wrappers work (`valence version` → 0.1.0),
  `--uninstall` removes them; Studio + CLI re-smoke-tested.

## v1.0.6-nhzfix — requirement auto-install, START-STUDIO.sh removed, docs/ (2026-09-10)

### 1. Launchers install their own requirements
Both `valence-studio.sh` and `valence-cli.sh` now, before anything else:
- repair an incomplete PATH (node present at `$PREFIX/bin` but not on
  PATH — detected via the known Termux location),
- **auto-install Node.js** via `pkg install -y nodejs` when it is truly
  missing on Termux,
- warn when running from shared storage (`~/storage/...` / `/storage/...`,
  mounted noexec) and suggest moving the folder to `$HOME`.

Trigger report: `bash valence-studio.sh` run from
`~/storage/shared/valence-studio` printed "Node.js is required" although
Node was installed — PATH was incomplete in that context.

### 2. `START-STUDIO.sh` fully removed
The v1.0.5 deprecation shim is gone; `valence-studio.sh` is the only
Studio entry point. The three Studio UI hint strings were updated too.

### 3. Documentation reorganized into `docs/`
Root keeps only `README.md` (GitHub repo page):

| new path | was |
|---|---|
| `docs/PATCHES.md` | `PATCHES.md` |
| `docs/ARCHITECTURE.md` | full codebase analysis (new) |
| `docs/DEPLOY.md` | `backend/README.md` (Firebase + Cloud Run guide) |

The vendored framework keeps its own README/LICENSE/notices inside
`backend/valence-framework/` — it is a self-contained sub-project, and
`data/workspace/**` docs are untouched sample projects.

- Verified here: `sh -n` clean for both launchers; node-missing error
  path, PATH-repair path, and a fake-`pkg` auto-install path all
  exercised; Studio serve + CLI passthrough re-tested.

## v1.0.5-nhzfix — fully automatic toolchain + new launchers (2026-09-10)

Goal: one command, zero manual steps. The user should never have to think
about SDK/NDK/Gradle/cmake.

### 1. `START-STUDIO.sh` → `valence-studio.sh` (rename + full automation)
- On EVERY start it checks the whole toolchain — Java, Android SDK,
  cmake shims, NDK, Gradle — and **auto-downloads whatever is missing**,
  then serves the Studio. Installed pieces are skipped instantly
  (filesystem checks only), so re-starts cost ~1s and nothing ever
  re-downloads.
- Old `START-STUDIO.sh` remains as a deprecation shim that execs the new
  script.
- Opt-outs: `VALENCE_SKIP_SETUP=1` / `--fast` (no check),
  `VALENCE_SKIP_NDK=1` / `--skip-ndk` (skip the ~344 MB NDK; only C/C++
  projects need it), `[port]` positional still works.

### 2. `valence-cli.sh` — the framework, flag-driven, from the repo root
- Runs the same toolchain check (`VALENCE_TOOLCHAIN_ONLY=1 node
  server/local-builder.mjs`), then execs
  `backend/valence-framework/cli/valence.mjs` with all args passed
  through: `sh valence-cli.sh build . --target apk`, no args →
  interactive menu.
- Architecture stays honest: the Web Studio is a convenience client of
  the same engine; the CLI is the product.

### 3. `server/local-builder.mjs`
- `preflightSetup()` prints a `toolchain: ✓/✗` status line per component.
- Gates: `VALENCE_SETUP=1` (studio launcher), `VALENCE_TOOLCHAIN_ONLY=1`
  (CLI launcher: check, then exit 0), legacy `--setup`/`VALENCE_SETUP_ONLY`.
- `ensureNdk()` respects `VALENCE_SKIP_NDK=1`.
- Error messages now point at `sh valence-studio.sh`.

- Verified here: `node --check` clean; `sh -n` clean for all launchers;
  CLI passthrough (`version` → 0.1.0, no-args usage), toolchain-only
  mode, studio serve after preflight, and `--fast` skip all exercised.

## v1.0.4-nhzfix — auto-install actually works (2026-09-10)

Reported failure: every build died with `Android SDK not found and could
not be auto-installed`, while the Termux terminal showed:

```
setup-termux-android.sh: 3: set: Illegal option -o pipefail
```

### Root cause
`local-builder.mjs` ran the SDK bootstrap as `sh setup-termux-android.sh`,
but on Termux `/bin/sh` is dash/busybox and line 3 of the script was
`set -euo pipefail` — a bash-only option. The script died instantly, the
SDK never installed, and every subsequent build failed. (The NDK script
survived because it only uses the POSIX-safe `set -eu`.)

### 1. `setup-termux-android.sh` — now POSIX-sh safe
- Line 3: `set -euo pipefail` only under bash (`$BASH_VERSION` guard),
  plain `set -eu` otherwise.
- Same guard around the `set +o pipefail` / `set -o pipefail` toggle in
  the license-acceptance step. Under plain sh the pipeline status is
  sdkmanager's anyway, which is what we want.

### 2. `server/local-builder.mjs` — bash interpreter + shared installers
- New `runSetupScript()`: all setup scripts now run under an explicit
  `bash` when it exists (belt-and-braces with fix #1).
- NDK auto-install extracted into `ensureNdk()`; Gradle provisioning
  extracted into `ensureSystemGradle()` (download failures now report
  instead of throwing a raw `Command failed`).
- SDK/NDK install failures append the manual-install command to the
  build log visible in Studio.

### 3. Fail fast instead of cryptic `Build failed (exit 1)`
Own-Gradle builds used to run Gradle with no `sdk.dir` when the SDK was
missing, producing a wall of Gradle output and a generic exit-1 error.
They now stop immediately with an actionable message pointing at the
manual setup command / `--setup`.

### 4. Up-front toolchain install: `sh START-STUDIO.sh --setup`
Installs SDK + cmake shims + NDK + Gradle BEFORE the Studio serves, so
no multi-hundred-MB download ever interrupts a build:

```sh
sh START-STUDIO.sh --setup          # install toolchain, then start Studio
sh START-STUDIO.sh --setup-only     # install toolchain and exit
sh START-STUDIO.sh                  # unchanged: serve, install on first build
```

`--setup` also works via `VALENCE_SETUP=1` / `VALENCE_SETUP_ONLY=1`.

- Verified here: `node --check` clean; setup script runs to the
  Termux-detection gate under both `dash` and `bash` without the
  pipefail crash; `--setup` preflight exercised end-to-end with
  stubbed toolchain paths.
- Still needs a real device pass: a fresh first-build SDK download.

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
