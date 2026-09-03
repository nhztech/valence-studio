# Valence Framework

**Pack the web. Bridge the device. Ship the valence.**  
Developed by **NHZTech**.

Valence turns a project whose renderer lives in `public/` into a native Android project. Android launches a Kotlin activity, the installed System WebView provider supplies Chromium/Blink/V8, and `valence.js` exposes controlled native APIs for private files, SQLite, permissions, dialogs, and other Android capabilities.

```text
HTML/CSS/JS in public/
          ↓
Valence CLI
          ↓
Kotlin Android shell + packaged assets
          ↓
Android System WebView (Chromium)
          ↓
APK
```

Node.js is only used by the optional development CLI. It is not included in generated Android applications.

## Current status

This repository is a working **v0.1 prototype**. The CLI can initialize and validate projects, run a browser development server, produce verified `.cart` archives, unpack them, and generate Android Studio projects. The Kotlin runtime implements the private filesystem and native SQLite bridge. A Gradle 8.7 wrapper is included, but this workspace only has Java 11 and no Android SDK, so generated Kotlin sources have not been compiled into an APK here yet. Building requires JDK 17 and the Android SDK.

## Install the CLI without npm

```bash
git clone <your-Valence-repository-url> valence-framework
cd valence-framework
sh install.sh
valence --version
```

Use `sh install.sh` rather than `./install.sh`. Android shared storage is mounted with `noexec`, so `chmod 777` cannot make scripts directly executable there. The installer copies Valence into Termux's private `$PREFIX/lib/valence-framework` directory and creates an executable launcher in `$PREFIX/bin/valence`.

Because you are already inside `valence-framework/`, you can also run the CLI directly without installing it:

```bash
node cli/valence.mjs --help
```

## Interactive Valence menu

Run Valence without arguments:

```bash
valence
```

Or launch the included shell script from the framework directory, including on Android shared storage:

```bash
sh valence.sh
```

The default launcher uses the Valence bullet logo and ASCII text banner:

```text
1. MAIN
2. INSTALL
3. UPDATE
4. REINSTALL
5. DELETE
6. EXIT
```

`MAIN` opens the project operations menu:

```text
1. BUILD APK
2. GENERATE ANDROID PROJECT
3. PREVIEW PROJECT
4. SETUP / INITIALIZE PROJECT
5. VALIDATE PROJECT
6. CHECK BUILD ENVIRONMENT
0. EXIT
```

- **Install** copies the framework into private executable storage.
- **Update** pulls Git changes when available, then refreshes the private installation; ZIP installations update from their remembered source folder.
- **Reinstall** replaces the private installation from the source folder.
- **Delete** removes only the installed copy and launcher, never the source project.

Existing command-line subcommands remain available for automation.

## Direct directory-to-APK generator

Build directly from a project directory—no `.cart` intermediate:

```bash
valence-apk /path/to/VIRN "$HOME/storage/downloads/VIRN.apk"
```

The same generator is also available as a Valence subcommand:

```bash
valence apk /path/to/VIRN "$HOME/storage/downloads/VIRN.apk"
```

Or run the script from an extracted framework:

```bash
bash valence-apk.sh /path/to/VIRN "$HOME/storage/downloads/VIRN.apk"
```

The generator accepts both Valence layouts:

```text
Source project:
  VIRN/public/index.html

Generated Android project:
  VIRN-android/app/src/main/assets/public/index.html
```

For a source project it generates a temporary Android project. For an already-generated Android project it copies that Gradle project into private temporary storage and builds it directly. This avoids Android shared storage's `noexec` restriction without regenerating or moving your project.

The generator:

1. detects either supported layout;
2. creates `valence.json` interactively when a source project is missing it;
3. validates the project;
4. detects Java, Android SDK, and ARM `aapt2`;
5. offers one-time Termux toolchain setup when required;
6. builds in private temporary storage to avoid shared-storage `noexec`;
7. writes the final APK to the requested path.

The toolchain bootstrap is Termux-specific and may use more than 1 GB of storage. It installs OpenJDK 21 and Termux's ARM-compatible `aapt2`, downloads Android command-line tools, and installs Android platform/build-tools 34.

