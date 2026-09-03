import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8080);
const VALENCE_CLI = process.env.VALENCE_CLI || "/opt/valence/cli/valence.mjs";
const BUILDER_TOKEN = process.env.BUILDER_TOKEN || ""; // optional shared secret; empty = open
const MAX_UNPACKED = 100 * 1024 * 1024;
const app = express();
app.use(express.raw({ type: ["application/zip", "application/octet-stream"], limit: "30mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
let activeBuild = false;

function authenticate(req, res, next) {
  if (!BUILDER_TOKEN) return next();
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token !== BUILDER_TOKEN) return res.status(401).json({ error: "invalid builder token" });
  next();
}

function safeEntry(name) {
  const normalized = String(name).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some(part => !part || part === "." || part === "..")) return null;
  if (normalized === "valence.json" || normalized.startsWith("public/") || normalized.startsWith("resources/")) return normalized;
  return null;
}

async function extractProject(buffer, projectDir) {
  const archive = await unzipper.Open.buffer(buffer);
  if (archive.files.length > 5000) throw new Error("Too many archive entries");
  let total = 0;
  for (const entry of archive.files) {
    if (entry.type === "Directory") continue;
    const name = safeEntry(entry.path);
    if (!name) throw new Error(`Rejected archive path: ${entry.path}`);
    total += Number(entry.uncompressedSize || 0);
    if (total > MAX_UNPACKED) throw new Error("Unpacked project exceeds 100 MB");
    const destination = path.join(projectDir, ...name.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, await entry.buffer());
  }
  if (!fs.existsSync(path.join(projectDir, "public/index.html"))) throw new Error("public/index.html is required");
  if (!fs.existsSync(path.join(projectDir, "valence.json"))) throw new Error("valence.json is required");
}

function runBuild(projectDir, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VALENCE_CLI, "build", projectDir, "--target", "apk", "--out", output, "--force"], {
      cwd: projectDir,
      env: { ...process.env, CI: "true" },
    });
    let log = "";
    const append = chunk => { log = (log + chunk.toString()).slice(-120000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Build exceeded 12 minutes")); }, 12 * 60 * 1000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output)) resolve(log);
      else reject(new Error(`Gradle exited with ${code}\n${log.slice(-8000)}`));
    });
  });
}

app.get("/health", (_req, res) => res.json({ ok: true, builder: "valence", activeBuild }));
app.post("/api/build", authenticate, upload.single("project"), async (req, res) => {
  const zipBuffer = req.file?.buffer || (Buffer.isBuffer(req.body) && req.body.length ? req.body : null);
  if (!zipBuffer) return res.status(400).json({ error: "project ZIP is required" });
  if (activeBuild) return res.status(429).json({ error: "Builder is busy; retry shortly" });
  activeBuild = true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valence-studio-"));
  const projectDir = path.join(root, "project");
  const output = path.join(root, "app-debug.apk");
  try {
    fs.mkdirSync(projectDir, { recursive: true });
    await extractProject(zipBuffer, projectDir);
    await runBuild(projectDir, output);
    const config = JSON.parse(fs.readFileSync(path.join(projectDir, "valence.json"), "utf8"));
    const downloadName = String(config.name || "app").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "app";
    res.type("application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}.apk"`);
    res.sendFile(output, error => {
      fs.rmSync(root, { recursive: true, force: true });
      activeBuild = false;
      if (error && !res.headersSent) res.status(500).json({ error: error.message });
    });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    activeBuild = false;
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || "Invalid request" }));
app.listen(PORT, "0.0.0.0", () => console.log(`Valence builder listening on ${PORT}`));
