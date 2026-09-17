# Valence Studio — Comprehensive Codebase Analysis

_Analyzed: 2026-09-10 · Repo: nhztech/valence-studio @ d2f2917 ("Added Auto Install")_

## 1. What it is

**Valence Studio** (by NHZTech) turns web technologies into Android APKs. It is
three products in one repo:

1. **Studio** — a single-file browser IDE (`public/index.html`) where you import,
   edit, configure, and build apps.
2. **Local Builder** — a zero-dependency Node server (`server/local-builder.mjs`)
   that hosts the Studio AND compiles APKs on the same machine (designed for
   **Termux on a phone**; auto-installs the entire Android toolchain on first build).
3. **Valence Framework** — the actual packaging engine (`backend/valence-framework/`,
   MIT): a CLI + Android WebView runtime template + JS bridge SDK.

Plus a **remote builder** variant (`backend/server.mjs` + Dockerfile + Cloud Run)
for a hosted Firebase deployment, and sample projects in `data/workspace/`.

```
                    ┌─────────────────────────────────────────────┐
                    │  public/index.html  (Studio IDE, PWA)       │
                    │  editor · file tree · import · config form  │
                    │  browser-side ZIP writer (crc32+deflate)    │
                    └───────────────┬─────────────────────────────┘
                          POST /api/build (zip)   GET /api/buildlog (poll)
                    ┌───────────────▼─────────────────────────────┐
                    │  server/local-builder.mjs  (0 deps, :8080)  │
                    │  static hosting + workspace + clone + crawl │
                    └───────┬───────────────────────┬─────────────┘
              own Gradle?   │                       │  web project
   ┌────────────────────────▼──────┐    ┌───────────▼────────────────────┐
   │ gradlew/system gradle/        │    │ valence CLI build --target apk │
   │ auto-downloaded Gradle 8.7    │    │  → generate Android project    │
   │ assembleDebug                 │    │  → stamp gradle/manifest/icon  │
   └────────────────┬──────────────┘    │  → gradle assembleDebug        │
                    │                   └───────────┬────────────────────┘
                    └────────────► APK ◄────────────┘
```

## 2. Component deep-dive

### 2.1 Studio frontend — `public/index.html` (1543 lines, single file)

A neon/cyberpunk-styled single-page IDE (no framework, vanilla JS + inline CSS):

- **Pages:** Dashboard · Tools (Build APK) · Workspace (editor) · Runner
  (sandboxed iframe preview) · About · Settings.
- **Editor:** textarea-based with a highlight overlay layer, gutter line numbers,
  tabs (draggable), search across files, a toy virtual terminal, synthesized UI
  sound effects via WebAudio, autosave to localStorage, light/dark theme.
- **Source import (4 ways):**
  1. Drop files/folder/`.zip` — zips inflated **in-browser** with a hand-rolled
     reader using `DecompressionStream('deflate-raw')`;
  2. **LINK**: clone a repo via `/api/clone` (GitHub/GitLab/Codeberg zipballs)
     or crawl a live website via `/api/crawl` (fetches HTML + ≤30 same-origin
     assets ≤8 MB each);
  3. Saved workspace projects (`/api/workspace`);
  4. Built-in starter template (index.html/styles.css/app.js).
- **Import classifier** detects project type: `settings.gradle(.kts)` → NATIVE
  group (own-Gradle); Firebase configs → shows Firebase card; otherwise WEB group.
- **Config form:** app name, package id, version name/code, min SDK, icon
  (auto-detected from project or PNG upload), internet toggle, backend URL,
  mode tabs (bundled/live/hybrid/native), Web Client ID for Google Sign-In.
- **Build flow:** writes a ZIP **in-browser** (custom writer: CRC32 table +
  CompressionStream deflate, lines ~1318+) → `POST /api/build` as
  `application/zip` → polls `/api/buildlog` every ~2s → streams the APK back as
  a Blob download; optional **SAVE** posts it to `/api/saveapk/<name>`.
