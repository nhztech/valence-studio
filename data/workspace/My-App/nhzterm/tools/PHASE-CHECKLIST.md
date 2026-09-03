# nhzterm + nhzsh — Phase Verification Checklist

Two kinds of gate. **Off-device** gates are real assertion suites that run in
any Linux/Termux shell. **On-device** gates need the installed APK, because
`LocalSocket`, `Service` lifecycle, and JNI PTY spawning cannot be faked.

A phase is not done until both columns pass.

```sh
sh tools/run-tests.sh          # nhzterm off-device gates
cd ../nhzsh && make test       # nhzsh: all 8 phases
```

---

## Automated results (verified off-device)

| Suite | Phase | Assertions |
|---|---|---|
| `FrameCodecTest` | P1/0 | 29 pass |
| `DaemonCoreTest` | P1/0 | 31 pass |
| `ShellStagerTest` **(new)** | P1/1 | 21 pass |
| `pty_harness` (C, real kernel PTY) | P1/1 | 18 pass |
| `ScrollbackTest` | P1/3 | 25 pass |
| `ProcessManagerTest` (real processes) | P1/4 | 20 pass |
| `ui-test.js` (app.js vs mock daemon) **(new)** | P1/7 | 37 pass |
| `test_lexer` | P2/1 | 43 pass |
| `test_parser` | P2/2 | 26 pass |
| `test_expander` | P2/3 | 32 pass |
| `test_executor` | P2/4+5 | 49 pass |
| `test_daemon_link` | P2/6 | 12 pass |
| `test_load` | P2/7 | 17 pass |
| `posix_suite.sh` | P2/8 | 35 pass, 6 deferred |
| `integration_harness` (nhzsh in a real PTY) **(new)** | Integration | 21 pass |
| **Total** | | **416 assertions** |

The PTY harness is the important one: it proves `forkpty` + `termios` +
`TIOCSWINSZ` against a **real kernel**, including `test -t 0` returning true
(a real controlling terminal, not a pipe) and `SIGWINCH` delivery. That is
§2 principle 2 — "real PTY from day one" — demonstrated rather than asserted.

---

## On-device gates (after `./gradlew assembleDebug` + install)

### Phase 0 — skeleton
1. **Notification appears immediately.** Launch nhzterm → persistent
   `nhztermd running` notification within a second. Grant the Android 13+
   notification permission when prompted.
   *If it is missing, §7.3's phantom-process-killer exemption does not apply
   and everything downstream is unreliable.*
2. `adb logcat -s nhztermd` shows `=== nhztermd ready ===`.
3. `adb shell cat /proc/net/unix | grep nhztermd` → one line ending
   `@tech.nhz.nhzterm.nhztermd` (leading `@` = abstract namespace).
4. `adb shell run-as tech.nhz.nhzterm ls -R files` → `etc/ home/ run/
   sessions/ var/` with `nhztermd.json`, `auth.token`, `nhztermd.log`.
5. `auth.token` has no group/other read bits; it is unchanged after a
   force-stop and relaunch.

### Phase 1 — PTY acquisition + nhzsh staging
5b. **nhzsh is staged at a real path.** This was the v1 bug — sessions were
    handed the `.so` path, which a child process cannot exec.
    ```
    adb logcat -s nhztermd | grep nhzsh
    ```
    Expect `nhzsh staged: .../libnhzsh.so -> .../system/bin/nhzsh` then
    `nhzsh ready at ...`. Then confirm the file and its exec bit:
    ```
    adb shell run-as tech.nhz.nhzterm ls -l files/system/bin/nhzsh
    ```
    Expect an `x` in the owner permissions and a non-zero size.
6. Log line `PTY method: ...` names TMUX/SCREEN/SOCAT/JNI_FORKPTY, never NONE.
7. A session runs `vim` and `htop` and they render correctly. **This is the
   real test of the whole design** — if either shows garbage or refuses to
   start, the PTY is not a true controlling terminal.
8. Rotate the device mid-`htop`: the layout reflows (SIGWINCH works).

