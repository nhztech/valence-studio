const NOTES = "/data/notes";
const listEl = document.getElementById("list");
const metaEl = document.getElementById("meta");
const sheet = document.getElementById("sheet");
const titleEl = document.getElementById("title");
const bodyEl = document.getElementById("body");
const saveState = document.getElementById("saveState");
const clock = document.getElementById("clock");

let current = null;
let saveTimer = null;

function tick() {
  const d = new Date();
  clock.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
tick();
setInterval(tick, 15000);

function slug(s) {
  return (
    (s || "untitled")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "untitled"
  );
}

function excerpt(md) {
  return md.replace(/^#+\s.*$/m, "").replace(/\s+/g, " ").trim();
}

function titleFrom(md, fallback) {
  const m = md.match(/^#\s+(.+)$/m);
  return (m && m[1].trim()) || fallback.replace(/\.md$/, "");
}

const STARTER = {
  "welcome.md":
    "# Welcome to Valence\n\nThis note lives on the device.\nNot on a server. Not in a service-worker cache.\n\nTry airplane mode. We will still be here.\n",
  "how-it-works.md":
    "# How this file exists\n\n1. Your HTML called `valence.fs.writeFile`.\n2. The SDK sent an IPC message.\n3. The kernel wrote bytes into the sandbox.\n4. No HTTP request left the phone.\n",
  "davao.md":
    "# Saturday in Davao\n\n- Jackfruit from Bankerohan\n- Coffee in the afternoon rain\n- Finish the Valence lab\n",
};

async function seedIfEmpty() {
  if (!(await valence.fs.exists(NOTES))) await valence.fs.mkdir(NOTES);
  const names = await valence.fs.readdir(NOTES);
  if (names.length) return;
  for (const [name, body] of Object.entries(STARTER)) {
    await valence.fs.writeFile(valence.path.join(NOTES, name), body);
  }
}

async function loadList() {
  await valence.ready;
  await seedIfEmpty();
  if (!(await valence.fs.exists(NOTES))) await valence.fs.mkdir(NOTES);
  const names = await valence.fs.readdir(NOTES);
  const notes = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const path = valence.path.join(NOTES, name);
    const body = await valence.fs.readFile(path);
    const st = await valence.fs.stat(path);
    notes.push({ name, path, body, mtime: st.mtime });
  }
  notes.sort((a, b) => b.mtime - a.mtime);

  const info = await valence.app.getInfo();
  metaEl.textContent = `${notes.length} notes · ${info.kernel} kernel · ${info.protocol}`;

  listEl.innerHTML = "";
  if (!notes.length) {
    listEl.innerHTML = `<button class="note" type="button"><h2>Empty vault</h2><p>Tap + to write a note that never leaves this device.</p></button>`;
    listEl.firstChild.onclick = newNote;
    return;
  }
  for (const n of notes) {
    const btn = document.createElement("button");
    btn.className = "note";
    btn.type = "button";
    const t = titleFrom(n.body, n.name);
    const when = n.mtime ? new Date(n.mtime).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    btn.innerHTML = `<h2></h2><time></time><p></p>`;
    btn.querySelector("h2").textContent = t;
    btn.querySelector("time").textContent = when;
    btn.querySelector("p").textContent = excerpt(n.body) || "Empty note";
    btn.onclick = () => openNote(n);
    listEl.appendChild(btn);
  }
}

function openNote(n) {
  current = n;
  const t = titleFrom(n.body, n.name);
  titleEl.value = t;
  bodyEl.value = n.body.replace(/^#\s+.+?\n+/, "");
  document.getElementById("sheetTitle").textContent = n.name;
  sheet.classList.remove("hidden");
  saveState.textContent = "local file · " + n.path;
  bodyEl.focus();
}

async function persist() {
  if (!current) return;
  const title = titleEl.value.trim() || "Untitled";
  const body = "# " + title + "\n\n" + bodyEl.value;
  const desired = slug(title) + ".md";
  const nextPath = valence.path.join(NOTES, desired);
  await valence.fs.writeFile(current.path, body);
  if (desired !== current.name) {
    if (await valence.fs.exists(nextPath)) {
      current.body = body;
    } else {
      await valence.fs.rename(current.path, nextPath);
      current.path = nextPath;
      current.name = desired;
    }
  }
  current.body = body;
  document.getElementById("sheetTitle").textContent = current.name;
  saveState.textContent = "saved · " + current.path;
}

function scheduleSave() {
  saveState.textContent = "writing…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist().catch((e) => (saveState.textContent = e.message)), 280);
}

async function newNote() {
  const name = "note-" + Date.now().toString(36) + ".md";
  const path = valence.path.join(NOTES, name);
  const body = "# Untitled\n\n";
  await valence.fs.writeFile(path, body);
  openNote({ name, path, body, mtime: Date.now() });
}

async function deleteNote() {
  if (!current) return;
  if (!confirm("Delete this note from the device?")) return;
  await valence.fs.unlink(current.path);
  current = null;
  sheet.classList.add("hidden");
  await loadList();
}

document.getElementById("newBtn").onclick = newNote;
document.getElementById("backBtn").onclick = async () => {
  await persist();
  sheet.classList.add("hidden");
  current = null;
  await loadList();
};
document.getElementById("delBtn").onclick = deleteNote;
titleEl.addEventListener("input", scheduleSave);
bodyEl.addEventListener("input", scheduleSave);

window.addEventListener("message", async (ev) => {
  if (!ev.data || ev.data.type !== "valence:need-tree") return;
  try {
    const tree = await valence.fs.tree("/");
    parent.postMessage({ type: "valence:tree", id: ev.data.id, tree }, "*");
  } catch (err) {
    parent.postMessage({ type: "valence:tree", id: ev.data.id, tree: [], error: String(err.message || err) }, "*");
  }
});

valence.ready.then(loadList).catch((e) => {
  metaEl.textContent = "kernel failed: " + e.message;
});