- **Google Sign-In card:** scrapes `google`-prefixed lines (package + SHA-1)
  from the build log and shows copy buttons.

### 2.2 Local builder — `server/local-builder.mjs` (648 lines, zero npm deps)

Plain `node:http` server, Termux-friendly, binds `0.0.0.0:8080` (auto-increments
port up to 20× if busy). Optional `BUILDER_TOKEN` bearer auth.

**Routes**

| Route | Purpose |
|---|---|
| `GET /health` | ok + sdk path + busy flag |
| `POST /api/build` | the whole build pipeline (see below) |
| `GET /api/buildlog` | tail of the current/last build log |
| `GET/POST /api/workspace[/:key]` | list / read / save workspace projects (≤12 MB, text or b64) |
| `POST /api/saveapk/:name` | store a finished APK into the workspace |
| `POST /api/clone` | download repo zipball → extract → return file map |
| `POST /api/crawl` | fetch a website + same-origin assets → file map |
| static | serves `public/` |

**Build pipeline (`handleBuild`)** — two tiers:

1. **Own-Gradle tier** (zip contains `settings.gradle(.kts)`, incl. hoisting a
   single wrapped top-level folder — the v1.0.1 hotfix):
   - scans for C/C++/CMake → if native: `ensureSdk()` (auto-runs
     `setup-termux-android.sh` on Termux if SDK missing), `ensureArmCmake()`,
     `detectNdk()` + auto `setup-termux-ndk.sh`;
   - picks gradle: project's `gradlew` → `$PREFIX/bin/gradle` → system →
     `~/.valence/gradle/gradle-8.7` → **auto-downloads Gradle 8.7 (~120 MB)**;
   - writes `local.properties` (sdk.dir/ndk.dir), generates an init script that
     force-aligns `android.ndkVersion` to the installed NDK revision;
   - runs `gradle assembleDebug --no-daemon`, finds the debug APK, streams it.
2. **Valence template tier** (everything else): requires `valence.json` (or
   legacy `cartridge.json`) + `index.html`; persists the project to
   `data/workspace/` (`wsPersistBuild`), then shells out to the framework CLI:
   `node cli/valence.mjs build <dir> --target apk --out app.apk --force`
   (20-minute timeout, 30 MB upload cap).

**`ensureArmCmake` (v1.0.2/1.0.3-nhzfix highlight):** Google ships no
aarch64-host SDK cmake, so this installs Termux `cmake ninja make gawk` and
creates `$SDK/cmake/{3.18.1,3.22.1,3.28.3}/bin/` shim folders that `exec` the
Termux binaries — AGP resolves SDK cmake by version-named folder, satisfying
`externalNativeBuild` projects on-device. Also wraps any pre-existing x86_64 SDK
cmakes that can't execute.

### 2.3 Remote builder — `backend/` (hosted mode)

- `server.mjs` (Express 5 + multer + unzipper): accepts ZIP → **strict safety
  boundary**: only `valence.json`, `public/**`, `resources/**` allowed; rejects
  `..` traversal, >5000 entries, >25 MB upload, >100 MB unpacked; 12-min build
  timeout; single in-process build lock; optional `BUILDER_TOKEN`. Never runs
  user Gradle — template tier only.
- `Dockerfile`: based on `ghcr.io/cirruslabs/android-sdk:34`, embeds the
  framework at `/opt/valence`.
- `cloudbuild.yaml`: builds + pushes to Artifact Registry → deploys Cloud Run
  `valence-builder` in `asia-southeast1` (4 Gi RAM, 2 CPU, 900 s timeout,
  `--allow-unauthenticated`).
- `firebase.json`: hosts `public/`, no-store caching, rewrites `/api/**` → the
  Cloud Run service, SPA fallback.
- `backend/README.md` explicitly lists remaining production work (rate limits,
  queue, artifact expiry, malware scanning, KMS release signing, audit logs).

