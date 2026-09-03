# Valence Studio

**Web Technologies to APK — NHZTech**

A separate browser IDE and remote build client for Valence Framework. It is intentionally not included in `valence-framework.zip`.

## Included

- Original anime-tech gold/navy identity and cel-shaded Valence mascot
- Hamburger navigation
- Dashboard and build pipeline status
- VS Code-inspired workspace
- Folder and multi-file import
- File tree, tabs, text editor, line numbers, keyboard Tab/Ctrl+S
- Live HTML preview
- Visual Android app identity and permission settings
- IndexedDB project cache
- Cached project manager and build history
- ZIP build-package export
- Remote builder API client with logs/progress/APK download
- Firebase Hosting configuration
- Cloud Run Android-builder scaffold

## Cache policy

Imported source is stored only in browser IndexedDB. It is not uploaded until **Send & Build APK** is pressed.

Clearing this site's browser data deletes cached projects, settings, and build history. Normal HTTP-cache cleanup behavior varies by browser; use **Clear All Studio Data** for a guaranteed wipe.

Do not rely on browser cache as the only copy of source code. Studio can export a build ZIP at any time.

## Run locally

```bash
python3 -m http.server 4173 --directory public
```

Open `http://localhost:4173`.

## Firebase architecture

```text
Firebase Hosting        -> Studio static files
IndexedDB               -> temporary local project cache
Cloud Run builder       -> Android SDK + Valence + Gradle
Firebase Authentication -> builder access control
APK response            -> browser download
```

Firebase Hosting alone cannot compile APKs. Deploy `backend/` to Cloud Run and keep the build endpoint protected. See `backend/README.md`.

## Build API

Studio sends:

```text
POST /api/build
Authorization: Bearer <Firebase ID token>
Content-Type: multipart/form-data
project: ZIP
config: valence.json
```

The API may return an APK directly or JSON containing a build job/status/download URL.

## Branding files

- `branding/valence-studio-anime-master.png` — 1024px generated anime master
- `public/assets/valence-studio-logo.webp` — optimized web logo
- `public/assets/icon-192.png`
- `public/assets/icon-512.png`
