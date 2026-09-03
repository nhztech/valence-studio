#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { collectProjectEntries, extractCart, writeCart } from "./archive.mjs";
import { defaultConfig, loadProject, slug, writeJson } from "./project.mjs";
import { generateAndroidProject, printGoogleSignInSetup, runAndroidBuild } from "./android.mjs";

const VERSION = "0.1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

main().catch((error) => fail(error.message || String(error)));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) return launcherMenu();
    return usage();
  }
  if (command === "launcher") return launcherMenu();
  if (command === "main" || command === "menu") return interactiveMenu();
  if (command === "apk") return apkGeneratorCommand(args);
  if (["help", "--help", "-h"].includes(command)) return usage();
  if (["version", "--version", "-v"].includes(command)) return console.log(VERSION);
  if (command === "init") return initCommand(args);
  if (command === "validate") return validateCommand(args);
  if (command === "doctor") return doctorCommand(args);
  if (command === "pack") return packCommand(args);
  if (command === "unpack") return unpackCommand(args);
  if (command === "build") return buildCommand(args);
  if (command === "dev") return devCommand(args);
  fail(`unknown command: ${command}\nRun valence --help.`);
}

function usage() {
  console.log(`Valence Framework ${VERSION} — developed by NHZTech

Usage:
  valence                    Valence launcher
  valence launcher           Explicitly open launcher
  valence main               Project operations menu
  valence menu               Alias for valence main
  valence apk [project] [output.apk]
                               Direct directory-to-APK generator
  valence init [project] --name <name> --id <application-id>
  valence validate [project]
  valence doctor [project]
  valence dev [project] [--port 4173]
  valence pack [project] [--out app.cart]
  valence unpack <app.cart> [--out folder]
  valence build <project|app.cart> --target android|apk|aab [--out path]

Canonical project:
  project/
  ├── valence.json
  └── public/
      └── index.html

Examples:
  valence init . --name VIRN --id com.example.virn
  valence dev .
  valence pack . --out dist/VIRN.cart
  valence build . --target android --out VIRN-android

The CLI uses Node.js only as a development tool. Generated Android apps do not
contain Node.js or npm; they use Kotlin and the installed System WebView provider.
`);
}

function apkGeneratorCommand(args = []) {
  const script = path.join(ROOT, "valence-apk.sh");
  if (!fs.existsSync(script)) throw new Error(`APK generator missing: ${script}`);
  const shell = process.platform === "win32" ? "bash" : "bash";
  const result = spawnSync(shell, [script, ...args], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`APK generator exited with code ${result.status}`);
}