### 2.4 Valence Framework — `backend/valence-framework/` (the engine)

**CLI (`cli/valence.mjs` + helpers):**
`init · validate · doctor · dev · pack · unpack · build · apk · launcher/main`,
plus interactive TUI menus (ASCII-art launcher). `install.sh` copies the
framework into `$PREFIX/lib/valence-framework` (Termux) or
`~/.local/share/valence-framework` and creates `valence` / `valence-apk` bin
launchers (private copy because Android shared storage is `noexec`).

**`.cart` format (`cli/archive.mjs`):** a from-scratch, dependency-free ZIP
writer/reader — deterministic (sorted entries, fixed DOS timestamps), CRC32 +
deflate, path-traversal-safe extraction, rejects symlinks/encrypted entries,
256 MiB unpacked cap. `.cart` is an *optional* portable source package
(`project → app.cart → android project → APK`); direct builds skip it.

**Project model (`cli/project.mjs`):** `valence.json` format v1:

- required: `format:1, name, id (Java-package style), version (semver-ish),
  versionCode, entry, capabilities, permissions, network{enabled,allow},
  android{minSdk≥24,targetSdk}`;
- capabilities: `filesystem, database, dialogs, notifications, camera,
  microphone, location` (gate SDK channels);
- permissions: `camera, microphone, location, notifications, bluetooth`
  (generate Android manifest entries + runtime prompts);
- modes: `bundled` (default, offline assets) · `live` (loads `https liveUrl`,
  bundled `nointernet.html` offline) · `hybrid` (live w/ bundled fallback) ·
  `native` (uses your own Kotlin/Java sources, `valence.json` is metadata);
- legacy `cartridge.json` accepted (project was evidently renamed
  Cartridge → Valence; `.cartridge` dirs still probed).

**Android generator (`cli/android.mjs`):**

- copies the `android/` template project (AGP 8.5.2, Kotlin 1.9.24, compileSdk
  34, Gradle 8.7 wrapper), then:
- bundled/hybrid: copies the whole project tree into `assets/` (skipping
  valence.json/resources), injects `sdk/valence.js` + `window.__valenceBackend`
  into the entry HTML;
- live/hybrid: generates `nointernet.html` offline page;
- native mode: deletes the generic WebView runtime, merges discovered sources
  (`app/src/main/{java|kotlin}`, res, assets; conventions list extensible;
  honors `native.sourceRoot/sourceDirs/mainActivity`), adds AppCompat theme;
- **auto-detection:** regex-scans HTML for `getUserMedia`/`facingMode` →
  CAMERA, audio capture → RECORD_AUDIO, `navigator.geolocation` → location;
- **Google Sign-In auto-patch:** rewrites Firebase `import { signInWithPopup }`
  to a shim that calls the native account picker via `ValenceNative` inside the
  APK and falls back to the popup elsewhere;
- stamps `build.gradle.kts` (applicationId/SDK levels/versions),
  `AndroidManifest.xml` (permissions from config; INTERNET only if
  `network.enabled`), `strings.xml`, launcher icon (hunts common icon paths);
- writes `ValenceBuildConfig.kt` (const object: mode, entry, live URL, allowed
  hosts, capabilities, permissions, Google web client id);
- copies `google-services.json` if present (explicitly notes Gradle deps still
  need a future plugin);
- `runAndroidBuild`: gradlew/system gradle `assembleDebug` (apk) or
  `bundleRelease` (aab); after build, prints Google Sign-In registration info —
  reads SHA-1/SHA-256 **from the APK** via `apksigner verify --print-certs`
  (fixes `google-signin-failed:10`).

**Android runtime template (Kotlin, ~1300 LOC under
`android/app/src/main/java/tech/nhz/valence/runtime/`):**

