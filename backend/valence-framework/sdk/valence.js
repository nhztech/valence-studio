/* ── VALENCE ORIGIN BRIDGE: same-origin calls → configured backend (no user edits needed) ── */
(function () {
  try {
    var B = window.__valenceBackend;
    if (!B) return;
    var bo = new URL(B);
    var app = location.origin;
    function fix(u) {
      try {
        var url = new URL(u, location.href);
        if (url.origin === app && url.protocol.startsWith("http")) {
          url.protocol = bo.protocol;
          url.host = bo.host;
          return url.href;
        }
      } catch (e) {}
      return u;
    }
    var of = window.fetch;
    if (of) window.fetch = function (i, o) { return of.call(window, typeof i === "string" ? fix(i) : i, o); };
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { if (typeof u === "string") arguments[1] = fix(u); return ox.apply(this, arguments); };
    var OW = window.WebSocket;
    if (OW) {
      window.WebSocket = function (u, p) {
        var nu = typeof u === "string" ? fix(u).replace(/^http/, "ws") : u;
        return p !== undefined ? new OW(nu, p) : new OW(nu);
      };
      window.WebSocket.prototype = OW.prototype;
      window.WebSocket.CONNECTING = OW.CONNECTING;
      window.WebSocket.OPEN = OW.OPEN;
      window.WebSocket.CLOSING = OW.CLOSING;
      window.WebSocket.CLOSED = OW.CLOSED;
    }
  } catch (e) {}
})();
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

  const google = {
    /**
     * Native Google account picker. Requires google.webClientId in valence.json.
     * Resolves with { idToken, email, name } for Firebase signInWithCredential().
     */
    signIn: () =>
      new Promise((resolve, reject) => {
        if (!native) {
          reject(new Error("valence.google.signIn() is only available inside the APK"));
          return;
        }
        const listener = (event) => {
          root.removeEventListener("valence:google-signin", listener);
          const detail = event.detail || {};
          if (detail.ok) resolve(detail);
          else reject(new Error(detail.error || "google-signin-failed"));
        };
        root.addEventListener("valence:google-signin", listener);
        Promise.resolve(invoke("google", "signIn", {})).catch((error) => {
          root.removeEventListener("valence:google-signin", listener);
          reject(error);
        });
      }),
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
    google,
    ready: native ? Promise.resolve() : openSim().then(() => {}),
  };
});

/* ── VALENCE OFFLINE MIRROR v2: data organized per extracted variable map ──
   stores: ep = endpoint responses (fetch/XHR) · ev = socket event payloads · st = storage snapshot
   map bundled at assets/valence-datamap.json (events/endpoints/storage extracted at build time) */