## Canonical project structure

```text
my-app/
├── valence.json
├── public/
│   ├── index.html
│   ├── manifest.json        # optional web/PWA metadata
│   ├── sw.js                # optional; not required by Valence
│   ├── app.js
│   └── icons/
├── resources/               # optional native build resources
├── native/android/          # optional native configuration
└── plugins/                 # future/custom Kotlin plugins
```

`public/index.html` is the one required entry point. A complete application can be a single file with inline CSS and JavaScript.

The builder copies renderer files to:

```text
app/src/main/assets/public/
```

and loads:

```text
https://appassets.androidplatform.net/assets/public/index.html
```

Android intercepts this origin locally. It is not a request to an internet server.

## Three different manifests/configurations

These files have different jobs:

| File | Purpose |
|---|---|
| `valence.json` | Valence build manifest: app ID, native capabilities, permissions, network policy, Android versions |
| `public/manifest.json` | Browser/PWA metadata: web name, theme, icons, display mode; preserved but not used as Android's permission manifest |
| Generated `AndroidManifest.xml` | Native Android manifest consumed by Android Package Manager |

Your existing web `manifest.json` does not replace `valence.json` or `AndroidManifest.xml`.

Example `valence.json`:

```json
{
  "format": 1,
  "name": "VIRN",
  "id": "com.example.virn",
  "version": "1.0.0",
  "versionCode": 1,
  "entry": "public/index.html",
  "capabilities": ["filesystem", "database", "dialogs"],
  "permissions": [],
  "network": {
    "enabled": false,
    "allow": []
  },
  "android": {
    "minSdk": 24,
    "targetSdk": 34
  }
}
```

Capabilities expose Valence APIs. Permissions generate native Android declarations and allow runtime prompts. Network policy is separate.

## Commands

```bash
valence init [project] --name <name> --id <application-id>
valence validate [project]
valence doctor [project]
valence dev [project] --port 4173
valence pack [project] --out app.cart
valence unpack app.cart --out project
valence build <project|app.cart> --target android --out android-project
valence build <project|app.cart> --target apk
valence build <project|app.cart> --target aab
```

### `.cart` decision

`.cart` is implemented as an **optional portable, ZIP-compatible source archive**:

```text
project → app.cart → generated Android project → APK
```

It is not required for development, and it is not mounted as a second compressed archive inside the APK. A direct project build skips the persistent archive. This avoids double packaging while retaining an easy format for sharing, CI, backups, and reproducible inputs.

## Use Valence with your current VIRN layout

Your current project already has the correct renderer root:

```text
VIRN/
├── firebase.json
└── public/
    ├── 404.html
    ├── icons/
    ├── index.html
    ├── manifest.json
    └── sw.js
```

From inside `VIRN/public/`, the project root is `..`:

```bash
# Create VIRN/valence.json without changing public/index.html
valence init .. --name VIRN --id com.example.virn

# Check the project
valence validate ..
valence doctor ..

# Preview the existing frontend in a normal browser
valence dev .. --port 4173

# Create an optional portable archive
valence pack .. --out ../dist/VIRN.cart

# Generate the native Android Studio project
valence build .. --target android --out ../VIRN-android
```

Then open `VIRN-android/` in Android Studio and press **Run**, or build with the included wrapper after JDK 17 and the Android SDK are configured. The wrapper downloads Gradle and Android dependencies on its first run:

```bash
cd ../VIRN-android
./gradlew assembleDebug
```

Expected APK output:

```text
app/build/outputs/apk/debug/app-debug.apk
```

Replace `com.example.virn` with an application ID you control. It cannot be changed casually after publishing.

If VIRN uses the Firebase **Web SDK**, initialize with `--network`, then tighten the generated `network.allow` list in `valence.json`:

```bash
valence init .. --name VIRN --id com.example.virn --network
```

`--network` initially creates `allow: ["*"]`; restrict this before production.

## Local files

WebView JavaScript cannot directly call `java.io.File`. Valence supplies a Kotlin bridge once, so app developers use JavaScript:

