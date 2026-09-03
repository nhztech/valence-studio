# Valence Studio remote builder

Firebase Hosting serves the Studio UI; it does **not** run Gradle. The heavy compiler runs in a Cloud Run container with JDK, Android SDK, Gradle, and Valence Framework.

```text
Studio (Firebase Hosting)
  -> authenticated project ZIP
Cloud Run valence-builder
  -> fixed Valence Android template
  -> Gradle assembleDebug
Firebase Hosting response
  <- APK
```

## Safety boundary

The service accepts only:

- `valence.json`
- `public/**`
- `resources/**`

It rejects uploaded Gradle, Kotlin, native plugins, absolute paths, `..` traversal, more than 5,000 entries, uploads over 25 MB, and expanded projects over 100 MB. This is essential: never execute arbitrary uploaded Gradle projects on a shared builder.

## Deploy

1. Create a Firebase/Google Cloud project with Billing, Cloud Build, Cloud Run, Artifact Registry, and Firebase Authentication enabled.
2. Create an Artifact Registry Docker repository named `valence`.
3. Valence Framework is already embedded in `valence-framework/` — nothing to clone.
4. From this directory:

```bash
gcloud builds submit --config cloudbuild.yaml
```

5. From the parent `Valence Studio/` directory:

```bash
firebase deploy --only hosting
```

6. In Studio Settings set the endpoint to `/api/build`. Pass a Firebase ID token as the access token. `REQUIRE_FIREBASE_AUTH=false` is for private local testing only.

## Production work still required

- Per-user rate limits and quotas
- A queue rather than one in-process build lock
- Build artifact expiration
- Malware/content scanning
- Audit logs
- Release signing through a managed KMS flow
- Cost controls and abuse monitoring

The current service returns a debug APK directly. Never accept or store users' release keystores in plain text.