async function launcherMenu() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ansi = (code, text) => process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
  const green = (text) => ansi("1;36", text);
  const dim = (text) => ansi("2;36", text);
  const red = (text) => ansi("1;31", text);
  const ask = async (label) => (await rl.question(`${label}: `)).trim();
  const pause = async () => { await rl.question(dim("\nPress Enter to continue...")); };
  const confirm = async (label) => ["y", "yes"].includes((await ask(`${label} [y/N]`)).toLowerCase());

  try {
    while (true) {
      if (process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[H");
      console.log(green("               .-~~~~~-."));
      console.log(green("            .-~  .---.  ~-."));
      console.log(green("           /   ./     \\.   \\"));
      console.log(green("          :    | \\   / |    :"));
      console.log(green("          :    |  \\ /  |    :"));
      console.log(green("           \\   '.  V  .'   /"));
      console.log(green("            '-.  '---'  .-'"));
      console.log(green("               '-.....-'\n"));
      console.log(green("  __     ___    _     _____ _   _  ____ _____"));
      console.log(green("  \\ \\   / / \\  | |   | ____| \\ | |/ ___| ____|"));
      console.log(green("   \\ \\ / / _ \\ | |   |  _| |  \\| | |   |  _|"));
      console.log(green("    \\ V / ___ \\| |___| |___| |\\  | |___| |___"));
      console.log(green("     \\_/_/   \\_\\_____|_____|_| \\_|\\____|_____|"));
      console.log(dim(`\n  VALENCE FRAMEWORK // HYBRID ANDROID RUNTIME // ${VERSION}\n`));
      console.log("  1. MAIN");
      console.log("  2. INSTALL");
      console.log("  3. UPDATE");
      console.log("  4. REINSTALL");
      console.log("  5. DELETE");
      console.log("  6. EXIT\n");

      const choice = await ask(green("SELECT"));
      try {
        if (choice === "1") {
          rl.close();
          return interactiveMenu();
        }
        if (choice === "2") {
          const paths = installationPaths();
          if (fs.existsSync(paths.launcher) && fs.existsSync(paths.apkLauncher) && fs.existsSync(paths.root)) {
            console.log(dim(`\nAlready installed: ${paths.root}`));
            console.log(dim("Use UPDATE or REINSTALL."));
          } else {
            runInstaller(resolveInstallSource(paths));
            console.log(green("\nValence installed."));
          }
        } else if (choice === "3") {
          const paths = installationPaths();
          const source = resolveInstallSource(paths);
          if (!fs.existsSync(source)) throw new Error("Update source is unavailable. Download the latest release, then choose REINSTALL.");
          const gitDir = path.join(source, ".git");
          if (fs.existsSync(gitDir)) {
            console.log(dim("\nFetching source update..."));
            const result = spawnSync("git", ["-C", source, "pull", "--ff-only"], { stdio: "inherit" });
            if (result.error || result.status !== 0) throw result.error || new Error("git pull failed");
          } else {
            console.log(dim("\nNo Git metadata. Updating from the current source folder..."));
          }
          runInstaller(source);
          console.log(green("\nValence updated."));
        } else if (choice === "4") {
          const paths = installationPaths();
          const source = resolveInstallSource(paths);
          if (path.resolve(source) === path.resolve(paths.root)) {
            throw new Error("External source folder is unavailable. Extract the release ZIP and run sh valence.sh there.");
          }
          if (!fs.existsSync(path.join(source, "install.sh"))) throw new Error(`Installer not found in ${source}`);
          if (!await confirm(`Reinstall from ${source}?`)) {
            console.log(dim("Cancelled."));
          } else {
            runInstaller(source);
            console.log(green("\nValence reinstalled."));
          }
        } else if (choice === "5") {
          const paths = installationPaths();
          if (!fs.existsSync(paths.root) && !fs.existsSync(paths.launcher) && !fs.existsSync(paths.apkLauncher)) {
            console.log(dim("\nValence is not installed."));
          } else if (await confirm("Delete the installed Valence Framework?")) {
            fs.rmSync(paths.launcher, { force: true });
            fs.rmSync(paths.apkLauncher, { force: true });
            fs.rmSync(paths.root, { recursive: true, force: true });
            console.log(green("\nInstalled Valence deleted. Source files were not removed."));
            await pause();
            break;
          } else {
            console.log(dim("Cancelled."));
          }
        } else if (choice === "6" || choice === "0" || choice.toLowerCase() === "q") {
          break;
        } else {
          console.log(red("\nUnknown selection."));
        }
      } catch (error) {
        console.error(red(`\nERROR: ${error.message || error}`));
      }
      await pause();
    }
  } finally {
    rl.close();
  }
}

function installationPaths() {
  const prefix = process.env.PREFIX;
  if (prefix && fs.existsSync(path.join(prefix, "bin"))) {
    return {
      root: path.join(prefix, "lib", "valence-framework"),
      launcher: path.join(prefix, "bin", "valence"),
      apkLauncher: path.join(prefix, "bin", "valence-apk"),
    };
  }
  return {
    root: path.join(os.homedir(), ".local", "share", "valence-framework"),
    launcher: path.join(os.homedir(), ".local", "bin", "valence"),
    apkLauncher: path.join(os.homedir(), ".local", "bin", "valence-apk"),
  };
}

function resolveInstallSource(paths) {
  if (path.resolve(ROOT) !== path.resolve(paths.root)) return ROOT;
  const marker = path.join(paths.root, ".install-source");
  if (fs.existsSync(marker)) {
    const source = fs.readFileSync(marker, "utf8").trim();
    if (source) return source;
  }
  return ROOT;
}

function runInstaller(source) {
  const installer = path.join(source, "install.sh");
  if (!fs.existsSync(installer)) throw new Error(`Installer not found: ${installer}`);
  const result = spawnSync("sh", [installer], { stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) throw result.error || new Error(`installer exited with code ${result.status}`);
}

async function interactiveMenu() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const color = (code, text) => process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
  const green = (text) => color("1;36", text);
  const dim = (text) => color("2", text);
  const warning = (text) => color("1;33", text);
  const ask = async (label, fallback = "") => {
    const suffix = fallback ? ` ${dim(`[${fallback}]`)}` : "";
    const value = (await rl.question(`${label}${suffix}: `)).trim();
    return value || fallback;
  };
  const yes = async (label, fallback = false) => {
    const value = (await ask(`${label} ${fallback ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
    return value ? value === "y" || value === "yes" : fallback;
  };
  const pause = async () => { await rl.question(dim("\nPress Enter to return to VALENCE...")); };

  try {
    while (true) {
      if (process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[H");
      console.log(green("╔══════════════════════════════════════╗"));
      console.log(green("║            V A L E N C E             ║"));
      console.log(green(`║        FRAMEWORK ${VERSION.padEnd(20)}║`));
      console.log(green("╚══════════════════════════════════════╝"));
      console.log(dim("  HTML/CSS/JS → Android System WebView\n"));
      console.log("  1. BUILD APK");
      console.log("  2. GENERATE ANDROID PROJECT");
      console.log("  3. PREVIEW PROJECT");
      console.log("  4. SETUP / INITIALIZE PROJECT");
      console.log("  5. VALIDATE PROJECT");
      console.log("  6. CHECK BUILD ENVIRONMENT");
      console.log("  0. EXIT\n");

      const choice = await ask(green("SELECT"));
      try {
        if (choice === "0" || choice.toLowerCase() === "q") break;

        if (choice === "1") {
          rl.close();
          apkGeneratorCommand([]);
          return;
        } else if (choice === "2") {
          const projectPath = path.resolve(await ask("Project directory", "."));
          const project = loadProject(projectPath);
          const output = path.resolve(await ask("Android project output", path.join(os.homedir(), `${slug(project.config.name)}-android`)));
          const args = [projectPath, "--target", "android", "--out", output];
          if (fs.existsSync(output)) {
            if (!await yes("Output directory exists. Replace it?")) { console.log(warning("Cancelled.")); await pause(); continue; }
            args.push("--force");
          }
          generateAndroidFromMenu(args, output);
        } else if (choice === "3") {
          const projectPath = path.resolve(await ask("Project directory", "."));
          loadProject(projectPath);
          const port = await ask("Preview port", "4173");
          console.log(green(`\nStarting preview. Open http://localhost:${port}`));
          console.log(dim("Press Ctrl+C to stop.\n"));
          rl.close();
          devCommand([projectPath, "--port", port]);
          return;
        } else if (choice === "4") {
          const projectPath = path.resolve(await ask("Project directory", "."));
          const configFile = path.join(projectPath, "valence.json");
          if (fs.existsSync(configFile)) {
            console.log(warning(`\nAlready initialized: ${configFile}`));
          } else {
            const appName = await ask("Application name", path.basename(projectPath));
            const idTail = slug(appName).replaceAll("-", "") || "app";
            const appId = await ask("Android application ID", `com.nhztech.${idTail}`);
            const network = await yes("Does the app use Firebase or internet?");
            const args = [projectPath, "--name", appName, "--id", appId];
            if (network) args.push("--network");
            initCommand(args);
          }
        } else if (choice === "5") {
          const projectPath = path.resolve(await ask("Project directory", "."));
          console.log();
          validateCommand([projectPath]);
        } else if (choice === "6") {
          const projectPath = path.resolve(await ask("Project directory", "."));
          console.log();
          doctorCommand([projectPath]);
          process.exitCode = 0;
        } else {
          console.log(warning("Unknown selection."));
        }
      } catch (error) {
        console.error(color("1;31", `\nERROR: ${error.message || error}`));
      }
      await pause();
    }
  } finally {
    rl.close();
  }
}