```js
await valence.ready;

await valence.fs.writeFile(
  "/data/notes/hello.md",
  "# Hello from VIRN"
);

const text = await valence.fs.readFile("/data/notes/hello.md");
```

Virtual paths:

| Valence path | Android storage |
|---|---|
| `/app` | APK `assets/public`, read-only |
| `/data` | Private `filesDir/valence/data`, persistent |
| `/cache` | Private `cacheDir/valence`, disposable |
| `/database/name.db` | Private Android databases directory, managed by `valence.db` |

Private files and SQLite require no storage permission. They survive app restarts and normal updates, but are removed when the user clears app data or uninstalls the app.

Modern Android does not provide unrestricted raw paths to arbitrary user documents. For external files, a future Storage Access Framework API should preserve a `content://` URI and store that URI plus display name in SQLite. Do not copy or rename a user-selected file merely to index it.

## Native local SQLite—no localhost server

A database does not need an HTTP server or a separate backend process. It runs locally through Android SQLite:

```js
const db = await valence.db.open("virn.db");

await db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    uri TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    added_at INTEGER NOT NULL
  )
`);

await db.run(
  "INSERT OR REPLACE INTO files(uri, display_name, added_at) VALUES (?, ?, ?)",
  ["/data/documents/report.pdf", "report.pdf", Date.now()]
);

const files = await db.all(
  "SELECT * FROM files ORDER BY added_at DESC"
);
```

The SQL call is written in your frontend JavaScript, but Kotlin performs the protected database operation. Developers do not write a separate Kotlin backend for ordinary storage. Native SQLite is unavailable in `valence dev`; the browser simulator reports `ENATIVE`. Test database behavior in the Android build.

## Permissions

Browser permissions are not automatically granted. Browsers normally mediate permission prompts; in a WebView application, Valence and Android must mediate them.

Permission categories:

| Operation | Native permission behavior |
|---|---|
| Private files and SQLite | No permission required |
| Internet | Normal permission; generated when `network.enabled=true`, no runtime dialog |
| Camera/microphone/location | Declared in `valence.json` and requested at runtime |
| Notifications on modern Android | Runtime request required |
| User-selected external document | System picker grants access to that document; broad storage permission is unnecessary |

Declare only what the app needs:

```json
{
  "capabilities": [
    "filesystem",
    "database",
    "camera"
  ],
  "permissions": [
    "camera"
  ]
}
```

Request from JavaScript in response to a user action:

```js
const result = await valence.permissions.request("camera");

if (result.state === "granted") {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
}
```

The builder detects `navigator.mediaDevices.getUserMedia()` and enables the camera capability automatically. When the web page asks for video capture, Valence now triggers Android's real **Allow / Don't allow** runtime dialog before granting WebView access. Denial remains denial—Valence never bypasses the user.

HTML file inputs are handled through Android's system document picker:

```html
<input type="file" multiple>
```

`ValenceChromeClient.onShowFileChooser()` returns the selected files to `input.files`. This uses Android's Storage Access Framework, so broad storage permission is not required.

## Firebase

`firebase.json` is normally Firebase Hosting configuration. It is not `google-services.json` and is not used to configure native Firebase Android SDKs.

Two supported directions:

1. **Firebase Web SDK:** keep web initialization in `public/`, enable network, and allow required Firebase hosts. No `google-services.json` is needed.
2. **Native Firebase plugin:** place configuration at `native/android/google-services.json`. The CLI currently copies it to the generated Android app, but automatic Firebase Gradle dependencies and the native JS bridge are not implemented in v0.1 yet.

Never put a Firebase service-account private key in `public/`, `.cart`, or an APK.

## Security model

- Packaged local documents are privileged.
- Remote top-level navigation is blocked even when networking is enabled.
- Remote API/subresource hosts must match `network.allow`.
- `/app` is read-only.
- `..` path traversal is rejected.
- Native API channels require capabilities declared in `valence.json`.
- Runtime permission requests require permission declarations.
- `.cart` extraction validates paths, compression, CRC values, and a 256 MiB unpacked limit.

## License

MIT. Copyright © 2026 NHZTech and Valence contributors.
