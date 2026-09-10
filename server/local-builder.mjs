#!/usr/bin/env node
/**
 * VALENCE STUDIO — LOCAL BUILDER
 * One server: hosts the Studio website AND compiles APKs on the same machine.
 * Zero npm dependencies. Made for Termux/localhost.
 *
 *   node server/local-builder.mjs            → http://localhost:8080
 *   VALENCE_PORT=4173 node server/local-builder.mjs
 *
 * Uses the embedded Valence Framework + whatever Android toolchain is
 * already installed (the framework's setup script installs it in Termux).
 */
import http from "node:http";
import nodeHttps from "node:https";
import nodeHttp from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const FRAMEWORK = process.env.VALENCE_FRAMEWORK || path.join(ROOT, "backend", "valence-framework");
const CLI = path.join(FRAMEWORK, "cli", "valence.mjs");
const PORT = Number(process.env.VALENCE_PORT || process.env.PORT || 8080);
const TOKEN = process.env.BUILDER_TOKEN || ""; // optional shared secret

const { extractCart } = await import("file://" + path.join(FRAMEWORK, "cli", "archive.mjs"));

const MIME = { html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", png: "image/png", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", woff2: "font/woff2" };
let building = false;
let lastLog = "";

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
function urlTries(u) {
  const list = [u.toString()];
  const w = new URL(u);
  if (w.host.startsWith("www.")) { w.host = w.host.slice(4); list.push(w.toString()); }
  else { w.host = "www." + w.host; list.push(w.toString()); }
  const t = new URL(u);
  t.pathname = t.pathname === "/" ? "/" : t.pathname.replace(/\/+$/, "") + "/";
  list.push(t.toString());
  return [...new Set(list)];
}
function ensureArmCmake(sdk) {
  if (!sdk || !process.env.PREFIX) return;
  const cmakeRoot = path.join(sdk, "cmake");
  const pbin = n => path.join(process.env.PREFIX, "bin", n);
  const sysCmake = pbin("cmake"), sysNinja = pbin("ninja");
  const sysMake = pbin("make"), sysAwk = pbin("awk");

  // Google ships NO aarch64-host SDK cmake (its packages are x86_64),
  // and ndk-build needs GNU make + awk — neither ships with Termux.
  // Install the arm64-native tools that cover BOTH AGP native paths:
  //   externalNativeBuild.cmake  → cmake + ninja
  //   externalNativeBuild.ndkBuild → make + awk
  const missing = [];
  if (!fs.existsSync(sysCmake)) missing.push("cmake");
  if (!fs.existsSync(sysNinja)) missing.push("ninja");
  if (!fs.existsSync(sysMake)) missing.push("make");
  if (!fs.existsSync(sysAwk)) missing.push("gawk");
  if (missing.length) {
    say(`installing Termux ${missing.join("/")} (arm64) for native C/C++ builds...`);
    lastLog += `[valence] installing Termux ${missing.join("/")} (arm64)...\n`;
    try { execSync(`pkg install -y ${missing.join(" ")}`, { stdio: "inherit", timeout: 10 * 60 * 1000 }); } catch (e) { say("pkg install failed: " + e.message); }
  }
  if (!fs.existsSync(sysCmake)) return;

  // AGP resolves "SDK cmake" by VERSION-NAMED FOLDER under $SDK/cmake
  // (error [CXX1300]: "CMake 'X' was not found in SDK, PATH, or by
  // cmake.dir property" — and a PATH cmake only satisfies an EXACT
  // requested version). Google's binaries can't run on this arm64
  // host, so create the folder layout AGP expects, with shims that
  // exec Termux's arm64 cmake/ninja. 3.22.1 is the AGP 7.x–8.x
  // default; the others cover common explicit version pins.
  const SHIM_VERSIONS = ["3.18.1", "3.22.1", "3.28.3"];
  for (const ver of SHIM_VERSIONS) {
    const vbin = path.join(cmakeRoot, ver, "bin");
    if (fs.existsSync(path.join(vbin, "cmake"))) continue; // already there
    fs.mkdirSync(vbin, { recursive: true });
    const shims = [["cmake", sysCmake], ["ninja", sysNinja]];
    for (const name of ["ctest", "cpack"]) {
      if (fs.existsSync(pbin(name))) shims.push([name, pbin(name)]);
    }
    for (const [name, target] of shims) {
      const f = path.join(vbin, name);
      fs.writeFileSync(f, `#!/bin/sh\nexec "${target}" "$@"\n`);
      fs.chmodSync(f, 0o755);
    }
    say(`SDK cmake shim ${ver} → Termux arm64 cmake (AGP externalNativeBuild ready)`);
    lastLog += `[valence] SDK cmake shim ${ver} → Termux arm64 cmake\n`;
  }

  // Legacy: any REAL SDK cmake dirs (x86_64 binaries fetched on another
  // host) that can't execute here get wrapped with Termux's arm64 tools.
  for (const ver of fs.existsSync(cmakeRoot) ? fs.readdirSync(cmakeRoot) : []) {
    const bin = path.join(cmakeRoot, ver, "bin");
    if (!fs.existsSync(bin)) continue;
    const c = path.join(bin, "cmake");
    if (fs.existsSync(c)) {
      let works = true;
      try { execSync(`"${c}" --version`, { stdio: "pipe" }); } catch (e) { works = false; }
      if (!works) {
        say(`SDK cmake ${ver} not runnable here — wrapping with Termux arm64 cmake`);
        lastLog += `[valence] wrapping SDK cmake ${ver} with Termux arm64 cmake\n`;
        fs.writeFileSync(c, `#!/bin/sh\nexec "${sysCmake}" "$@"\n`);
        fs.chmodSync(c, 0o755);
      }
    }
    const n = path.join(bin, "ninja");
    if (fs.existsSync(n)) {
      let works = true;
      try { execSync(`"${n}" --version`, { stdio: "pipe" }); } catch (e) { works = false; }
      if (!works && fs.existsSync(sysNinja)) {
        fs.writeFileSync(n, `#!/bin/sh\nexec "${sysNinja}" "$@"\n`);
        fs.chmodSync(n, 0o755);
      }
    }
  }
}