function generateAndroidFromMenu(args, output) {
  console.log(greenMenu("\nGenerating Android project...\n"));
  buildCommand(args);
  console.log(greenMenu(`\nAndroid project ready: ${output}`));
}

function greenMenu(text) {
  return process.stdout.isTTY ? `\u001b[1;36m${text}\u001b[0m` : text;
}

function initCommand(argv) {
  const { positional, options } = parseArgs(argv, new Set(["name", "id", "network", "force"]));
  const projectDir = path.resolve(positional[0] || ".");
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
  const publicDir = path.join(projectDir, "public");
  const indexFile = path.join(publicDir, "index.html");
  if (!fs.existsSync(indexFile)) {
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(indexFile, starterHtml(options.name || path.basename(projectDir)));
    console.log(`created  ${relative(indexFile)}`);
  }
  const configFile = path.join(projectDir, "valence.json");
  if (fs.existsSync(configFile) && !options.force) fail(`valence.json already exists: ${configFile} (use --force)`);
  const config = defaultConfig(projectDir, {
    name: options.name,
    id: options.id,
    network: Boolean(options.network),
  });
  writeJson(configFile, config);
  console.log(`created  ${relative(configFile)}`);
  console.log(`project  ${projectDir}`);
  if (fs.existsSync(path.join(projectDir, "firebase.json"))) {
    console.log("note     firebase.json is Firebase Hosting configuration; Valence preserves it but does not treat it as native Firebase config.");
  }
  if (fs.existsSync(path.join(publicDir, "manifest.json"))) {
    console.log("note     public/manifest.json is your web/PWA manifest; valence.json controls the Android build.");
  }
  console.log(`\nNext: valence validate ${quote(projectDir)}`);
}