| File | Role |
|---|---|
| `ValenceActivity` | WebView host. Serves assets through `WebViewAssetLoader` on a **fake https origin** (secure-context APIs without internet). Copies assets to a writable internal-storage `web/` dir. Mode routing (bundled/live/hybrid). On-screen crash reporter (AlertDialog + crash.log). UA spoofing (strips `; wv`) to dodge Google's WebView OAuth block. `addDocumentStartJavaScript` seeds localStorage from a native session snapshot (offline login persistence). Multi-window for `signInWithPopup`. |
| `ValenceBridge` | `@JavascriptInterface ValenceNative.invoke(json)` — JSON RPC dispatcher: `sys.stDump/stGet`, `google.signIn`, `fs.*`, `db.*`, `permissions.*`, `app.getInfo/getPath`, `dialog.alert`, `notify.show` (Toast). Capability-gated (`ECAPABILITY`). |
| `ValenceClient` | WebViewClient enforcing the **network policy**: https/wss only; bundled mode allows only `network.allow` hosts for subresources and blocks remote main-frame navigation; live/hybrid locks to the live host; returns JSON `blocked-by-valence` 403s; patches remote JS/HTML for Google sign-in in live mode; hybrid falls back to bundled on error. |
| `ValenceChromeClient` | file chooser → system picker; WebRTC camera/mic → Android permission flow (only if declared); geolocation prompts; popup windows. |
| `ValenceFs` | sandboxed FS (app files dir rooted, traversal-safe): read/write/readdir/mkdir/unlink/rmdir/stat/exists/rename/tree. |
| `ValenceDatabase` | real SQLite (`exec/run/all/get` with params). |
| `ValencePermissions` | runtime permission broker (request codes 4200+, `ENOTDECLARED` guard). |
| `ValenceBuildConfig` | generated constants from `valence.json`. |
| Template assets | "Vault" demo: offline notes app exercising fs/db/dialog APIs. |

Manifest defaults to **no INTERNET permission** ("This is a local app"),
`usesCleartextTraffic=false`.

**JS SDK (`sdk/valence.js`, 875 lines):**
- dual-kernel: talks to the Kotlin bridge via `ValenceNative.invoke` inside the
  APK; in a browser ("Lab") falls back to an **IndexedDB simulator** so the same
  `valence.fs/db/...` API works during development;
- `valence.ready`, `valence.fs.*`, `valence.db.open()→{exec,run,all,get,close}`,
  `valence.dialog.alert`, `valence.notify.show`, `valence.permissions.*`,
  `valence.app.getInfo/getPath`, `valence.google.signIn()`, plus
  `valence.path.join` helper;
- **origin bridge:** when `window.__valenceBackend` is set, rewrites same-origin
  `fetch`/`XMLHttpRequest`/`WebSocket` URLs to the real backend host (so
  relative URLs in web apps keep working when packaged);
- **offline dataMap layer:** caches declared endpoints/events/storage in the
  IndexedDB kernel for offline replay (pairs with `valence-datamap.json` asset).

**Toolchain bootstrap scripts (Termux/arm64 focus):**
- `setup-termux-android.sh` — command-line tools 9123335 (sha256-pinned),
  platform `android-34`, build-tools `34.0.0` into `~/.valence/android-sdk`,
  finds Termux OpenJDK 17/21, writes env to shell profiles;
- `setup-termux-ndk.sh` — installs community **termux-ndk** (lzhiyang releases;
  Google ships no aarch64-host NDK) into `~/.valence/android-ndk`;
- `setup-sdk-cmake-arm.sh` — materializes the SDK-cmake package layout Google
  never shipped for arm64: copies Termux cmake/ninja into
  `$SDK/cmake/3.22.1/bin/` + `package.xml` + version aliases (`--exact` flag
  compiles real 3.22.1 from source, experimental);
- `valence-apk.sh` — interactive directory→APK generator (source or generated
  Android project; no `.cart` intermediate);
- `valence.sh` — launcher entry.

### 2.5 Workspace samples — `data/workspace/`

