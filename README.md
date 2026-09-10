# Valence Studio

**Web Technologies to APK — NHZTech**

Turn a web app into an Android APK. Comes with a browser IDE (Studio) and the underlying CLI framework (Valence), for whichever way you like to work.

## Install

```bash
apt update
apt install git nodejs -y
git clone https://github.com/nhztech/valence-studio.git
cd valence-studio
```

## Option A — Studio (browser IDE, recommended)

```bash
bash START-STUDIO.sh
```

Open the URL it prints (default `http://localhost:8080`), build your app in the browser, click **Send & Build APK**. First build auto-installs the Android SDK and everything else it needs — later builds are fast.

## Option B — CLI (no browser)

```bash
cd backend/valence-framework
sh install.sh
sh setup-termux-android.sh   # once, installs the Android SDK
```

```bash
valence init myapp --name MyApp --id com.example.myapp
valence dev myapp                          # live preview
valence build myapp --target apk --out app.apk
```

Run `valence --help` for all commands.

## Notes

- Requires Node.js 18+ and, for building APKs, Termux on an Android (arm64) device.
- No `npm install` needed for Studio — the local builder has zero dependencies.
- Want a hosted version instead of local? See [`backend/README.md`](backend/README.md) for the Firebase + Cloud Run setup.
- Patch history: [`PATCHES.md`](PATCHES.md)
