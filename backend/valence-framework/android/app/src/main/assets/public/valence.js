/**
 * Valence SDK — native Android APIs for packaged WebView applications (and the Lab simulator).
 *
 * In a real APK, the Kotlin kernel answers these calls.
 * In the Lab, an IndexedDB kernel stands in so you can feel the same API offline.
 */
(function (root, factory) {
  const api = factory(root);
  root.valence = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  const VERSION = "0.1.0";
  const PROTOCOL = "valence://app";

  const native =
    (root.ValenceNative && typeof root.ValenceNative.invoke === "function" && root.ValenceNative) ||
    (root.valenceNative && typeof root.valenceNative.invoke === "function" && root.valenceNative) ||
    null;

  const pending = new Map();
  let reqId = 0;
  let simReady = null;
  let simDb = null;

  function uid() {
    reqId += 1;
    return "c" + reqId.toString(36) + "_" + Date.now().toString(36);
  }

  function emitIpc(direction, payload) {
    const detail = { type: "valence:ipc", direction, payload, at: Date.now() };
    try {
      root.dispatchEvent(new CustomEvent("valence:ipc", { detail }));
    } catch (_) {}
    try {
      if (root.parent && root.parent !== root) {
        root.parent.postMessage(detail, "*");
      }
    } catch (_) {}
  }

  function normalizePath(p) {
    if (typeof p !== "string" || !p) throw err("EINVAL", "path required");
    let s = p.replace(/\\/g, "/");
    if (!s.startsWith("/")) s = "/" + s;
    const out = [];
    for (const part of s.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!out.length) throw err("EPERM", "path escapes sandbox");
        out.pop();
        continue;
      }
      out.push(part);
    }
    return "/" + out.join("/");
  }

  function err(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  /* ------------------------------------------------------------------ */
  /*  Simulator kernel (IndexedDB)                                       */
  /* ------------------------------------------------------------------ */

  const SEED = {
    "/app/index.html": {
      type: "file",
      mime: "text/html",
      body: "<!doctype html><title>Vault</title>",
    },
    "/app/valence.js": {
      type: "file",
      mime: "text/javascript",
      body: "/* bundled sdk */",
    },
    "/data/notes/welcome.md": {
      type: "file",
      mime: "text/markdown",
      body:
        "# Welcome to Valence\n\nThis note lives on the device.\nNot on a server. Not in a service-worker cache.\n\nTry airplane mode. We will still be here.\n",
    },
    "/data/notes/how-it-works.md": {
      type: "file",
      mime: "text/markdown",
      body:
        "# How this file exists\n\n1. Your HTML called `valence.fs.writeFile`.\n2. The SDK sent an IPC message.\n3. The kernel wrote bytes into the sandbox.\n4. No HTTP request left the phone.\n",
    },
    "/data/notes/davao.md": {
      type: "file",
      mime: "text/markdown",
      body:
        "# Saturday in Davao\n\n- Jackfruit from Bankerohan\n- Coffee in the afternoon rain\n- Finish the Valence lab\n",
    },
  };

  function openSim() {
    if (simReady) return simReady;
    simReady = new Promise((resolve, reject) => {
      if (!root.indexedDB) {
        simDb = memoryDb();
        return resolve(simDb);
      }
      const req = root.indexedDB.open("valence-fs-v1", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("nodes")) {
          db.createObjectStore("nodes", { keyPath: "path" });
        }
      };
      req.onsuccess = async () => {
        simDb = req.result;
        await seedIfEmpty(simDb);
        resolve(simDb);
      };
      req.onerror = () => {
        simDb = memoryDb();
        resolve(simDb);
      };
    });
    return simReady;
  }

  function memoryDb() {
    const map = new Map();
    return {
      _memory: map,
      transaction() {
        return {
          objectStore() {
            return {
              get: (path) => deferred(() => map.get(path)),
              put: (node) =>
                deferred(() => {
                  map.set(node.path, node);
                }),
              delete: (path) =>
                deferred(() => {
                  map.delete(path);
                }),
              getAll: () => deferred(() => Array.from(map.values())),
            };
          },
        };
      },
    };
  }

  function deferred(fn) {
    return {
      result: undefined,
      onsuccess: null,
      onerror: null,
      _run() {
        try {
          this.result = fn();
          this.onsuccess && this.onsuccess();
        } catch (e) {
          this.onerror && this.onerror(e);
        }
      },
    };
  }

  function txGet(db, path) {
    return new Promise((resolve, reject) => {
      if (db._memory) {
        resolve(db._memory.get(path) || null);
        return;
      }
      const tx = db.transaction("nodes", "readonly");
      const req = tx.objectStore("nodes").get(path);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function txPut(db, node) {
    return new Promise((resolve, reject) => {
      if (db._memory) {
        db._memory.set(node.path, node);
        resolve();
        return;
      }
      const tx = db.transaction("nodes", "readwrite");
      const req = tx.objectStore("nodes").put(node);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function txDel(db, path) {
    return new Promise((resolve, reject) => {
      if (db._memory) {
        db._memory.delete(path);
        resolve();
        return;
      }
      const tx = db.transaction("nodes", "readwrite");
      const req = tx.objectStore("nodes").delete(path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function txAll(db) {
    return new Promise((resolve, reject) => {
      if (db._memory) {
        resolve(Array.from(db._memory.values()));
        return;
      }
      const tx = db.transaction("nodes", "readonly");
      const req = tx.objectStore("nodes").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function seedIfEmpty(db) {
    const all = await txAll(db);
    if (all.length) return;
    const now = Date.now();
    const dirs = ["/app", "/data", "/data/notes", "/cache"];
    for (const d of dirs) {
      await txPut(db, { path: d, type: "dir", mtime: now, ctime: now });
    }
    for (const [path, meta] of Object.entries(SEED)) {
      await txPut(db, {
        path,
        type: "file",
        body: meta.body,
        mime: meta.mime,
        mtime: now,
        ctime: now,
        size: meta.body.length,
      });
    }
  }

  function parentDir(p) {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  }

  function basename(p) {
    const n = normalizePath(p);
    const i = n.lastIndexOf("/");
    return i === -1 ? n : n.slice(i + 1);
  }

  async function ensureDir(db, dir) {
    const p = normalizePath(dir);
    if (p === "/") return;
    const existing = await txGet(db, p);
    if (existing && existing.type === "dir") return;
    if (existing) throw err("ENOTDIR", p + " is not a directory");
    await ensureDir(db, parentDir(p));
    const now = Date.now();
    await txPut(db, { path: p, type: "dir", mtime: now, ctime: now });
  }

  const simKernel = {
    async "fs.readFile"({ path, encoding }) {
      const db = await openSim();
      const node = await txGet(db, normalizePath(path));
      if (!node) throw err("ENOENT", "no such file: " + path);
      if (node.type !== "file") throw err("EISDIR", path + " is a directory");
      if (encoding === "base64") return btoa(unescape(encodeURIComponent(node.body)));
      return node.body;
    },
    async "fs.writeFile"({ path, data, encoding }) {
      const db = await openSim();
      const p = normalizePath(path);
      if (p === "/app" || p.startsWith("/app/")) throw err("EROFS", "/app is read-only (packaged assets)");
      await ensureDir(db, parentDir(p));
      let body = data == null ? "" : String(data);
      if (encoding === "base64") {
        try {
          body = decodeURIComponent(escape(atob(body)));
        } catch (_) {
          throw err("EINVAL", "invalid base64");
        }
      }
      const now = Date.now();
      const prev = await txGet(db, p);
      await txPut(db, {
        path: p,
        type: "file",
        body,
        mime: "text/plain",
        mtime: now,
        ctime: prev ? prev.ctime : now,
        size: body.length,
      });
      return { bytes: body.length };
    },
    async "fs.readdir"({ path }) {
      const db = await openSim();
      const p = normalizePath(path);
      if (p !== "/") {
        const node = await txGet(db, p);
        if (!node) throw err("ENOENT", "no such directory: " + path);
        if (node.type !== "dir") throw err("ENOTDIR", path);
      }
      const all = await txAll(db);
      const prefix = p === "/" ? "/" : p + "/";
      const names = new Set();
      for (const n of all) {
        if (!n.path.startsWith(prefix)) continue;
        const rest = n.path.slice(prefix.length);
        if (!rest) continue;
        names.add(rest.split("/")[0]);
      }
      return Array.from(names).sort();
    },
    async "fs.mkdir"({ path }) {
      const db = await openSim();
      const p = normalizePath(path);
      if (p.startsWith("/app")) throw err("EROFS", "/app is read-only");
      await ensureDir(db, p);
      return { path: p };
    },
    async "fs.unlink"({ path }) {
      const db = await openSim();
      const p = normalizePath(path);
      if (p.startsWith("/app")) throw err("EROFS", "/app is read-only");
      const node = await txGet(db, p);
      if (!node) throw err("ENOENT", path);
      if (node.type === "dir") throw err("EISDIR", "use rmdir");
      await txDel(db, p);
      return { ok: true };
    },
    async "fs.rmdir"({ path }) {
      const db = await openSim();
      const p = normalizePath(path);
      if (p.startsWith("/app")) throw err("EROFS", "/app is read-only");
      const kids = await simKernel["fs.readdir"]({ path: p });
      if (kids.length) throw err("ENOTEMPTY", p);
      await txDel(db, p);
      return { ok: true };
    },
    async "fs.stat"({ path }) {
      const db = await openSim();
      const p = normalizePath(path);
      if (p === "/") return { path: p, isDirectory: true, isFile: false, size: 0, mtime: 0 };
      const node = await txGet(db, p);
      if (!node) throw err("ENOENT", path);
      return {
        path: p,
        isDirectory: node.type === "dir",
        isFile: node.type === "file",
        size: node.size || 0,
        mtime: node.mtime || 0,
        ctime: node.ctime || 0,
      };
    },
    async "fs.exists"({ path }) {
      try {
        await simKernel["fs.stat"]({ path });
        return true;
      } catch (e) {
        if (e.code === "ENOENT") return false;
        throw e;
      }
    },
    async "fs.rename"({ from, to }) {
      const data = await simKernel["fs.readFile"]({ path: from, encoding: "utf8" });
      await simKernel["fs.writeFile"]({ path: to, data, encoding: "utf8" });
      await simKernel["fs.unlink"]({ path: from });
      return { ok: true };
    },
    async "fs.tree"({ path }) {
      const db = await openSim();
      const rootPath = normalizePath(path || "/");
      const all = await txAll(db);
      return all
        .filter((n) => rootPath === "/" || n.path === rootPath || n.path.startsWith(rootPath + "/"))
        .map((n) => ({
          path: n.path,
          type: n.type,
          size: n.size || 0,
          mtime: n.mtime || 0,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    async "app.getInfo"() {
      return {
        name: "Valence Lab",
        id: "tech.nhz.valence.lab",
        version: VERSION,
        platform: "lab",
        webview: navigator.userAgent,
        protocol: PROTOCOL,
        offline: true,
        kernel: "simulator",
      };
    },
    async "app.getPath"({ name }) {
      const map = {
        app: "/app",
        userData: "/data",
        documents: "/data",
        notes: "/data/notes",
        cache: "/cache",
        tmp: "/cache",
      };
      if (!map[name]) throw err("EINVAL", "unknown path name: " + name);
      return map[name];
    },
    async "dialog.alert"({ message, title }) {
      root.alert((title ? title + "\n\n" : "") + (message || ""));
      return { ok: true };
    },
    async "notify.show"({ title, body }) {
      if (root.Notification && Notification.permission === "granted") {
        new Notification(title || "Valence", { body: body || "" });
      }
      return { ok: true, shown: !!(root.Notification && Notification.permission === "granted") };
    },
    async "permissions.status"({ name }) {
      return { name, state: "simulated" };
    },
    async "permissions.request"({ name }) {
      if (name === "notifications" && root.Notification && Notification.requestPermission) {
        return { name, state: await Notification.requestPermission() };
      }
      return { name, state: "simulated" };
    },
    async "db.open"({ name }) {
      return { name: /\\.db$/i.test(name) ? name : name + ".db", native: false, simulated: false };
    },
    async "db.close"({ name }) {
      return { name, closed: true };
    },
    async "db.exec"() {
      throw err("ENATIVE", "SQLite requires an Android build; use IndexedDB for browser-only development");
    },
    async "db.run"() {
      throw err("ENATIVE", "SQLite requires an Android build; use IndexedDB for browser-only development");
    },
    async "db.all"() {
      throw err("ENATIVE", "SQLite requires an Android build; use IndexedDB for browser-only development");
    },
    async "db.get"() {
      throw err("ENATIVE", "SQLite requires an Android build; use IndexedDB for browser-only development");
    },
  };

  /* ------------------------------------------------------------------ */
  /*  Invoke                                                             */
  /* ------------------------------------------------------------------ */

  function invokeNative(channel, method, args) {
    return new Promise((resolve, reject) => {
      const id = uid();
      const payload = { id, channel, method, args: args || {} };
      pending.set(id, { resolve, reject });
      emitIpc("renderer→kernel", payload);
      try {
        const raw = native.invoke(JSON.stringify(payload));
        if (typeof raw === "string" && raw.length) {
          // Synchronous JavascriptInterface path
          deliver(JSON.parse(raw));
        }
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  function deliver(msg) {
    if (!msg || !msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    emitIpc("kernel→renderer", msg);
    if (msg.ok) resolve(msg.result);
    else {
      const e = err(msg.error && msg.error.code ? msg.error.code : "EFAIL", (msg.error && msg.error.message) || "native error");
      reject(e);
    }
  }

  root.__valenceDeliver = deliver;

  if (root.chrome && root.chrome.webview && root.chrome.webview.addEventListener) {
    try {
      root.chrome.webview.addEventListener("message", (ev) => {
        try {
          deliver(typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data);
        } catch (_) {}
      });
    } catch (_) {}
  }

  async function invokeSim(channel, method, args) {
    const key = channel + "." + method;
    const fn = simKernel[key];
    const payload = { id: uid(), channel, method, args: args || {} };
    emitIpc("renderer→kernel", payload);
    if (!fn) {
      const fail = { id: payload.id, ok: false, error: { code: "ENOSYS", message: "no handler " + key } };
      emitIpc("kernel→renderer", fail);
      throw err("ENOSYS", "no handler " + key);
    }
    try {
      const result = await fn(args || {});
      emitIpc("kernel→renderer", { id: payload.id, ok: true, result });
      return result;
    } catch (e) {
      emitIpc("kernel→renderer", {
        id: payload.id,
        ok: false,
        error: { code: e.code || "EFAIL", message: e.message },
      });
      throw e;
    }
  }

  function invoke(channel, method, args) {
    if (native) return invokeNative(channel, method, args);
    return invokeSim(channel, method, args);
  }

  const fs = {
    readFile: (path, encoding) => invoke("fs", "readFile", { path, encoding: encoding || "utf8" }),
    writeFile: (path, data, encoding) => invoke("fs", "writeFile", { path, data, encoding: encoding || "utf8" }),
    readdir: (path) => invoke("fs", "readdir", { path }),
    mkdir: (path) => invoke("fs", "mkdir", { path }),
    unlink: (path) => invoke("fs", "unlink", { path }),
    rmdir: (path) => invoke("fs", "rmdir", { path }),
    stat: (path) => invoke("fs", "stat", { path }),
    exists: (path) => invoke("fs", "exists", { path }),
    rename: (from, to) => invoke("fs", "rename", { from, to }),
    tree: (path) => invoke("fs", "tree", { path: path || "/" }),
  };

  const path = {
    join: (...parts) =>
      normalizePath(
        parts
          .filter(Boolean)
          .join("/")
          .replace(/\/{2,}/g, "/")
      ),
    basename,
    dirname: parentDir,
    normalize: normalizePath,
  };

  const app = {
    getInfo: () => invoke("app", "getInfo", {}),
    getPath: (name) => invoke("app", "getPath", { name }),
  };

  const dialog = {
    alert: (message, title) => invoke("dialog", "alert", { message, title }),
  };

  const notify = {
    show: (title, body) => invoke("notify", "show", { title, body }),
  };

  const db = {
    async open(name) {
      if (typeof name !== "string" || !name.trim()) throw err("EINVAL", "database name required");
      const info = await invoke("db", "open", { name });
      const databaseName = info.name;
      return Object.freeze({
        name: databaseName,
        native: info.native !== false,
        exec: (sql, params) => invoke("db", "exec", { name: databaseName, sql, params: params || [] }),
        run: (sql, params) => invoke("db", "run", { name: databaseName, sql, params: params || [] }),
        all: (sql, params) => invoke("db", "all", { name: databaseName, sql, params: params || [] }),
        get: (sql, params) => invoke("db", "get", { name: databaseName, sql, params: params || [] }),
        close: () => invoke("db", "close", { name: databaseName }),
      });
    },
  };

  const permissions = {
    status: (name) => invoke("permissions", "status", { name }),
    async request(name) {
      const initial = await invoke("permissions", "request", { name });
      if (initial.state !== "prompted" || !native) return initial;
      return new Promise((resolve) => {
        const listener = (event) => {
          if (!event.detail || event.detail.name !== name) return;
          root.removeEventListener("valence:permission-result", listener);
          resolve(event.detail);
        };
        root.addEventListener("valence:permission-result", listener);
      });
    },
  };

  return {
    version: VERSION,
    protocol: PROTOCOL,
    isNative: !!native,
    kernel: native ? "android" : "simulator",
    invoke,
    fs,
    path,
    app,
    dialog,
    notify,
    db,
    permissions,
    ready: native ? Promise.resolve() : openSim().then(() => {}),
  };
});