function validateCommand(argv) {
  const { positional } = parseArgs(argv, new Set());
  const project = loadProject(positional[0] || ".");
  console.log(`valid    ${project.config.name}`);
  console.log(`id       ${project.config.id}`);
  console.log(`entry    ${project.config.entry}`);
  console.log(`network  ${project.config.network.enabled ? "enabled" : "offline-only"}`);
  console.log(`public   ${project.publicDir}`);
}

function doctorCommand(argv) {
  const { positional } = parseArgs(argv, new Set());
  let failures = 0;
  check("Node.js >=18", Number(process.versions.node.split(".")[0]) >= 18, process.version);
  const java = commandVersion("java", ["-version"]);
  const javaMatch = java.text.match(/version\s+"(?:1\.)?(\d+)/i);
  const javaMajor = javaMatch ? Number(javaMatch[1]) : 0;
  check("Java 17+", java.ok && javaMajor >= 17, java.text || "not found");
  const gradle = commandVersion("gradle", ["--version"]);
  const wrapper = path.join(ROOT, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const gradleReady = gradle.ok || fs.existsSync(wrapper);
  check(
    "Gradle",
    gradleReady,
    gradle.ok ? firstLine(gradle.text) : fs.existsSync(wrapper) ? "bundled Gradle 8.7 wrapper" : "not found",
  );
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(os.homedir(), ".valence", "android-sdk");
  const sdkReady = fs.existsSync(path.join(sdk, "platforms", "android-34", "android.jar"));
  check("Android SDK", sdkReady, sdkReady ? sdk : `${sdk} is not configured`);
  try {
    const project = loadProject(positional[0] || ".");
    check("Valence project", true, `${project.config.name} (${project.config.id})`);
  } catch (error) {
    check("Valence project", false, error.message);
  }
  if (failures) process.exitCode = 1;

  function check(label, ok, detail) {
    console.log(`${ok ? "✓" : "!"} ${label.padEnd(20)} ${detail}`);
    if (!ok && label === "Valence project") failures++;
  }
}

function packCommand(argv) {
  const { positional, options } = parseArgs(argv, new Set(["out", "force"]));
  const project = loadProject(positional[0] || ".");
  const output = path.resolve(options.out || path.join(project.root, "dist", `${slug(project.config.name)}.cart`));
  if (fs.existsSync(output) && !options.force) fail(`output already exists: ${output} (use --force)`);
  const entries = collectProjectEntries(project.root, [
    "valence.json",
    "public",
    "resources",
    "native",
    "plugins",
  ]);
  writeCart(entries, output);
  console.log(`packed   ${entries.length} files`);
  console.log(`archive  ${output}`);
  console.log("format   ZIP-compatible .cart (portable source package; not embedded as a second archive in the APK)");
}

function unpackCommand(argv) {
  const { positional, options } = parseArgs(argv, new Set(["out", "force"]));
  if (!positional[0]) fail("usage: valence unpack <app.cart> [--out folder]");
  const input = path.resolve(positional[0]);
  const output = path.resolve(options.out || path.basename(input, path.extname(input)));
  const count = extractCart(input, output, { force: Boolean(options.force) });
  loadProject(output);
  console.log(`unpacked ${count} files`);
  console.log(`project  ${output}`);
}

function buildCommand(argv) {
  const { positional, options } = parseArgs(argv, new Set(["target", "out", "force"]));
  if (!positional[0]) fail("usage: valence build <project|app.cart> --target android|apk|aab");
  const source = path.resolve(positional[0]);
  const target = options.target || "android";
  if (!["android", "apk", "aab"].includes(target)) fail(`unknown target: ${target}`);

  let temporaryProject = null;
  let temporaryAndroid = null;
  let projectDir = source;
  const sourceIsCart = source.toLowerCase().endsWith(".cart");
  if (sourceIsCart) {
    temporaryProject = fs.mkdtempSync(path.join(os.tmpdir(), "valence-project-"));
    extractCart(source, temporaryProject);
    projectDir = temporaryProject;
  }
  try {
    const project = loadProject(projectDir);
    const defaultAndroid = sourceIsCart
      ? path.resolve(`${slug(project.config.name)}-android`)
      : path.join(project.root, `${slug(project.config.name)}-android`);
    let androidOutput;
    if (target === "android") {
      androidOutput = options.out ? path.resolve(options.out) : defaultAndroid;
    } else {
      // APK/AAB builds use private temporary storage. This is important on
      // Android/Termux because shared storage is mounted noexec.
      temporaryAndroid = fs.mkdtempSync(path.join(os.tmpdir(), "valence-android-"));
      androidOutput = temporaryAndroid;
    }
    generateAndroidProject({
      frameworkRoot: ROOT,
      project,
      outputDir: androidOutput,
      force: target === "android" ? Boolean(options.force) : true,
    });
    console.log(`generated ${androidOutput}`);
    console.log(`entry     app/src/main/assets/public/index.html`);
    console.log(`engine    Android System WebView (Chromium provider)`);
    if (target === "android") {
      console.log(`\nOpen ${androidOutput} in Android Studio and press Run.`);
      return;
    }
    const finalOutput = options.out
      ? path.resolve(options.out)
      : path.resolve("dist", `${slug(project.config.name)}.${target}`);
    if (fs.existsSync(finalOutput) && !options.force) {
      throw new Error(`output already exists: ${finalOutput} (use --force to replace it)`);
    }
    const wantGoogle = Boolean(project.config.google && project.config.google.webClientId);
    const artifact = runAndroidBuild(androidOutput, target);
    fs.mkdirSync(path.dirname(finalOutput), { recursive: true });
    fs.copyFileSync(artifact, finalOutput);
    console.log(`artifact  ${finalOutput}`);
    if (wantGoogle) printGoogleSignInSetup(project.config, finalOutput);
  } finally {
    if (temporaryAndroid) fs.rmSync(temporaryAndroid, { recursive: true, force: true });
    if (temporaryProject) fs.rmSync(temporaryProject, { recursive: true, force: true });
  }
}

function devCommand(argv) {
  const { positional, options } = parseArgs(argv, new Set(["port"]));
  const project = loadProject(positional[0] || ".");
  const port = Number(options.port || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port: ${options.port}`);
  const sdk = fs.readFileSync(path.join(ROOT, "sdk/valence.js"));
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://localhost");
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname === "/valence.js") return send(response, 200, sdk, "text/javascript; charset=utf-8");
      if (pathname === "/") pathname = "/index.html";
      const relativeName = pathname.replace(/^\/+/, "");
      const file = path.resolve(project.publicDir, ...relativeName.split("/"));
      if (file !== project.publicDir && !file.startsWith(`${project.publicDir}${path.sep}`)) return send(response, 403, "Forbidden", "text/plain");
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(response, 404, "Not found", "text/plain");
      let body = fs.readFileSync(file);
      if (file.endsWith(".html")) body = Buffer.from(injectSdk(body.toString("utf8")));
      send(response, 200, body, mime(file));
    } catch (error) {
      send(response, 500, error.message, "text/plain");
    }
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`Valence dev server for ${project.config.name}`);
    console.log(`public   ${project.publicDir}`);
    console.log(`url      http://localhost:${port}`);
    console.log("kernel   browser simulator (native SQLite/permissions require the Android build)");
    console.log("\nPress Ctrl+C to stop.");
  });
}

function parseArgs(argv, allowed) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!allowed.has(key)) fail(`unknown option: --${key}`);
    if (["force", "network"].includes(key)) options[key] = true;
    else {
      const next = argv[++i];
      if (next == null || next.startsWith("--")) fail(`--${key} needs a value`);
      options[key] = next;
    }
  }
  return { positional, options };
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: !result.error && result.status === 0,
    text: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function firstLine(value) {
  return String(value).split(/\r?\n/).find((line) => line.trim()) || "available";
}

function injectSdk(html) {
  if (/\bsrc\s*=\s*["'][^"']*valence\.js(?:[?#][^"']*)?["']/i.test(html)) return html;
  const tag = '    <script src="/valence.js"></script>\n';
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}\n${tag}`)
    : `${tag}${html}`;
}

function send(response, status, body, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[ext] || "application/octet-stream"
  );
}

function starterHtml(name) {
  const safe = String(name).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>${safe}</title>\n</head>\n<body>\n  <h1>${safe}</h1>\n</body>\n</html>\n`;
}

function quote(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function relative(file) {
  return path.relative(process.cwd(), file) || ".";
}

function fail(message) {
  console.error(`valence: ${message}`);
  process.exit(1);
}