- **Chatting** (`com.tycept.chatting`) — stub web-chat project (placeholder
  HTML + 1-byte server.js); exercises the web-tier path.
- **My App** (`mode: native`, mainActivity `tech.nhz.nhzterm.ui.TerminalActivity`)
  — packages **nhzterm**, the author's separate product: an Android terminal
  daemon (`nhztermd` foreground service owning real PTYs), `nhzterm-api`
  Kotlin protocol library, WebView+xterm.js UI, plus **nhzsh**, a custom
  POSIX-ish shell written in C (lexer/parser/expander/executor, daemon IPC,
  test suites). README claims 416 off-device assertions passing. This is how the
  nhzfix patches in `PATCHES.md` were exercised (real `externalNativeBuild` +
  CMake on-device).

### 2.6 History (`PATCHES.md`, git log)

3 commits: `b039b1b` Valence v1 → `8e6e9b1` "Added Features" (the
**nhzfix patches**: v1.0.1 top-level-folder hoist + import classifier + buildlog
dedupe; v1.0.2 ensureArmCmake rewrite + `.cartridge` NDK detection) →
`d2f2917` "Added Auto Install" (first-build auto-provisioning of SDK/Gradle/NDK).

## 3. Architecture highlights & design philosophy

1. **Phone-first**: everything is engineered to run *on the Android device
   itself* under Termux — zero-dep local server, arm64 toolchain bootstrap,
   cmake/NDK workarounds for things Google doesn't ship for aarch64 hosts.
2. **Security-conscious by default**: offline-first apps get no INTERNET
   permission; network allow-list enforced in the WebViewClient; capability and
   permission gating on every bridge channel; zip-slip guards everywhere
   (archive, remote builder, workspace saves); fake https asset origin instead
   of `file://`.
3. **Escalating build tiers**: plain web → Valence WebView template; full
   Gradle project → built with its own Gradle; native Kotlin/Java/C → same
   own-Gradle tier with NDK/cmake shims. `valence.json` `mode: native` even
   lets the template wrap arbitrary native sources.
4. **Zero-dependency ethos**: hand-rolled ZIP codec, hand-rolled multipart
   parser, hand-rolled fetch fallback, single-file IDE — minimizing npm is a
   deliberate Termux constraint.
5. **Auto-remediation over documentation**: missing SDK/NDK/Gradle/cmake are
   installed/shimmed automatically during the first build.

## 4. Notable risks / weaknesses observed

- **Single-file IDE** (1543-line `index.html`) mixes CSS+HTML+JS — hard to
  maintain/test; no test suite for the Studio or local-builder (framework has
  harness-only checks mentioned in PATCHES.md).
- **Regex-based code surgery**: Firebase import patching and HTML capability
  detection rely on regexes; unusual-but-valid code can be missed or mangled.
- **`patchGoogleSignIn` + UA spoofing** are inherently cat-and-mouse with
  Google's OAuth-in-WebView policies.
- **One-at-a-time build locks** in both servers; the remote builder README
  itself lists missing production hardening (queues, rate limits, signing,
  scanning).
- **Remote builder is `--allow-unauthenticated`** at the Cloud Run level
  (token optional, empty = open by default).
- `WebContentsDebuggingEnabled(true)` is hardcoded in the runtime template
  (fine for dev, should be stripped for production APKs).
- `/api/crawl` is an open same-origin fetcher (SSRF surface limited to
  http(s) but worth noting if ever exposed publicly).
- `Chatting` sample contains junk placeholder content (`server.js` = "x").

## 5. How to run it

```bash
sh valence-studio.sh            # → http://localhost:8080  (needs Node only;
                              #    first APK build auto-installs the toolchain on Termux)
# CLI only:
cd backend/valence-framework && sh install.sh
valence init myapp --name "My App" --id com.example.myapp
valence dev myapp && valence build myapp --target apk
# Hosted mode: gcloud builds submit (backend/) + firebase deploy (public/)
```