(function () {
  try {
    var SKIP = /socket\.io|appassets\.androidplatform\.net|gstatic|jsdelivr|unpkg|cdnjs|fonts\.googleapis\.com/;
    /* real reachability probe — navigator.onLine lies on Android */
    var UP = navigator.onLine !== false;
    var PING_BASE = (typeof window !== "undefined" && window.__valenceBackend) || location.origin;
    function ping() {
      var t = new Promise(function (r) { setTimeout(function () { r("timeout"); }, 2500); });
      var f = fetch(PING_BASE + "/?__vping=" + Date.now(), { method: "HEAD", mode: "no-cors", cache: "no-store" }).then(function () { return "ok"; }, function () { return "fail"; });
      Promise.race([t, f]).then(function (r) { UP = (r === "ok"); });
    }
    ping(); setInterval(ping, 4000);
    function isUp() { return UP; }
    /* offline + cached server data → app "believes" it is online (login bypass) */
    try {
      db().then(function (d) {
        return new Promise(function (res) {
          var c = d.transaction("ep").objectStore("ep").openCursor();
          c.onsuccess = function () {
            if (c.result && !UP) {
              try { Object.defineProperty(navigator, "onLine", { configurable: true, get: function () { return true; } }); } catch (e) {}
            }
            res();
          };
        });
      }).catch(function () {});
    } catch (e) {}
    try { window.__vSetOnline = function (v) { UP = !!v; }; } catch (e) {}
    function db() { return new Promise(function (res, rej) { var q = indexedDB.open("valence-sync2", 1); q.onupgradeneeded = function () { q.result.createObjectStore("ep"); q.result.createObjectStore("ev"); q.result.createObjectStore("st"); }; q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }
    function put(store, k, v) { return db().then(function (d) { return new Promise(function (r, j) { var t = d.transaction(store, "readwrite"); t.objectStore(store).put(v, k); t.oncomplete = r; t.onerror = j; }); }).catch(function () {}); }
    function get(store, k) { return db().then(function (d) { return new Promise(function (r, j) { var q = d.transaction(store).objectStore(store).get(k); q.onsuccess = function () { r(q.result); }; q.onerror = j; }); }).catch(function () { return null; }); }
    function key(m, u, b) { return m + " " + u + (b ? " #" + b.slice(0, 80) : ""); }
    function lookup(k, alt) { return get("ep", k).then(function (h) { return h || (alt ? get("ep", alt) : null); }); }
    /* fetch → ep store */
    var of = window.fetch;
    if (of) window.fetch = function (i, o) {
      var url = typeof i === "string" ? i : (i && i.url) || "";
      var m = ((o && o.method) || "GET").toUpperCase();
      var body = o && o.body ? String(o.body) : "";
      if (SKIP.test(url) || url.indexOf("http") !== 0) return of.apply(this, arguments);
      var k = key(m, url, body);
      if (!isUp()) {
        return lookup(k, m === "GET" ? null : "GET " + url).then(function (hit) {
          if (hit) return new Response(hit.b, { status: hit.s || 200, headers: { "Content-Type": hit.ct || "application/json", "X-Valence-Offline": "1" } });
          if (m !== "GET") return put("ep", k + " ~outbox", { b: body, t: Date.now() }).then(function () { return new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "X-Valence-Offline": "1" } }); });
          throw new TypeError("offline");
        });
      }
      return of.apply(this, arguments).then(function (r) {
        try {
          var ct = r.headers.get("content-type") || "";
          if (/json|text/.test(ct)) r.clone().text().then(function (c) {
            if (c.length < 1500000) {
              var rec = { s: r.status, ct: ct, b: c, t: Date.now() };
              put("ep", k, rec);
              if (m === "GET") put("ep", "GET " + url, rec);
            }
          }).catch(function () {});
        } catch (e) {}
        return r;
      }, function (err) {
        return lookup(k, m === "GET" ? null : "GET " + url).then(function (hit) {
          if (hit) return new Response(hit.b, { status: hit.s || 200, headers: { "Content-Type": hit.ct || "application/json", "X-Valence-Offline": "1" } });
          if (m !== "GET") return put("ep", k + " ~outbox", { b: body, t: Date.now() }).then(function () { return new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "X-Valence-Offline": "1" } }); });
          throw err;
        }).then(function (r2) { if (r2) return r2; throw err; });
      });
    };
    /* XHR → ep store */
    var OX = XMLHttpRequest.prototype.open, OS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__vm = String(m || "GET").toUpperCase(); this.__vu = String(u); return OX.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      var x = this;
      var k = key(x.__vm || "GET", x.__vu || "", b ? String(b) : "");
      if (!x.__vu || SKIP.test(x.__vu)) return OS.apply(this, arguments);
      x.addEventListener("load", function () {
        try { var ct = x.getResponseHeader("content-type") || ""; if (/json|text/.test(ct) && (x.responseText || "").length < 1500000) put("ep", k, { s: x.status, ct: ct, b: x.responseText, t: Date.now() }); } catch (e) {}
      });
      x.addEventListener("error", function () {
        get("ep", k).then(function (hit) {
          if (!hit) return;
          Object.defineProperty(x, "readyState", { value: 4 });
          Object.defineProperty(x, "status", { value: hit.s || 200 });
          Object.defineProperty(x, "responseText", { value: hit.b });
          Object.defineProperty(x, "response", { value: hit.b });
          setTimeout(function () { x.onreadystatechange && x.onreadystatechange(); x.onload && x.onload(); }, 0);
        });
      });
      return OS.apply(this, arguments);
    };
    /* socket.io: ONLINE → record pushes + acks per event · OFFLINE → fake socket
       (login/data replayed locally; realtime sends → NO INTERNET overlay) */
    var SENDS = null;
    try { fetch("valence-datamap.json").then(function (r) { return r.json(); }).then(function (m) { SENDS = (m && m.sends) || null; }).catch(function () {}); } catch (e) {}
    function isRealtime(ev) {
      if (/^(message|typing|react|edit|delete|call-invite|call-accept|call-decline|call-cancel|call-end|call-signal)$/.test(ev)) return true;
      return false;
    }
    function noNetOverlay() {
      if (document.getElementById("valenceNoNet")) return;
      var d = document.createElement("div"); d.id = "valenceNoNet";
      d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(7,9,19,.94);display:grid;place-items:center;text-align:center;font-family:monospace;color:#8da0bd";
      d.innerHTML = '<div><h1 style="color:#eaf8ff;font-size:18px;letter-spacing:.1em;margin:0">NO INTERNET CONNECTION</h1><p>Real-time needs the live server.</p><button style="margin-top:14px;padding:10px 30px;border:0;border-radius:0;background:linear-gradient(135deg,#28f3ff,#229cff);color:#00111f;font-weight:800;letter-spacing:.2em" onclick="this.parentNode.parentNode.remove()">OK</button></div>';
      document.body.appendChild(d);
    }
    var OIO = window.io;
    if (OIO) window.io = function () {
      if (!isUp()) {
        var fake = {
          id: "offline", connected: true, disconnected: false,
          on: function (ev, fn) { if (ev === "connect") setTimeout(function () { fn && fn(); }, 0); return fake; },
          once: function (ev, fn) { return fake.on(ev, fn); },
          off: function () { return fake; }, removeListener: function () { return fake; },
          emit: function (ev, payload, ack) {
            if (isRealtime(ev) || (SENDS && SENDS.indexOf(ev) >= 0 && /^(message|typing|react|call-)/.test(ev))) { noNetOverlay(); return fake; }
            if (typeof ack === "function") {
              get("ev", "ack:" + ev).then(function (hit) { if (hit) setTimeout(function () { ack(hit.p); }, 0); });
            }
            return fake;
          },
          send: function () { return fake; }, volatile: { emit: function () { return fake; } },
          disconnect: function () { return fake; }, close: function () { return fake; }, join: function () { return fake; },
        };
        return fake;
      }
      var sock = OIO.apply(this, arguments);
      try {
        var OON = sock.on.bind(sock), OEM = sock.emit.bind(sock);
        sock.on = function (ev, fn) {
          if (typeof fn === "function" && typeof ev === "string") {
            return OON(ev, function (p) {
              try {
                get("ev", ev).then(function (rec) {
                  var list = (rec && rec.list) || [];
                  list.push({ t: Date.now(), p: p });
                  if (list.length > 100) list = list.slice(-100);
                  put("ev", ev, { list: list });
                });
              } catch (e) {}
              return fn.apply(this, arguments);
            });
          }
          return OON(ev, fn);
        };
        sock.emit = function (ev, payload, ack) {
          if (typeof ack === "function") {
            var w = function (r) { try { put("ev", "ack:" + ev, { t: Date.now(), p: r }); } catch (e) {} return ack.apply(this, arguments); };
            return OEM(ev, payload, w);
          }
          return OEM.apply(this, arguments);
        };
      } catch (e) {}
      return sock;
    };
    /* localStorage → st snapshot + offline session protection */
    try {
      var OLS = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (k, v) { try { put("st", String(k), { v: String(v).slice(0, 500000), t: Date.now() }); } catch (e) {} return OLS(k, v); };
      var OCLR = localStorage.clear.bind(localStorage);
      var ORM = localStorage.removeItem.bind(localStorage);
      localStorage.clear = function () { if (isUp()) return OCLR(); };
      localStorage.removeItem = function (k) { if (isUp()) return ORM(k); };
    } catch (e) {}
    /* native session snapshot: dump localStorage so cold offline starts restore it */
    function dumpSession() {
      try {
        if (!window.ValenceNative) return;
        var items = {}; var n = 0;
        for (var i = 0; i < localStorage.length; i++) {
          var kk = localStorage.key(i); var vv = localStorage.getItem(kk) || "";
          if (n + vv.length > 1500000) break;
          items[kk] = vv; n += vv.length;
        }
        window.ValenceNative.invoke(JSON.stringify({ id: "dump" + Date.now(), channel: "sys", method: "stDump", args: { json: JSON.stringify({ items: items }) } }));
      } catch (e) {}
    }
    setInterval(dumpSession, 5000);
    try { window.addEventListener("pagehide", dumpSession); } catch (e) {}
    /* WebSocket offline stub */
    var OW = window.WebSocket;
    if (OW) {
      window.WebSocket = function (u, p) {
        if (!isUp()) {
          var stub = { readyState: 3, bufferedAmount: 0, url: u, close: function () {}, send: function () {}, addEventListener: function (t, f) { if (t === "close" || t === "error") setTimeout(function () { f && f({ type: t, target: stub }); }, 0); }, removeEventListener: function () {}, onopen: null, onmessage: null, onerror: null, onclose: null };
          setTimeout(function () { stub.onerror && stub.onerror({ type: "error", target: stub }); stub.onclose && stub.onclose({ type: "close", target: stub, code: 1006 }); }, 0);
          return stub;
        }
        return p !== undefined ? new OW(u, p) : new OW(u);
      };
      window.WebSocket.prototype = OW.prototype;
      window.WebSocket.CONNECTING = OW.CONNECTING; window.WebSocket.OPEN = OW.OPEN; window.WebSocket.CLOSING = OW.CLOSING; window.WebSocket.CLOSED = OW.CLOSED;
    }
  } catch (e) {}
})();