function detectNdk() {
  const candidates = [
    process.env.ANDROID_NDK_HOME,
    path.join(os.homedir(), ".valence", "android-ndk"),
    path.join(os.homedir(), ".cartridge", "android-ndk"), // newer install layout (matches detectSdk)
    process.env.PREFIX ? path.join(process.env.PREFIX, "opt", "android-ndk") : "",
  ].filter(Boolean);
  for (const d of candidates) {
    if (fs.existsSync(path.join(d, "source.properties"))) return d;
  }
  return "";
}

function httpFetch(url, depth = 0) {
  if (typeof fetch === "function") return fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? nodeHttps : nodeHttp;
    const req = mod.get(url, { headers: BROWSER_HEADERS }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 5) {
        res.resume();
        return resolve(httpFetch(new URL(res.headers.location, url).toString(), depth + 1));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        text: () => Promise.resolve(Buffer.concat(chunks).toString("utf8")),
        arrayBuffer: () => Promise.resolve(Buffer.concat(chunks)),
        headers: { get: h => res.headers[h.toLowerCase()] ?? null },
      }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("timeout")); });
  });
}
/* ── WORKSPACE: projects saved on the builder ── */
const WORKSPACE_DIR = path.join(ROOT, "data", "workspace");
const WS_TEXT = /\.(html?|css|js|mjs|cjs|json|md|txt|xml|svg|webmanifest|ya?ml|toml|tsx?|jsx|vue|svelte|map|csv|ini|conf|properties|sh|kts?|java|gradle|cart)$/i;
function wsSafe(name) { return String(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project"; }
function wsListProjects() {
  if (!fs.existsSync(WORKSPACE_DIR)) return [];
  return fs.readdirSync(WORKSPACE_DIR).map(n => {
    const dir = path.join(WORKSPACE_DIR, n);
    if (!fs.statSync(dir).isDirectory()) return null;
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch {}
    return { name: meta.name || n, key: n, count: meta.count || 0, savedAt: meta.savedAt || 0 };
  }).filter(Boolean).sort((x, y) => (y.savedAt || 0) - (x.savedAt || 0));
}
function wsReadFiles(dir, budget = 12 * 1024 * 1024) {
  const files = {};
  const walk = d => {
    for (const n of fs.readdirSync(d)) {
      if (n === "meta.json" && d === dir) continue;
      const f = path.join(d, n), st = fs.statSync(f);
      if (st.isDirectory()) { walk(f); continue; }
      budget -= st.size; if (budget < 0) throw new Error("workspace project too large (>12 MB)");
      const rel = path.relative(dir, f).split(path.sep).join("/");
      if (WS_TEXT.test(n)) files[rel] = { text: fs.readFileSync(f, "utf8") };
      else files[rel] = { b64: fs.readFileSync(f).toString("base64") };
    }
  };
  walk(dir);
  return files;
}
function wsSaveFiles(dir, files, name) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const [rel, rec] of Object.entries(files)) {
    const safe = path.normalize(rel);
    if (safe.startsWith("..") || path.isAbsolute(safe)) continue;
    const f = path.join(dir, safe);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (rec.b64 !== undefined) fs.writeFileSync(f, Buffer.from(rec.b64, "base64"));
    else fs.writeFileSync(f, String(rec.text ?? ""), "utf8");
    count++;
  }
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name, count, savedAt: Date.now() }));
  return count;
}
function wsPersistBuild(projectDir) {
  let cfg = {};
  for (const n of ["valence.json", "cartridge.json"]) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(projectDir, n), "utf8")); break; } catch {}
  }
  const name = cfg.name || cfg.id || "project";
  const dir = path.join(WORKSPACE_DIR, wsSafe(name));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(projectDir, dir, { recursive: true });
  let count = 0;
  const walk = d => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); fs.statSync(f).isDirectory() ? walk(f) : count++; } };
  walk(dir);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name, count, savedAt: Date.now() }));
}

