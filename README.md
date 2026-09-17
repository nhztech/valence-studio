# Valence Studio

**Web Technologies to APK — NHZTech**

Turn a web app into an Android APK. Comes with a browser IDE (Studio) and the underlying CLI framework (Valence), for whichever way you like to work.

## Install

```bash
apt update
apt install git -y          # Node.js is auto-installed by the installer if missing
git clone https://github.com/nhztech/valence-studio.git
cd valence-studio
sh install.sh               # auto: Node.js + SDK + cmake shims + NDK + Gradle + global commands
```

`install.sh` gives you two commands you can run from anywhere:

```bash
valence-studio              # Web Studio + APK builder
valence --help              # the flag-driven framework CLI
```

(Flags: `--skip-setup` commands only, `--skip-ndk` skip the large NDK download, `--uninstall` remove the commands. All package installation uses **apt**, strictly.)

## Option A — Studio (browser IDE, recommended)

```bash
sh valence-studio.sh
```

That's it. On start it **checks the whole toolchain — Java, Android SDK, cmake shims, NDK, Gradle — and automatically downloads whatever is missing** (first run does the large downloads; every later start is instant). Then open the URL it prints (default `http://localhost:8080`), build your app in the browser, click **Send & Build APK**.

Opt-outs: `VALENCE_SKIP_SETUP=1` (skip the check), `VALENCE_SKIP_NDK=1` or `--skip-ndk` (skip the large NDK download — only C/C++ projects ever need it), `--fast` (start without any checks).

## Option B — CLI (no browser)

```bash
sh valence-cli.sh                       # interactive menu
sh valence-cli.sh build myapp --target apk --out app.apk
```

The CLI runs the same auto toolchain check, then hands off to the flag-driven Valence framework — the same engine the Studio uses. Full install as a global `valence` command:

```bash
cd backend/valence-framework
sh install.sh                            # toolchain auto-checked by valence-cli.sh
valence init myapp --name MyApp --id com.example.myapp
valence dev myapp                        # live preview
valence build myapp --target apk --out app.apk
```

Run `valence --help` (or `sh valence-cli.sh --help`) for all commands.

## Docs

Everything except this README lives in [`docs/`](docs/):

- [`docs/PATCHES.md`](docs/PATCHES.md) — patch history (nhzfix releases)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full codebase analysis & architecture
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — hosted Firebase + Cloud Run builder setup

The Valence Framework keeps its own README/LICENSE inside `backend/valence-framework/` — it is a self-contained vendored sub-project.

## Notes

- Requires Node.js 18+ (auto-installed on Termux by the launchers) and, for building APKs, Termux on an Android (arm64) device.
- No `npm install` needed for Studio — the local builder has zero dependencies.
- Want a hosted version instead of local? See [`docs/DEPLOY.md`](docs/DEPLOY.md).