### Phase 2 — handshake
9. A client with the correct token connects; a wrong token gets
   `hello_ack {accepted:false, reason:"bad_token"}` and no method works.
10. A client sending `protocol_version: 999` gets `protocol_mismatch`.

### Phase 3 — session control
11. Create a session, run commands, kill the app, reopen: scrollback replays
    the prior output, then live output resumes.
12. Create 15 sessions; the 16th returns `SESSION_LIMIT_REACHED`.

### Phase 4 — process control
13. `process.spawn` a long command, poll `process.status`, `process.stop` ends it.
14. Long-press → Kill Process while `sleep 100` runs: the sleep dies, the shell
    survives. With nothing running it reports "nothing running", not silence.

### Phase 5 — lifecycle
15. Force-stop the app in Android settings. `START_STICKY` + the foreground
    service bring it back with no client action.
16. Start a long build, screen off 10 minutes with wake lock ON → still
    progressing. With wake lock OFF it may throttle; that is expected.

### Phase 6 — client library
17. A standalone client importing `nhzterm-api` drives create → write →
    attach → kill using only documented methods, no raw socket code.

### Phase 7 — reference UI
17b. **Session panel + auto-create (§10.4).** This was the second v1 bug —
    the UI opened with 0 sessions and no way to make one.
    - Cold start on a fresh install → a session is created automatically and
      the terminal is usable immediately. **No blank terminal, ever.**
    - The `☰` button (top-left) opens the session drawer.
    - `+` in the drawer creates a session; it becomes active.
    - Each row shows a live status dot (green running / yellow idle / grey
      finished); tapping a row switches; `×` kills it.
    - Long-press a session name → rename dialog.
    - Kill the LAST session → a replacement is created automatically.
    - Create 15, then try a 16th → toast "Session limit reached (15)".
18. Type a command, see output. Then, one at a time: long-press menu, session
    rename/picker, extra-keys rows, volume-key chords, style picker.
    *Do not build all of §10 at once untested.*
19. **xterm.js is NOT bundled here** — drop `xterm.js` and `xterm.css` into
    `app/src/main/assets/`. The UI cannot render without them, and they are
    deliberately not fetched from a CDN (§2.1).
20. Inline image rendering (§10.5) — lowest priority, implement last.

### Phase 8 — packaging
21. Clean install (fresh, no prior app-private storage) bootstraps end to end.
22. `adb shell run-as tech.nhz.nhzterm ls lib/` shows `libptyhelper.so` and
    `libnhzsh.so` for the device's ABI.

### Integration Point
23. Sessions spawn **nhzsh**, not `sh`. The prompt reads `nhz$ `; `help` lists
    nhzsh builtins including `load` / `unload` / `list-libs`. Re-run gate 11
    against real nhzsh.
    *Off-device equivalent already passing: `integration_harness`, 21/21 —
    real nhzsh in a real PTY through create/write/resize/signal/kill.*
24. Kill Process now works via nhzsh's self-reported foreground pid (§9),
    end to end: run `sleep 100`, long-press → Kill Process. The sleep dies,
    the shell survives.

---

## Known gaps, stated plainly

- **xterm.js assets are not vendored** (gate 19) — add them before Phase 7.
  This is now the single biggest remaining blocker for the UI.
- **`libnhzsh.so` must be cross-compiled**: `cd nhzsh && make android
  NDK=$ANDROID_NDK_HOME ABI=arm64-v8a`, then copy into
  `app/src/main/jniLibs/arm64-v8a/`. Until then sessions fall back to `sh`
  (SessionManager logs this and degrades rather than failing).
- **nhzsh deferred constructs** (post-v1 per the build plan): `if/then/fi`,
  `for`, functions, here-documents, `${VAR:-default}`, `$((arith))`.
  `posix_suite.sh` reports these as DEFER, and that count is the
  prioritisation signal for what to build next.
- **Nothing Android-specific has run on hardware yet.** Every gate above is
  the honest remaining work.