/* auto-detect the Android SDK the framework installed */
function detectSdk() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(os.homedir(), ".valence", "android-sdk"),
    path.join(os.homedir(), ".cartridge", "android-sdk"), // legacy install
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "platforms"))) return dir;
  }
  return "";
}

function say(msg) { console.log(`[valence] ${msg}`); }

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(data);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > limit) { reject(new Error("Upload exceeds 30 MB")); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/* accepts raw application/zip OR multipart/form-data with a zip part */
function pickZip(body, contentType) {
  if (!contentType.includes("multipart/form-data")) return body;
  const boundary = contentType.split("boundary=")[1]?.split(";")[0];
  if (!boundary) throw new Error("multipart boundary missing");
  const sep = Buffer.from(`--${boundary}`);
  let index = body.indexOf(sep), zip = null;
  while (index !== -1) {
    const next = body.indexOf(sep, index + sep.length);
    if (next === -1) break;
    const part = body.subarray(index + sep.length, next);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const head = part.subarray(0, headerEnd).toString();
      const data = part.subarray(headerEnd + 4, part.length - 2); // trim trailing \r\n
      if (/filename=/.test(head) && data.length > 4 && data.readUInt32LE(0) === 0x04034b50) { zip = data; break; }
    }
    index = next;
  }
  if (!zip) throw new Error("no ZIP file found in upload");
  return zip;
}

function runBuild(projectDir, output, sdk) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "build", projectDir, "--target", "apk", "--out", output, "--force"], {
      cwd: projectDir,
      env: { ...process.env, CI: "true", ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
    });
    let log = "";
    const append = c => { log = (log + c.toString()).slice(-120000); process.stdout.write(c); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Build exceeded 20 minutes")); }, 20 * 60 * 1000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("exit", code => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output)) resolve(log);
      else reject(Object.assign(new Error(`Build failed (exit ${code})`), { log }));
    });
  });
}

