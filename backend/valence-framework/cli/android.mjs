import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ANDROID_PERMISSIONS = {
  camera: ["android.permission.CAMERA"],
  microphone: ["android.permission.RECORD_AUDIO"],
  location: ["android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"],
  notifications: ["android.permission.POST_NOTIFICATIONS"],
  bluetooth: [
    "android.permission.BLUETOOTH",
    "android.permission.BLUETOOTH_SCAN",
    "android.permission.BLUETOOTH_CONNECT",
  ],
};

function mergeDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const a = path.join(src, name), d = path.join(dest, name);
    if (fs.statSync(a).isDirectory()) mergeDir(a, d);
    else fs.copyFileSync(a, d);
  }
}

function hasSources(dir) {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      const st = fs.statSync(f);
      if (st.isDirectory()) stack.push(f);
      else if (/\.(kt|java)$/.test(n)) return true;
    }
  }
  return false;
}

/* Layout conventions, in priority order. Extend here as new conventions show up. */
const NATIVE_CONVENTIONS = [
  { base: "app/src/main" }, // standard Gradle-nested Android layout
  { base: "" },             // flat layout at the project root
];

function locateNativeSources(root, config) {
  const nat = (config && config.native) || {};
  const checked = [];
  const tryBase = (base, dirs) => {
    const b = path.join(root, base);
    const codeNames = dirs.code ? [dirs.code] : ["kotlin", "java"];
    for (const cn of codeNames) {
      const code = path.join(b, cn);
      checked.push(`${base ? base + "/" : ""}${cn}/`);
      if (hasSources(code)) {
        return {
          code,
          res: fs.existsSync(path.join(b, dirs.res || "res")) ? path.join(b, dirs.res || "res") : null,
          assets: fs.existsSync(path.join(b, dirs.assets || "assets")) ? path.join(b, dirs.assets || "assets") : null,
        };
      }
    }
    return null;
  };
  if (nat.sourceRoot || nat.sourceDirs) {
    const hit = tryBase(nat.sourceRoot || "", nat.sourceDirs || {});
    if (hit) return hit;
  } else {
    for (const conv of NATIVE_CONVENTIONS) {
      const hit = tryBase(conv.base, {});
      if (hit) return hit;
    }
    // one-level nested module folders (e.g. nhzterm/app/src/main)
    for (const sub of fs.readdirSync(root)) {
      const p0 = path.join(root, sub);
      if (!fs.statSync(p0).isDirectory() || ["node_modules", ".git", "build", "out", "tools", "tests"].includes(sub)) continue;
      const hit = tryBase(path.join(sub, "app", "src", "main"), {});
      if (hit) return hit;
    }
  }
  throw new Error(
    `native mode: no sources found — checked ${checked.join(" and ")}; ` +
    `set native.sourceRoot / native.sourceDirs in valence.json if your project uses a different layout`,
  );
}

function copyProjectTree(root, assetsRoot, skipDir) {
  const walk = (dir, rel) => {
    if (skipDir && path.resolve(dir) === path.resolve(skipDir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!rel && (name === "valence.json" || name === "cartridge.json" || name === "resources")) continue;
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) { walk(abs, r); continue; }
      const dest = path.join(assetsRoot, r);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
  };
  walk(root, "");
}

