import fs from "node:fs";
import path from "node:path";

export const FORMAT_VERSION = 1;
export const CAPABILITIES = new Set([
  "filesystem",
  "database",
  "dialogs",
  "notifications",
  "camera",
  "microphone",
  "location",
]);
export const PERMISSIONS = new Set([
  "camera",
  "microphone",
  "location",
  "notifications",
  "bluetooth",
]);

export function slug(value) {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "app";
}

export function defaultConfig(projectDir, options = {}) {
  const webManifest = readJsonIfExists(path.join(projectDir, "public/manifest.json"));
  const inferredName = options.name || webManifest?.name || webManifest?.short_name || path.basename(projectDir);
  const idTail = slug(inferredName).replaceAll("-", "");
  return {
    format: FORMAT_VERSION,
    name: inferredName,
    id: options.id || `tech.nhz.${idTail}`,
    version: "1.0.0",
    versionCode: 1,
    entry: "public/index.html",
    capabilities: ["filesystem", "database", "dialogs"],
    permissions: [],
    network: {
      enabled: Boolean(options.network),
      allow: options.network ? ["*"] : [],
    },
    android: {
      minSdk: 24,
      targetSdk: 34,
    },
  };
}

export function loadProject(projectDir) {
  const root = path.resolve(projectDir);
  let configFile = path.join(root, "valence.json");
  if (!fs.existsSync(configFile)) {
    const legacy = path.join(root, "cartridge.json");
    if (fs.existsSync(legacy)) configFile = legacy; // legacy Cartridge project support
    else throw new Error(`valence.json missing in ${root}; run valence init first`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (error) {
    throw new Error(`invalid valence.json: ${error.message}`);
  }
  validateConfig(config, root);
  const publicDir = path.join(root, path.dirname(config.entry || "public/index.html"));
  return { root, config, configFile, publicDir };
}

export function validateConfig(config, projectDir) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("valence.json must be an object");
  if (config.format !== FORMAT_VERSION) throw new Error(`unsupported valence format: ${config.format}`);
  if (typeof config.name !== "string" || !config.name.trim()) throw new Error("valence.json: name is required");
  if (!isApplicationId(config.id)) throw new Error(`valence.json: invalid Android application id: ${config.id}`);
  if (typeof config.version !== "string" || !/^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/.test(config.version)) {
    throw new Error("Incomplete Version Name. x.x.x is needed!");
  }
  if (!Number.isInteger(config.versionCode) || config.versionCode < 1) throw new Error("valence.json: versionCode must be a positive integer");
  if (config.mode !== undefined && !["bundled", "live", "hybrid", "native"].includes(config.mode)) {
    throw new Error("valence.json: mode must be bundled, live, hybrid or native");
  }
  if (config.mode === "native" && config.native !== undefined) {
    if (typeof config.native !== "object") throw new Error("valence.json: native must be an object");
    const n = config.native;
    if (n.mainActivity !== undefined && typeof n.mainActivity !== "string") throw new Error("valence.json: native.mainActivity must be a string class name");
    if (n.sourceRoot !== undefined && typeof n.sourceRoot !== "string") throw new Error("valence.json: native.sourceRoot must be a string path");
    if (n.sourceDirs !== undefined) {
      if (typeof n.sourceDirs !== "object") throw new Error("valence.json: native.sourceDirs must be an object");
      for (const k of ["code", "res", "assets"]) {
        if (n.sourceDirs[k] !== undefined && typeof n.sourceDirs[k] !== "string") throw new Error(`valence.json: native.sourceDirs.${k} must be a string`);
      }
    }
  }
  if (config.mode === "live" || config.mode === "hybrid") {
    if (typeof config.liveUrl !== "string" || !/^https:\/\/[^\s]+$/.test(config.liveUrl)) {
      throw new Error("valence.json: " + config.mode + " mode requires https liveUrl");
    }
  }
  const entry = safeRelative(config.entry || "public/index.html");
  if (!entry.endsWith(".html") || entry.startsWith("..") || path.isAbsolute(entry)) {
    throw new Error("valence.json: entry must be a relative .html path");
  }
  if (config.mode !== "live" && config.mode !== "native" && !fs.existsSync(path.join(projectDir, ...entry.split("/")))) throw new Error(`entry file missing: ${entry}`);

  if (config.network && config.network.backend !== undefined && typeof config.network.backend !== "string") {
    throw new Error("valence.json: network.backend must be a string url");
  }
  const capabilities = config.capabilities ?? [];
  if (!Array.isArray(capabilities)) throw new Error("valence.json: capabilities must be an array");
  for (const value of capabilities) if (!CAPABILITIES.has(value)) throw new Error(`unknown capability: ${value}`);

  const permissions = config.permissions ?? [];
  if (!Array.isArray(permissions)) throw new Error("valence.json: permissions must be an array");
  for (const value of permissions) if (!PERMISSIONS.has(value)) throw new Error(`unknown permission: ${value}`);

  if (typeof config.network === "boolean") config.network = { enabled: config.network, allow: [] };
  if (!config.network || typeof config.network !== "object") throw new Error("valence.json: network must be an object");
  if (typeof config.network.enabled !== "boolean") throw new Error("valence.json: network.enabled must be boolean");
  if (
    !Array.isArray(config.network.allow) ||
    config.network.allow.some(
      (host) =>
        typeof host !== "string" ||
        host !== "*" &&
        !/^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host),
    )
  ) {
    throw new Error("valence.json: network.allow must contain host names, *.domain patterns, or *");
  }
  if (!config.network.enabled && config.network.allow.length) throw new Error("network.allow requires network.enabled=true");

  if (!config.android || typeof config.android !== "object") config.android = { minSdk: 24, targetSdk: 34 };
  if (!Number.isInteger(config.android.minSdk) || config.android.minSdk < 24) throw new Error("android.minSdk must be at least 24");
  if (!Number.isInteger(config.android.targetSdk) || config.android.targetSdk < config.android.minSdk) {
    throw new Error("android.targetSdk must be an integer not lower than minSdk");
  }
  return config;
}

export function isApplicationId(value) {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value);
}

export function safeRelative(value) {
  if (typeof value !== "string") throw new Error("path must be a string");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe project path: ${value}`);
  }
  return normalized;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