async function handleBuild(req, res) {
  if (TOKEN && (req.headers.authorization || "").replace(/^Bearer\s+/i, "") !== TOKEN) {
    return sendJson(res, 401, { error: "invalid builder token" });
  }
  if (building) return sendJson(res, 429, { error: "builder is busy; retry shortly" });
  building = true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valence-build-"));
  try {
    lastLog = "";
  const body = await readBody(req);
    const zip = pickZip(body, req.headers["content-type"] || "");
    const zipFile = path.join(root, "project.zip");
    fs.writeFileSync(zipFile, zip);
    const projectDir = path.join(root, "project");
    extractCart(zipFile, projectDir, { force: true });
    // HOTFIX 09-03: many project zips wrap everything in a single
    // top-level folder ("myapp/settings.gradle.kts"). extractCart keeps
    // the layout as-is, so hoist the contents up one level when — and
    // only when — the root has no Gradle file but the single subfolder
    // is a Gradle project. Web projects are never affected.
    const hasGradleRoot = d => fs.existsSync(path.join(d, "settings.gradle")) || fs.existsSync(path.join(d, "settings.gradle.kts"));
    if (!hasGradleRoot(projectDir)) {
      const top = fs.readdirSync(projectDir, { withFileTypes: true });
      if (top.length === 1 && top[0].isDirectory() && hasGradleRoot(path.join(projectDir, top[0].name))) {
        const inner = path.join(projectDir, top[0].name);
        for (const n of fs.readdirSync(inner)) fs.renameSync(path.join(inner, n), path.join(projectDir, n));
        fs.rmdirSync(inner);
        say(`unwrapped single top-level folder "${top[0].name}"/ → project root`);
        lastLog += `[valence] unwrapped single top-level folder "${top[0].name}"/ → project root\n`;
      }
    }
    const isOwnGradle = hasGradleRoot(projectDir);
    if (isOwnGradle) {
      say("own-Gradle project: building with the project's own Gradle files");
      lastLog += "[valence] own-Gradle project: APK id/version come from build.gradle.kts (valence.json is metadata only)\n";
      let hasNativeC = false;
      const scanC = d => {
        for (const n of fs.readdirSync(d)) {
          if (n === ".git" || n === "node_modules") continue;
          const f = path.join(d, n);
          const st = fs.statSync(f);
          if (st.isDirectory()) scanC(f);
          else if (/\.(c|cc|cpp)$/.test(n) || n === "CMakeLists.txt") hasNativeC = true;
        }
      };
      scanC(projectDir);
      if (hasNativeC) ensureArmCmake(detectSdk());
      let ndk0 = hasNativeC ? detectNdk() : "";
      if (hasNativeC && !ndk0 && process.env.PREFIX) {
        say("NDK missing — auto-installing termux-ndk (first time only, large download)...");
        lastLog += "[valence] NDK missing — auto-installing termux-ndk (first time only, large download)...\n";
        try {
          execSync(`sh "${path.join(FRAMEWORK, "setup-termux-ndk.sh")}"`, { stdio: "inherit", timeout: 25 * 60 * 1000 });
        } catch (e) {
          say("NDK auto-install failed: " + e.message);
          lastLog += "[valence] NDK auto-install failed: " + e.message + "\n";
        }
        ndk0 = detectNdk();
      }
      if (hasNativeC && !ndk0) throw new Error("project contains C/C++/CMake — NDK not installed: run sh setup-termux-ndk.sh");
      const sdk0 = detectSdk();
      const hasWrapper = fs.existsSync(path.join(projectDir, "gradlew"));
      let gradleBin = "";
      if (hasWrapper) {
        fs.chmodSync(path.join(projectDir, "gradlew"), 0o755);
        gradleBin = path.join(projectDir, "gradlew");
      } else {
        const cands = [
          process.env.PREFIX ? path.join(process.env.PREFIX, "bin", "gradle") : "",
          "/data/data/com.termux/files/usr/bin/gradle",
          "/usr/bin/gradle",
          "/usr/local/bin/gradle",
        ].filter(Boolean);
        const found = cands.find(c => fs.existsSync(c));
        if (found) gradleBin = found;
        else {
          const gdir = path.join(os.homedir(), ".valence", "gradle");
          const gbin = path.join(gdir, "gradle-8.7", "bin", "gradle");
          if (fs.existsSync(gbin)) gradleBin = gbin;
          else {
            say("no gradle wrapper/system gradle — auto-downloading Gradle 8.7 (~120MB, once)...");
            lastLog += "[valence] no gradle wrapper/system gradle — auto-downloading Gradle 8.7 (~120MB, once)...\n";
            execSync(`mkdir -p "${gdir}" && (wget -q -O "${gdir}/g.zip" https://services.gradle.org/distributions/gradle-8.7-bin.zip || curl -fsSL -o "${gdir}/g.zip" https://services.gradle.org/distributions/gradle-8.7-bin.zip) && (command -v unzip >/dev/null 2>&1 || pkg install -y unzip) && unzip -q -o "${gdir}/g.zip" -d "${gdir}" && chmod +x "${gbin}" && rm -f "${gdir}/g.zip"`, { stdio: "inherit", timeout: 25 * 60 * 1000 });
            if (fs.existsSync(gbin)) gradleBin = gbin;
          }
        }
      }

      if (!gradleBin) throw new Error("no gradle available (wrapper, system, or auto-provisioned)");
      if (sdk0 || ndk0) fs.writeFileSync(path.join(projectDir, "local.properties"), `${sdk0 ? `sdk.dir=${sdk0}\n` : ""}${ndk0 ? `ndk.dir=${ndk0}\n` : ""}`);
      let ndkVer = "";
      if (ndk0) {
        try {
          const m = fs.readFileSync(path.join(ndk0, "source.properties"), "utf8").match(/Pkg\.Revision\s*=\s*([\d.]+)/);
          if (m) ndkVer = m[1];
        } catch (e) { }
      }
      let initPath = "";
      if (ndkVer) {
        initPath = path.join(os.homedir(), ".valence", "ndk-align.gradle");
        fs.mkdirSync(path.dirname(initPath), { recursive: true });
        fs.writeFileSync(initPath, `allprojects { p ->
  p.plugins.withId("com.android.application") { p.android.ndkVersion = "${ndkVer}" }
  p.plugins.withId("com.android.library") { p.android.ndkVersion = "${ndkVer}" }
}
`);
      }
      const ogLog = await new Promise((resolve, reject) => {
        const gargs = ["assembleDebug", "--no-daemon"];
        if (initPath) gargs.push("-I", initPath);
        const child = spawn(gradleBin, gargs, {
          cwd: projectDir,
          env: { ...process.env, ANDROID_HOME: sdk0 || process.env.ANDROID_HOME || "", ANDROID_SDK_ROOT: sdk0 || process.env.ANDROID_SDK_ROOT || "", ANDROID_NDK_HOME: ndk0 || process.env.ANDROID_NDK_HOME || "" },
        });
        let lg = "";
        child.stdout.on("data", d => { lg += d; lastLog += d; });
        child.stderr.on("data", d => { lg += d; lastLog += d; });
        child.on("error", e => reject(Object.assign(new Error("gradle spawn failed: " + e.message), { log: lg })));
        child.on("close", code => (code === 0 ? resolve(lg) : reject(Object.assign(new Error("Build failed (exit " + code + ")"), { log: lg }))));
      });
      lastLog = ogLog;
      let apk = null;
      const findApk = d => {
        for (const n of fs.readdirSync(d)) {
          const f = path.join(d, n);
          const st = fs.statSync(f);
          if (st.isDirectory()) findApk(f);
          else if (n.endsWith(".apk") && f.includes(`${path.sep}debug${path.sep}`)) apk = apk || f;
        }
      };
      findApk(projectDir);
      if (!apk) { const e = new Error("gradle succeeded but no debug APK found under build/outputs/apk/debug"); e.log = lg; throw e; }
      const buf = fs.readFileSync(apk);
      res.writeHead(200, {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Length": buf.length,
        "Content-Disposition": 'attachment; filename="app.apk"',
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
    }
    if (!fs.existsSync(path.join(projectDir, "valence.json")) && !fs.existsSync(path.join(projectDir, "cartridge.json"))) {
      throw new Error("valence.json is required");
    }
    try { wsPersistBuild(projectDir); } catch (e) { say(`workspace save skipped: ${e.message}`); }
    let valMode = "";
    try { valMode = JSON.parse(fs.readFileSync(path.join(projectDir, fs.existsSync(path.join(projectDir, "valence.json")) ? "valence.json" : "cartridge.json"), "utf8")).mode || ""; } catch {}
    if (valMode !== "live" && !fs.existsSync(path.join(projectDir, "public", "index.html")) && !fs.existsSync(path.join(projectDir, "index.html"))) throw new Error("index.html is required (at root or public/)");
    const sdk = detectSdk();
    if (!sdk) throw new Error("Android SDK not found. Run the framework's setup-termux-android.sh once, or set ANDROID_HOME.");
    say(`building APK (sdk: ${sdk})`);
    const output = path.join(root, "app.apk");
    lastLog = await runBuild(projectDir, output, sdk);
    const apk = fs.readFileSync(output);
    res.writeHead(200, {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": apk.length,
      "Content-Disposition": 'attachment; filename="app.apk"',
      "Access-Control-Allow-Origin": "*",
    });
    res.end(apk);
    say(`APK sent (${(apk.length / 1048576).toFixed(2)} MB)`);
  } catch (error) {
    say(`build error: ${error.message}`);
    if (error.log) lastLog = `${error.log}\n${error.message}`;
    sendJson(res, 500, { error: error.message, log: (error.log || "").slice(-8000) });
  } finally {
    building = false;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const notFound = path.join(PUBLIC_DIR, "404.html");
    res.writeHead(404, { "Content-Type": "text/html" });
    return res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : "404");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).slice(1)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    });
    return res.end();
  }
  if (req.url.startsWith("/health")) {
    return sendJson(res, 200, { ok: true, builder: "valence-local", sdk: detectSdk() || null, busy: building });
  }
  if (req.method === "POST" && req.url.startsWith("/api/saveapk/")) {
    const name = wsSafe(decodeURIComponent(new URL(req.url, "http://x").pathname.slice("/api/saveapk/".length)));
    const buf = await readBody(req, 200 * 1024 * 1024);
    if (!buf.length) return sendJson(res, 400, { error: "empty apk" });
    const dir = path.join(WORKSPACE_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app.apk"), buf);
    return sendJson(res, 200, { ok: true, path: `workspace/${name}/app.apk`, size: buf.length });
  }
  if (req.method === "POST" && req.url.startsWith("/api/clone")) {
    let body;
    try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const provider = String(body.provider || "");
    const repo = String(body.repo || "");
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return sendJson(res, 400, { error: "repo must be owner/name" });
    const [o, r] = repo.split("/");
    const tries = {
      github: [`https://api.github.com/repos/${o}/${r}/zipball`],
      gitlab: [`https://gitlab.com/${o}/${r}/-/archive/HEAD/${r}-HEAD.zip`, `https://gitlab.com/${o}/${r}/-/archive/main/${r}-main.zip`, `https://gitlab.com/${o}/${r}/-/archive/master/${r}-master.zip`],
      codeberg: [`https://codeberg.org/${o}/${r}/archive/main.zip`, `https://codeberg.org/${o}/${r}/archive/master.zip`, `https://codeberg.org/${o}/${r}/archive/HEAD.zip`],
    }[provider];
    if (!tries) return sendJson(res, 400, { error: "unknown provider" });
    try {
      let buf = null;
      for (const url of tries) {
        const rr = await httpFetch(url);
        if (rr.ok) { buf = Buffer.from(await rr.arrayBuffer()); break; }
      }
      if (!buf) return sendJson(res, 502, { error: provider + " said no (private repo or wrong owner/name)" });
      if (buf.length > 60 * 1024 * 1024) return sendJson(res, 413, { error: "repo too large (>60 MB)" });
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "valence-clone-"));
      try {
        fs.writeFileSync(path.join(root, "repo.zip"), buf);
        const dir = path.join(root, "repo");
        extractCart(path.join(root, "repo.zip"), dir, { force: true });
        let base = dir;
        const top = fs.readdirSync(dir);
        if (top.length === 1 && fs.statSync(path.join(dir, top[0])).isDirectory()) base = path.join(dir, top[0]);
        return sendJson(res, 200, { provider, repo, files: wsReadFiles(base) });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }
  if (req.method === "POST" && req.url.startsWith("/api/crawl")) {
    let body;
    try { body = JSON.parse(await readBody(req, 1024 * 1024)); } catch { return sendJson(res, 400, { error: "bad json" }); }
    let u;
    try { u = new URL(/^https?:\/\//i.test(body.url || "") ? body.url : "https://" + (body.url || "")); }
    catch { return sendJson(res, 400, { error: "bad url" }); }
    try {
      let r = null;
      for (const t of urlTries(u)) { r = await httpFetch(t); if (r.ok) break; }
      if (!r || !r.ok) return sendJson(res, 502, { error: "site said " + (r ? r.status : "no response") + " — double-check the link" });
      const html = await r.text();
      const files = {};
      files["index.html"] = { text: html };
      const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"'#]+)["']/gi)].map(m => m[1]);
      const seen = new Set(["index.html"]);
      let count = 0;
      for (const ref of refs) {
        if (count >= 30) break;
        let ru;
        try { ru = new URL(ref, u.origin); } catch { continue; }
        if (ru.origin !== u.origin || !ru.protocol.startsWith("http")) continue;
        const name = decodeURIComponent(ru.pathname).replace(/^\/+/, "") || "index.html";
        if (seen.has(name) || name.startsWith("socket.io/")) continue;
        seen.add(name);
        const fr = await httpFetch(ru.toString());
        if (!fr.ok) continue;
        const buf = Buffer.from(await fr.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) continue;
        count++;
        if (/\.(png|jpe?g|webp|gif|ico|woff2?|mp3|mp4|webm)$/i.test(name)) files[name] = { b64: buf.toString("base64") };
        else files[name] = { text: buf.toString("utf8") };
      }
      return sendJson(res, 200, { origin: u.origin, files });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }
  if (req.method === "GET" && new URL(req.url, "http://x").pathname === "/api/workspace") {
    return sendJson(res, 200, { projects: wsListProjects() });
  }
  if (req.url.startsWith("/api/workspace/")) {
    const key = wsSafe(decodeURIComponent(new URL(req.url, "http://x").pathname.slice("/api/workspace/".length)));
    const dir = path.join(WORKSPACE_DIR, key);
    if (req.method === "GET") {
      if (!fs.existsSync(dir)) return sendJson(res, 404, { error: "no such workspace project" });
      try { return sendJson(res, 200, { name: key, files: wsReadFiles(dir) }); }
      catch (e) { return sendJson(res, 413, { error: e.message }); }
    }
    if (req.method === "POST") {
      const body = JSON.parse(await readBody(req, 30 * 1024 * 1024));
      if (!body || typeof body.files !== "object") return sendJson(res, 400, { error: "files object required" });
      const count = wsSaveFiles(dir, body.files, body.name || key);
      return sendJson(res, 200, { ok: true, count });
    }
  }
  if (req.method === "GET" && req.url.startsWith("/api/buildlog")) {
    return sendJson(res, 200, { log: lastLog });
  }
  if (req.method === "POST" && req.url.startsWith("/api/build")) return handleBuild(req, res);
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  sendJson(res, 405, { error: "method not allowed" });
});

function startListening(port, attemptsLeft) {
  server.once("error", error => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      say(`port ${port} is busy → trying ${port + 1}`);
      server.removeAllListeners("listening");
      startListening(port + 1, attemptsLeft - 1);
    } else {
      console.error(`[valence] cannot start: ${error.message}`);
      process.exit(1);
    }
  });
  server.listen(port, "0.0.0.0", () => {
    const sdk = detectSdk();
    say(`Valence Studio + Builder → http://localhost:${port}`);
    say(sdk ? `Android SDK: ${sdk}` : "Android SDK: NOT FOUND — builds will fail until setup-termux-android.sh is run");
  });
}
startListening(PORT, 20);