export function generateAndroidProject({ frameworkRoot, project, outputDir, force = false }) {
  const mode = project.config.mode || "bundled";
  const liveMode = mode === "live";
  const hybridMode = mode === "hybrid";
  const nativeMode = mode === "native";
  const indexSource = nativeMode ? "" : path.join(project.root, project.config.entry || "public/index.html");
  const entryExists = !nativeMode && fs.existsSync(indexSource);
  const entryRel = liveMode ? "nointernet.html" : nativeMode ? "" : (project.config.entry || "public/index.html");
  const rendererHtml = entryExists ? fs.readFileSync(indexSource, "utf8") : "";
  const config = detectRendererRequirements(project.config, rendererHtml);
  const template = path.join(frameworkRoot, "android");
  if (!fs.existsSync(template)) throw new Error(`Android template missing: ${template}`);
  if (fs.existsSync(outputDir)) {
    if (!force) throw new Error(`output already exists: ${outputDir} (use --force to replace it)`);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  copyDir(template, outputDir);
  const generatedWrapper = path.join(outputDir, "gradlew");
  if (fs.existsSync(generatedWrapper) && process.platform !== "win32") {
    fs.chmodSync(generatedWrapper, 0o755);
  }

  const assetsRoot = path.join(outputDir, "app/src/main/assets");
  fs.rmSync(assetsRoot, { recursive: true, force: true });
  fs.mkdirSync(assetsRoot, { recursive: true });
  if (nativeMode) {
    const loc = locateNativeSources(project.root, project.config);
    // strip the generic WebView runtime so a native artifact never ships the bare template
    fs.rmSync(path.join(outputDir, "app/src/main/java/tech/nhz/valence/runtime"), { recursive: true, force: true });
    mergeDir(loc.code, path.join(outputDir, "app/src/main/java"));
    if (loc.res) mergeDir(loc.res, path.join(outputDir, "app/src/main/res"));
    if (loc.assets) mergeDir(loc.assets, path.join(outputDir, "app/src/main/assets"));
  } else if (!liveMode) copyProjectTree(project.root, assetsRoot, outputDir);
  if (!nativeMode && !liveMode && entryExists) {
    const webDir = path.join(assetsRoot, path.dirname(entryRel));
    fs.mkdirSync(webDir, { recursive: true });
    const sdkSource = path.join(frameworkRoot, "sdk/valence.js");
    fs.copyFileSync(sdkSource, path.join(webDir, "valence.js"));
    injectSdk(path.join(assetsRoot, entryRel), (config.network && config.network.backend) || "");
    patchGoogleSignIn(webDir);
  }
  if (!nativeMode && (liveMode || hybridMode)) {
    const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#070913;color:#8da0bd;font-family:monospace;display:grid;place-items:center;height:100vh;text-align:center}h1{color:#eaf8ff;font-size:18px;letter-spacing:.1em}button{margin-top:18px;padding:12px 34px;border:0;border-radius:0;background:linear-gradient(135deg,#28f3ff,#229cff);color:#00111f;font-weight:800;letter-spacing:.2em}</style></head><body><div><h1>NO INTERNET CONNECTION</h1><p>This part needs the live server.</p><button onclick="location.href='${(config.liveUrl || "").replace(/'/g, "\'")}'">RETRY</button></div></body></html>\n`;
    fs.writeFileSync(path.join(assetsRoot, "nointernet.html"), page);
  }

  const configAsset = path.join(assetsRoot, "valence.json");
  fs.writeFileSync(configAsset, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(
    path.join(assetsRoot, "valence-datamap.json"),
    `${JSON.stringify(config.dataMap || { events: [], endpoints: [], storage: [] }, null, 2)}\n`,
  );
  if (!nativeMode) writeNativeBuildConfig(outputDir, config);
  stampGradle(outputDir, config);
  stampManifest(outputDir, config);
  stampStrings(outputDir, config.name);
  stampIcon(outputDir, project);

  const nativeFirebase = ["native/android/google-services.json", "resources/google-services.json"]
    .map(p => path.join(project.root, p))
    .find(f => fs.existsSync(f));
  if (nativeFirebase) {
    // The file is placed correctly, but Firebase Gradle dependencies still require
    // the future native-firebase plugin. Keeping this explicit avoids pretending.
    fs.copyFileSync(nativeFirebase, path.join(outputDir, "app/google-services.json"));
  }
  return outputDir;
}

/**
 * Auto-upgrade Google sign-in: rebinds the app's imported signInWithPopup to a
 * wrapper that uses the native Android account picker when running inside a
 * Valence APK, falling back to the original popup elsewhere. Works for direct
 * calls AND aliases like `window.fb = { signInWithPopup }` because the import
 * binding itself is renamed.
 */
function patchGoogleSignIn(rootDir) {
  const IMPORT_RE = /import\s*\{([\s\S]*?)\}\s*from\s*(["'][^"']*firebase-auth[^"']*["'])\s*;?/g;
  const SHIM = `
const signInWithPopup = async (__vAuth, __vProvider, ...__vRest) => {
  const __vNative = typeof window !== "undefined" ? window.ValenceNative : null;
  const __vGoogle = __vProvider && __vProvider.providerId === "google.com";
  if (__vGoogle && __vNative) {
    const __vRes = await new Promise((res, rej) => {
      const __vL = (e) => { window.removeEventListener("valence:google-signin", __vL); const d = e.detail || {}; if (d.idToken) res(d); else rej(new Error(d.error || "google-signin-failed")); };
      window.addEventListener("valence:google-signin", __vL);
      try { __vNative.invoke(JSON.stringify({ id: "vg" + Date.now(), channel: "google", method: "signIn", args: {} })); } catch (er) { window.removeEventListener("valence:google-signin", __vL); rej(er); }
    });
    return await signInWithCredential(__vAuth, GoogleAuthProvider.credential(__vRes.idToken));
  }
  return __valencePopup(__vAuth, __vProvider, ...__vRest);
};`;
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) { walk(file); continue; }
      if (!/\.(html|htm|js|mjs)$/i.test(name)) continue;
      let text = fs.readFileSync(file, "utf8");
      if (!text.includes("signInWithPopup") || text.includes("__valencePopup")) continue;
      let patched = false;
      text = text.replace(IMPORT_RE, (whole, names, source) => {
        if (!/\bsignInWithPopup\b/.test(names)) return whole;
        let list = names.replace(/\bsignInWithPopup\b/, "signInWithPopup as __valencePopup");
        if (!/\bsignInWithCredential\b/.test(list)) list += ", signInWithCredential";
        if (!/\bGoogleAuthProvider\b/.test(list)) list += ", GoogleAuthProvider";
        patched = true;
        return `import {${list}} from ${source};${SHIM}`;
      });
      if (patched) {
        fs.writeFileSync(file, text);
        console.log(`patched   ${path.basename(file)} → native Google account picker bridge`);
      }
    }
  };
  walk(rootDir);
}

function stampIcon(outputDir, project) {
  const candidates = [
    path.join(project.root, "resources/icon.png"),
    path.join(project.publicDir, "icons/icon-512.png"),
    path.join(project.publicDir, "icons/icon-192.png"),
    path.join(project.publicDir, "icons/icon-maskable-512.png"),
    path.join(project.publicDir, "icon-512.png"),
    path.join(project.publicDir, "icon-192.png"),
    path.join(project.publicDir, "icon.png"),
    path.join(project.publicDir, "assets/icon-512.png"),
    path.join(project.publicDir, "assets/icon-192.png"),
  ];
  const icon = candidates.find(f => fs.existsSync(f));
  if (!icon) return;
  const drawable = path.join(outputDir, "app/src/main/res/drawable");
  fs.mkdirSync(drawable, { recursive: true });
  fs.copyFileSync(icon, path.join(drawable, "valence_icon.png"));
  const manifestFile = path.join(outputDir, "app/src/main/AndroidManifest.xml");
  const text = fs.readFileSync(manifestFile, "utf8")
    .replace("@android:drawable/sym_def_app_icon", "@drawable/valence_icon");
  fs.writeFileSync(manifestFile, text);
  console.log(`icon      ${path.relative(project.root, icon)} → launcher icon`);
}

function detectRendererRequirements(original, html) {
  const config = JSON.parse(JSON.stringify(original));
  config.capabilities ||= [];
  config.permissions ||= [];
  const enable = (capability, permission) => {
    if (!config.capabilities.includes(capability)) config.capabilities.push(capability);
    if (!config.permissions.includes(permission)) config.permissions.push(permission);
  };
  if (/navigator\.mediaDevices\.getUserMedia\s*\(|facingMode\s*:/i.test(html)) {
    enable("camera", "camera");
    console.log("detected  camera API → Android CAMERA permission enabled");
  }
  if (/getUserMedia[\s\S]{0,300}audio\s*:\s*(?:true|\{)/i.test(html)) {
    enable("microphone", "microphone");
    console.log("detected  microphone API → Android RECORD_AUDIO permission enabled");
  }
  if (/navigator\.geolocation\b/i.test(html)) {
    enable("location", "location");
    console.log("detected  geolocation API → Android location permissions enabled");
  }
  return config;
}

export function runAndroidBuild(androidDir, target) {
  const task = target === "aab" ? "bundleRelease" : "assembleDebug";
  const wrapper = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  const wrapperPath = path.join(androidDir, wrapper);
  let command;
  let args;
  if (fs.existsSync(wrapperPath)) {
    if (process.platform !== "win32") fs.chmodSync(wrapperPath, 0o755);
    command = wrapperPath;
    args = [task];
  } else {
    const probe = spawnSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? ["gradle"] : ["-c", "command -v gradle"], { encoding: "utf8" });
    if (probe.status !== 0) {
      throw new Error(
        "Gradle is unavailable. Open the generated Android project in Android Studio, " +
          "or add a Gradle wrapper, then run ./gradlew " +
          task,
      );
    }
    command = "gradle";
    args = [task];
  }
  const result = spawnSync(command, args, { cwd: androidDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Gradle ${task} failed with exit code ${result.status}`);
  return target === "aab"
    ? path.join(androidDir, "app/build/outputs/bundle/release/app-release.aab")
    : path.join(androidDir, "app/build/outputs/apk/debug/app-debug.apk");
}

/**
 * Reads the SHA-1 fingerprint of the keystore Gradle used to sign the APK
 * (the auto-generated debug keystore). Google Cloud must have an Android
 * OAuth client with package name + this SHA-1, otherwise the native Google
 * account picker fails with DEVELOPER_ERROR (status 10).
 */
export function googleSha1Info() {
  const home = os.homedir();
  const keystores = [
    { file: path.join(home, ".android", "debug.keystore"), alias: "androiddebugkey", pass: "android" },
    { file: path.join(process.env.ANDROID_HOME || home, "debug.keystore"), alias: "androiddebugkey", pass: "android" },
  ];
  for (const ks of keystores) {
    if (!fs.existsSync(ks.file)) continue;
    const run = spawnSync(
      "keytool",
      ["-list", "-v", "-keystore", ks.file, "-alias", ks.alias, "-storepass", ks.pass],
      { encoding: "utf8" },
    );
    if (run.status !== 0 || !run.stdout) continue;
    const match = /SHA-?1\D+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){19})/.exec(run.stdout);
    const match256 = /SHA-?256\D+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31})/.exec(run.stdout);
    if (match) {
      return {
        keystore: ks.file,
        sha1: match[1].toUpperCase(),
        sha256: match256 ? match256[1].toUpperCase() : null,
        source: "keystore",
      };
    }
  }
  return null;
}

/**
 * Reads the signing certificate fingerprints FROM THE GENERATED APK using the
 * SDK's apksigner. This is the authoritative source: exactly what Google Play
 * Services sees when it verifies the app (fixes "google-signin-failed:10").
 */
export function apkCertInfo(apkPath) {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), ".valence", "android-sdk"),
    path.join(os.homedir(), ".cartridge", "android-sdk"),
  ];
  const bins = [];
  for (const root of roots) {
    if (!root) continue;
    const bt = path.join(root, "build-tools");
    if (!fs.existsSync(bt)) continue;
    for (const ver of fs.readdirSync(bt).sort().reverse()) {
      const dir = path.join(bt, ver);
      if (fs.statSync(dir).isDirectory()) bins.push(path.join(dir, "apksigner"));
    }
  }
  for (const bin of bins) {
    if (!fs.existsSync(bin)) continue;
    const run = spawnSync(bin, ["verify", "--print-certs", apkPath], { encoding: "utf8" });
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const sha1 = /SHA-1 digest:\s*([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){19})/i.exec(out);
    if (!sha1) continue;
    const sha256 = /SHA-256 digest:\s*([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31})/i.exec(out);
    return {
      sha1: sha1[1].toUpperCase(),
      sha256: sha256 ? sha256[1].toUpperCase() : null,
      source: "apk",
    };
  }
  return null;
}

/**
 * Prints the one-time Google Sign-In registration info (package + SHA-1)
 * AFTER the APK exists, reading the certificate from the APK itself when
 * possible so the values exactly match what Google verifies.
 */
export function printGoogleSignInSetup(config, apkPath) {
  const cert = (apkPath && apkCertInfo(apkPath)) || googleSha1Info();
  if (!cert) {
    console.log(`\ngoogle    SHA-1 not readable — run: keytool -list -v -keystore ~/.android/debug.keystore -storepass android`);
    return false;
  }
  const from = cert.source === "apk" ? "read from your built APK" : "read from signing keystore";
  console.log(`\ngoogle    ── Google Sign-In setup (fixes "google-signin-failed:10") ──`);
  console.log(`google    copy →  package   ${config.id}`);
  console.log(`google    copy →  SHA-1     ${cert.sha1}   (${from})`);
  if (cert.sha256) console.log(`google    copy →  SHA-256   ${cert.sha256}`);
  console.log(`google    1. Firebase Console → ⚙️ Project settings → Your apps → Add app → Android`);
  console.log(`google    2. paste package + SHA-1 → Register app (SKIP google-services.json / Gradle plugin steps — this app uses the Firebase Web SDK)`);
  console.log(`google    3. wait ~5 min, then tap "Continue with Google" again — no rebuild needed`);
  return true;
}

function injectSdk(indexFile, backend = "") {
  let html = fs.readFileSync(indexFile, "utf8");
  if (backend) {
    html = html.replace(/(src|href)\s*=\s*(["'])\/socket\.io\//gi, (_m, q, quote) => `${q}=${quote}${backend}/socket.io/`);
  }
  const hasSdk = /\bsrc\s*=\s*["'][^"']*valence\.js(?:[?#][^"']*)?["']/i.test(html);
  const hasB = /window\.__valenceBackend\s*=/.test(html);
  if (hasSdk && (hasB || !backend)) { fs.writeFileSync(indexFile, html); return; }
  const tag = `${hasB ? "" : `    <script>window.__valenceBackend=${JSON.stringify(backend || "")};</script>\n`}    <script src="./valence.js"></script>\n`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) html = html.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}\n${tag}`);
  else html = `${tag}${html}`;
  fs.writeFileSync(indexFile, html);
}

function writeNativeBuildConfig(outputDir, config) {
  const file = path.join(
    outputDir,
    "app/src/main/java/tech/nhz/valence/runtime/ValenceBuildConfig.kt",
  );
  const hosts = config.network.allow.map(kotlinString).join(", ");
  const permissions = config.permissions.map(kotlinString).join(", ");
  const capabilities = config.capabilities.map(kotlinString).join(", ");
  const webClientId = kotlinString((config.google && config.google.webClientId) || "");
  const source = `package tech.nhz.valence.runtime

/** Generated from valence.json. Do not edit the generated copy. */
object ValenceBuildConfig {
    const val NETWORK_ENABLED: Boolean = ${config.network.enabled}
    const val GOOGLE_WEB_CLIENT_ID: String = ${webClientId}
    const val ENTRY: String = ${kotlinString(config.entry || "public/index.html")}
    const val MODE: String = ${kotlinString(config.mode || "bundled")}
    const val LIVE_URL: String = ${kotlinString(config.liveUrl || "")}
    const val SOURCE_URL: String = ${kotlinString(config.liveUrl || (config.network && config.network.backend) || "")}
    val ALLOWED_HOSTS: Set<String> = setOf(${hosts})
    val CAPABILITIES: Set<String> = setOf(${capabilities})
    val DECLARED_PERMISSIONS: Set<String> = setOf(${permissions})
}
`;
  fs.writeFileSync(file, source);
}

function stampGradle(outputDir, config) {
  if (config.mode === "native") {
    const gfile = path.join(outputDir, "app/build.gradle.kts");
    let g = fs.readFileSync(gfile, "utf8");
    if (!g.includes("androidx.appcompat")) {
      g = g.replace(/implementation\(["']androidx\.core:core-ktx/, m => 'implementation("androidx.appcompat:appcompat:1.7.0")\n    ' + m);
      fs.writeFileSync(gfile, g);
    }
    const tfile = path.join(outputDir, "app/src/main/res/values/themes.xml");
    let t = fs.readFileSync(tfile, "utf8");
    if (!t.includes("Theme.Valence.Native")) {
      t = t.replace("</resources>", '    <style name="Theme.Valence.Native" parent="Theme.AppCompat.DayNight.NoActionBar">\n        <item name="android:statusBarColor">#070708</item>\n        <item name="android:navigationBarColor">#070708</item>\n    </style>\n</resources>');
      fs.writeFileSync(tfile, t);
    }
  }
  const file = path.join(outputDir, "app/build.gradle.kts");
  let text = fs.readFileSync(file, "utf8");
  text = text.replace(/applicationId\s*=\s*"[^"]+"/, `applicationId = "${config.id}"`);
  text = text.replace(/minSdk\s*=\s*\d+/, `minSdk = ${config.android.minSdk}`);
  text = text.replace(/targetSdk\s*=\s*\d+/, `targetSdk = ${config.android.targetSdk}`);
  text = text.replace(/compileSdk\s*=\s*\d+/, `compileSdk = ${config.android.targetSdk}`);
  text = text.replace(/versionCode\s*=\s*\d+/, `versionCode = ${config.versionCode}`);
  text = text.replace(/versionName\s*=\s*"[^"]+"/, `versionName = "${config.version}"`);
  fs.writeFileSync(file, text);
}

function stampManifest(outputDir, config) {
  const file = path.join(outputDir, "app/src/main/AndroidManifest.xml");
  let text = fs.readFileSync(file, "utf8");
  text = text.replace(/\s*<!-- No INTERNET permission on purpose\. This is a local app\. -->\s*/g, "\n");
  const permissions = new Set();
  if (config.network.enabled) {
    permissions.add("android.permission.INTERNET");
    permissions.add("android.permission.ACCESS_NETWORK_STATE");
  }
  for (const permission of config.permissions) {
    for (const androidName of ANDROID_PERMISSIONS[permission] || []) permissions.add(androidName);
  }
  const tags = [...permissions]
    .sort()
    .map((name) => `    <uses-permission android:name="${name}" />`)
    .join("\n");
  if (config.mode === "native") {
    text = text.replace(/\s*<activity\s+android:name="\.ValenceActivity"[\s\S]*?<\/activity>/, "");
    const main = (config.native && config.native.mainActivity) || "MainActivity";
    const actName = main.includes(".") ? main : `.${main}`;
    text = text.replace(/\s*<intent-filter>[\s\S]*?<\/intent-filter>/, "");
    text = text.replace("@style/Theme.Valence", "@style/Theme.Valence.Native");
    text = text.replace(
      "</application>",
      `    <activity android:name="${actName}" android:exported="true" android:configChanges="orientation|screenSize|keyboardHidden">\n` +
      `            <intent-filter>\n` +
      `                <action android:name="android.intent.action.MAIN" />\n` +
      `                <category android:name="android.intent.category.LAUNCHER" />\n` +
      `            </intent-filter>\n` +
      `        </activity>\n    </application>`,
    );
  }
  text = text.replace(/(<manifest[^>]*>)/, tags ? `$1\n${tags}` : "$1");
  fs.writeFileSync(file, text);
}

function stampStrings(outputDir, appName) {
  const file = path.join(outputDir, "app/src/main/res/values/strings.xml");
  fs.writeFileSync(file, `<resources>\n    <string name="app_name">${escapeXml(appName)}</string>\n</resources>\n`);
}

function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are not copied: ${from}`);
    if (stat.isDirectory()) copyDir(from, to);
    else if (stat.isFile()) fs.copyFileSync(from, to);
  }
}

function kotlinString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
