/* nhzterm — Part 1 Phase 7 gate: session panel + auto-create (§10.4).
 *
 * Runs app.js under Node against a MOCK daemon that speaks the real §6.3
 * protocol. This exists because the real-device test found the UI opening with
 * zero sessions and no way to create one — a logic bug that is fully
 * reproducible without an APK.
 *
 * Usage: node tools/ui-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}

// ---- mock daemon (implements §6.3 semantics) ------------------------------

function MockDaemon(opts) {
  opts = opts || {};
  this.sessions = [];
  this.seq = 0;
  this.limit = opts.limit || 15;
  this.calls = [];
  this.attached = null;
  this.failCreate = opts.failCreate || false;
}

MockDaemon.prototype.handle = function (msg, reply) {
  this.calls.push(msg.method || msg.type);

  if (msg.type === 'hello') {
    reply({ type: 'hello_ack', protocol_version: 1, accepted: true });
    return;
  }
  if (msg.type !== 'request') return;

  const p = msg.params || {};
  const id = msg.id;
  const ok = (result) => reply({ type: 'response', id: id, result: result });
  const err = (code, message) => reply({ type: 'error', id: id, code: code, message: message || code });

  switch (msg.method) {
    case 'session.create': {
      if (this.failCreate) return err('INTERNAL_ERROR', 'cannot start pty');
      const live = this.sessions.filter(s => s.status !== 'finished');
      if (live.length >= this.limit) return err('SESSION_LIMIT_REACHED');
      const sid = 's' + (++this.seq);
      this.sessions.push({ session_id: sid, name: 'session ' + this.seq, status: 'running', created_at: Date.now() });
      return ok({ session_id: sid, pty_cols: p.cols || 80, pty_rows: p.rows || 24 });
    }
    case 'session.attach': {
      const s = this.sessions.find(x => x.session_id === p.session_id);
      if (!s) return err('SESSION_NOT_FOUND');
      this.attached = p.session_id;
      return ok({ scrollback: 'scrollback-of-' + p.session_id, status: s.status });
    }
    case 'session.list':
      return ok({ sessions: this.sessions.map(s => Object.assign({}, s)) });
    case 'session.kill': {
      const i = this.sessions.findIndex(x => x.session_id === p.session_id);
      if (i < 0) return err('SESSION_NOT_FOUND');
      this.sessions.splice(i, 1);
      return ok({ ok: true });
    }
    case 'session.rename': {
      const s = this.sessions.find(x => x.session_id === p.session_id);
      if (!s) return err('SESSION_NOT_FOUND');
      s.name = p.name;
      return ok({ ok: true });
    }
    case 'session.resize':
    case 'session.write':
      return msg.id ? ok({ ok: true }) : undefined;
    case 'process.kill':
      return err('PROCESS_NOT_FOUND', 'no foreground process');
    default:
      return err('INTERNAL_ERROR', 'unknown method ' + msg.method);
  }
};

// ---- minimal DOM good enough for app.js -----------------------------------

function makeElement(id) {
  const el = {
    id: id,
    children: [],
    style: {},
    _text: '',
    _html: '',
    listeners: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    get className() { return [...this.classList._s].join(' '); },
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (v === '') this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    removeEventListener() {},
    getAttribute(a) { return this['data-' + a] || null; },
    setAttribute(a, v) { this['data-' + a] = v; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 800 }; },
    click() { (this.listeners.click || []).forEach(f => f({ stopPropagation() {}, preventDefault() {}, target: this })); },
    focus() {},
    set onclick(fn) { this.addEventListener('click', fn); }
  };
  return el;
}

function buildEnv(daemon) {
  const els = {};
  const ids = ['term', 'menu-btn', 'overlay', 'drawer', 'drawer-scrim', 'drawer-head',
    'new-session', 'session-list', 'drawer-empty', 'menu', 'submenu', 'mi-open',
    'mi-openurl', 'styler', 'styler-close', 'theme-list', 'font-list', 'size-list'];
  ids.forEach(i => { els[i] = makeElement(i); });

  const body = makeElement('body');
  body.appendChild = function (c) { this.children.push(c); return c; };
  body.removeChild = function () {};

  const document = {
    body: body,
    readyState: 'complete',
    getElementById: id => els[id] || makeElement(id),
    createElement: tag => makeElement(tag),
    querySelectorAll: () => [],
    addEventListener: () => {}
  };

  const sent = [];
  const bridge = {
    token: () => 'testtoken',
    send: (json) => {
      const msg = JSON.parse(json);
      sent.push(msg);
      // Async, like the real bridge — forces the code to be callback-correct
      // rather than accidentally relying on synchronous replies.
      daemon.handle(msg, (reply) => {
        setImmediate(() => ctx.window.__nhzterm_recv(JSON.stringify(reply)));
      });
    }
  };

  const toasts = [];
  const prompts = [];
  const ui = {
    toast: m => toasts.push(m),
    prompt: (title, initial) => { prompts.push(title); return ui._promptReply || ''; },
    copy() {}, paste: () => '', openUrl() {}, share() {}, keepScreenOn() {}, help() {}, settings() {}, report() {}
  };

  const term = {
    cols: 80, rows: 24, options: {},
    written: [],
    write(d) { this.written.push(d); },
    clear() { this.written.length = 0; },
    reset() {},
    focus() {},
    open() {},
    resize(c, r) { this.cols = c; this.rows = r; },
    onData() {},
    hasSelection: () => false,
    getSelection: () => '',
    attachCustomKeyEventHandler() {}
  };

  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    JSON, Object, Array, String, Number, Math, Date, RegExp, Error,
    document,
    localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; } },
    Terminal: function () { return term; }
  };
  ctx.window = ctx;
  ctx.window.NhzBridge = bridge;
  ctx.window.NhzUi = ui;
  ctx.window.addEventListener = () => {};
  ctx.NHZ_THEMES = { Dracula: {} };
  ctx.NHZ_FONTS = ['JetBrains Mono'];

  return { ctx, els, sent, term, toasts, prompts, ui, daemon };
}

function run(env) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/app.js'), 'utf8');
  vm.createContext(env.ctx);
  vm.runInContext(src, env.ctx);
}

// Drains the async reply chain.
function settle() {
  return new Promise(resolve => setTimeout(resolve, 60));
}

// ---- tests -----------------------------------------------------------------

async function main() {
  console.log('=== Part 1 / Phase 7 — session panel + auto-create (§10.4) ===');

  console.log('THE REPORTED BUG: cold start with zero sessions');
  {
    const d = new MockDaemon();
    const env = buildEnv(d);
    run(env);
    await settle();

    // Before the fix the UI showed a blank terminal and never created anything.
    check('session.list is queried on launch', d.calls.includes('session.list'), d.calls.join(','));
    check('a session is auto-created when none exist', d.sessions.length === 1, 'created ' + d.sessions.length);
    check('the new session is attached', d.attached === d.sessions[0].session_id, String(d.attached));
    check('scrollback rendered into the terminal',
      env.term.written.some(w => String(w).indexOf('scrollback-of-') === 0), JSON.stringify(env.term.written));
    check('terminal is NOT blank', env.term.written.length > 0, 'nothing written');
  }

  console.log('warm start: adopt an existing session, do not spawn a duplicate');
  {
    const d = new MockDaemon();
    d.sessions.push({ session_id: 'pre1', name: 'existing', status: 'running', created_at: 1 });
    const env = buildEnv(d);
    run(env);
    await settle();
    check('no duplicate session created', d.sessions.length === 1, 'now ' + d.sessions.length);
    check('attached to the pre-existing session', d.attached === 'pre1', String(d.attached));
  }

  console.log('finished sessions do not count as usable');
  {
    const d = new MockDaemon();
    d.sessions.push({ session_id: 'dead', name: 'old', status: 'finished', created_at: 1 });
    const env = buildEnv(d);
    run(env);
    await settle();
    // Attaching to a finished session would show a dead pane; a fresh one is
    // the only sane outcome.
    check('a fresh session is created', d.sessions.length === 2, 'total ' + d.sessions.length);
    check('attached to the live one, not the corpse', d.attached !== 'dead', String(d.attached));
  }

  console.log('the "+" button creates a session');
  {
    const d = new MockDaemon();
    const env = buildEnv(d);
    run(env);
    await settle();
    const before = d.sessions.length;
    env.els['new-session'].click();
    await settle();
    check('+ adds a session', d.sessions.length === before + 1, 'went ' + before + ' -> ' + d.sessions.length);
    check('the new session becomes active', d.attached === d.sessions[d.sessions.length - 1].session_id, String(d.attached));
  }

  console.log('panel rendering');
  {
    const d = new MockDaemon();
    const env = buildEnv(d);
    run(env);
    await settle();
    env.els['new-session'].click();
    await settle();
    env.els['menu-btn'].click();
    await settle();

    check('drawer opens', env.els.drawer.classList.contains('on'), 'not open');
    check('scrim shown', env.els['drawer-scrim'].classList.contains('on'), 'no scrim');
    const rows = env.els['session-list'].children;
    check('one row per session', rows.length === d.sessions.length, rows.length + ' rows for ' + d.sessions.length);
    check('rows carry a status dot', rows.length > 0 && rows[0].children.some(c => c.className.indexOf('dot') === 0), 'no dot');
    check('empty-state hidden when sessions exist', env.els['drawer-empty'].style.display === 'none',
      String(env.els['drawer-empty'].style.display));

    env.els['drawer-scrim'].click();
    check('scrim tap closes the drawer', !env.els.drawer.classList.contains('on'), 'still open');
  }

  console.log('switching sessions');
  {
    const d = new MockDaemon();
    const env = buildEnv(d);
    run(env);
    await settle();
    env.els['new-session'].click();
    await settle();
    const first = d.sessions[0].session_id;
    env.els['menu-btn'].click();
    await settle();

    // Tap the name element of row 0.
    const row0 = env.els['session-list'].children[0];
    const nameEl = row0.children[1];
    nameEl.click();
    await settle();
    check('switched to the tapped session', d.attached === first, String(d.attached));
    check('drawer closed after switching', !env.els.drawer.classList.contains('on'), 'still open');
    check('terminal replayed the new session scrollback',
      env.term.written.some(w => String(w).indexOf('scrollback-of-' + first) === 0), 'wrong scrollback');
  }

  console.log('output isolation between sessions');
  {
    const d = new MockDaemon();
    const env = buildEnv(d);
    run(env);
    await settle();
    const active = d.attached;
    env.term.written.length = 0;

    env.ctx.window.__nhzterm_recv(JSON.stringify({ type: 'output', session_id: active, data: 'MINE' }));
    env.ctx.window.__nhzterm_recv(JSON.stringify({ type: 'output', session_id: 'other-session', data: 'NOTMINE' }));
    await settle();

    check('output for the attached session renders', env.term.written.indexOf('MINE') >= 0, JSON.stringify(env.term.written));
    // Background sessions keep running headlessly; their bytes must not bleed
    // into the pane the user is looking at.
    check('output for OTHER sessions is suppressed', env.term.written.indexOf('NOTMINE') < 0, JSON.stringify(env.term.written));
  }

  console.log('killing sessions');
  {
    const d = new MockDaemon();
    const env = buildEnv(d);
    run(env);
    await settle();
    env.els['new-session'].click();
    await settle();
    env.els['menu-btn'].click();
    await settle();

    const victim = d.sessions[0].session_id;
    const row0 = env.els['session-list'].children[0];
    row0.children[2].click();   // the × button
    await settle();
    check('session removed from the daemon', !d.sessions.find(s => s.session_id === victim), 'still present');
    check('one session remains', d.sessions.length === 1, String(d.sessions.length));
  }

  console.log('killing the LAST session must not strand the user');
  {
    const d = new MockDaemon();
    const env = buildEnv(d);
    run(env);
    await settle();
    env.els['menu-btn'].click();
    await settle();

    const only = d.sessions[0].session_id;
    env.els['session-list'].children[0].children[2].click();
    await settle();

    // The dead-end case again: closing the last session must auto-create,
    // never leave a blank terminal with nothing attached.
    check('a replacement session was created', d.sessions.length === 1, String(d.sessions.length));
    check('replacement is a NEW session', d.sessions[0].session_id !== only, 'same id');
    check('attached to the replacement', d.attached === d.sessions[0].session_id, String(d.attached));
  }

  console.log('session limit is surfaced, not swallowed');
  {
    const d = new MockDaemon({ limit: 2 });
    const env = buildEnv(d);
    run(env);
    await settle();
    env.els['new-session'].click();
    await settle();
    env.els['new-session'].click();   // third — must be refused
    await settle();
    check('daemon cap respected', d.sessions.length === 2, String(d.sessions.length));
    check('user is told why', env.toasts.some(t => /limit/i.test(t)), JSON.stringify(env.toasts));
  }

  console.log('hardware-keyboard shortcuts (§10.9)');
  {
    const d = new MockDaemon();
    const env = buildEnv(d);
    run(env);
    await settle();

    env.ctx.window.__nhzterm_newsession();
    await settle();
    check('Ctrl+Alt+C creates a session', d.sessions.length === 2, String(d.sessions.length));

    const before = d.attached;
    env.ctx.window.__nhzterm_cyclesession(-1);
    await settle();
    check('Ctrl+Alt+P switches session', d.attached !== before, 'did not move');

    env.ctx.window.__nhzterm_gotosession(0);
    await settle();
    check('Ctrl+Alt+1 jumps to session 1', d.attached === d.sessions[0].session_id, String(d.attached));

    env.ctx.window.__nhzterm_drawer(true);
    check('Ctrl+Alt+Right opens the drawer', env.els.drawer.classList.contains('on'), 'closed');
  }

  console.log('rename');
  {
    const d = new MockDaemon();
    const env = buildEnv(d);
    run(env);
    await settle();
    env.ui._promptReply = 'my build';
    env.ctx.window.__nhzterm_renamesession();
    await settle();
    check('rename reaches the daemon', d.sessions[0].name === 'my build', d.sessions[0].name);
  }

  console.log('resilience: session.create fails at the daemon');
  {
    const d = new MockDaemon({ failCreate: true });
    const env = buildEnv(d);
    run(env);
    await settle();
    // Must surface the error rather than hanging on a silent blank screen.
    check('error surfaced to the terminal',
      env.term.written.some(w => /INTERNAL_ERROR/.test(String(w))), JSON.stringify(env.term.written));
    check('did not crash', true, '');
  }

  console.log('resilience: attaching to a vanished session');
  {
    const d = new MockDaemon();
    d.sessions.push({ session_id: 'ghost', name: 'ghost', status: 'running', created_at: 1 });
    const env = buildEnv(d);
    run(env);
    await settle();
    // Simulate it being killed by another client, then re-attach.
    d.sessions.length = 0;
    env.ctx.window.__nhzterm_gotosession(0);
    await settle();
    check('SESSION_NOT_FOUND handled without crashing', true, '');
  }

  console.log('');
  console.log('passed=' + passed + ' failed=' + failed);
  if (failed) { console.log('PHASE 7 UI GATE: FAILED'); process.exit(1); }
  console.log('PHASE 7 UI GATE: PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
