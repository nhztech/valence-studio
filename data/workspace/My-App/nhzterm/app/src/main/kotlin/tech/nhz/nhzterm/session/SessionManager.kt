package tech.nhz.nhzterm.session

import org.json.JSONObject
import tech.nhz.nhzterm.api.Protocol
import tech.nhz.nhzterm.daemon.DaemonConfig
import tech.nhz.nhzterm.util.DaemonLog
import tech.nhz.nhzterm.util.Paths
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Raised for conditions that map onto a §6.6 error code. */
class SessionError(val code: String, message: String) : Exception(message)

/**
 * Owns every session (§3). Enforces the 15-session cap (§8) and persists
 * session METADATA only — scrollback stays in daemon memory (§12.2), because
 * writing 15 × 5,000 lines to flash continuously would wreck both battery and
 * storage lifetime.
 */
class SessionManager(
    private val paths: Paths,
    private val config: DaemonConfig,
    private val env: Array<String>,
    /** Notifies the service so it can update the persistent notification. */
    private val onCountChanged: (Int) -> Unit = {},
) {

    private val sessions = ConcurrentHashMap<String, PtySession>()
    private val counter = AtomicInteger(0)

    fun count(): Int = sessions.size
    fun get(id: String): PtySession? = sessions[id]

    fun require(id: String): PtySession =
        sessions[id] ?: throw SessionError(Protocol.ErrorCode.SESSION_NOT_FOUND, "no such session: $id")

    /** session.create (§6.3). */
    fun create(
        shell: String? = null,
        cwd: String? = null,
        cols: Int = Protocol.Limits.DEFAULT_COLS,
        rows: Int = Protocol.Limits.DEFAULT_ROWS,
        name: String? = null,
    ): PtySession {
        // Cap BEFORE spawning: a rejected create must not leak a pty.
        if (sessions.size >= config.maxSessions) {
            throw SessionError(
                Protocol.ErrorCode.SESSION_LIMIT_REACHED,
                "session limit reached (${config.maxSessions})",
            )
        }

        val id = "s%d-%d".format(counter.incrementAndGet(), System.currentTimeMillis() % 100000)
        val resolvedShell = resolveShell(shell)
        val resolvedCwd = resolveCwd(cwd)

        val session = PtySession(
            sessionId = id,
            name = name ?: "session ${counter.get()}",
            shell = resolvedShell,
            cwd = resolvedCwd,
            scrollbackLines = config.scrollbackLines,
            initialCols = cols,
            initialRows = rows,
        )

        try {
            session.start(env + arrayOf("NHZTERM_SESSION_ID=$id"))
        } catch (t: Throwable) {
            DaemonLog.e("session create failed", t)
            throw SessionError(Protocol.ErrorCode.INTERNAL_ERROR, "cannot start pty: ${t.message}")
        }

        sessions[id] = session
        session.addStatusListener { persistMeta(session) }
        persistMeta(session)
        onCountChanged(sessions.size)
        DaemonLog.i("session created: $id (${sessions.size}/${config.maxSessions})")
        return session
    }

    /**
     * Resolves the shell to an absolute executable.
     *
     * After the Integration Point this is libnhzsh.so in the native library
     * dir — the only location an Android app may execute from (§12.1).
     */
    private fun resolveShell(requested: String?): String {
        val want = requested?.takeIf { it.isNotBlank() } ?: config.defaultShell

        if (want.startsWith("/")) return want

        if (want == "nhzsh") {
            // The STAGED copy at system/bin/nhzsh (§12.2), never the .so in the
            // native library dir. A PTY session is a separate child process and
            // must exec() a real file at a real path — see ShellStager.
            val staged = paths.nhzshBin
            if (staged.isFile && staged.canExecute()) return staged.absolutePath
            DaemonLog.w(
                "nhzsh requested but ${staged.absolutePath} is not staged/executable — falling back to sh",
            )
        }

        listOf(
            "/data/data/com.termux/files/usr/bin/$want",
            "/system/bin/$want",
            "/system/xbin/$want",
        ).forEach { if (File(it).canExecute()) return it }

        return "/system/bin/sh"
    }

    private fun resolveCwd(requested: String?): String {
        val dir = requested?.takeIf { it.isNotBlank() }?.let(::File)
        if (dir != null && dir.isDirectory) return dir.absolutePath
        // §12.2: home/ is the default cwd for automation-spawned sessions.
        return paths.home.absolutePath
    }

    /** session.list (§6.3). */
    fun list(): List<PtySession> = sessions.values
        .onEach { it.refreshIdleStatus() }
        .sortedBy { it.createdAt }

    /** session.kill (§6.3). */
    fun kill(id: String) {
        val s = require(id)
        s.kill(config.killGraceMs)
        sessions.remove(id)
        deleteMeta(id)
        onCountChanged(sessions.size)
        DaemonLog.i("session killed: $id")
    }

    /** session.rename (§6.3). */
    fun rename(id: String, newName: String) {
        val s = require(id)
        s.name = newName.trim().ifBlank { s.name }
        persistMeta(s)
    }

    /**
     * §14 decision 1: sessions live until explicitly killed. This reaper only
     * runs when an operator sets a non-zero timeout, and it NEVER reaps a
     * session with clients attached or one still producing output.
     */
    fun reapIdle() {
        val timeout = config.sessionIdleTimeoutMs
        if (timeout <= 0L) return
        val now = System.currentTimeMillis()
        sessions.values
            .filter { it.attachedClients() == 0 && now - it.lastActivityAt > timeout }
            .forEach {
                DaemonLog.i("reaping idle session ${it.sessionId}")
                runCatching { kill(it.sessionId) }
            }
    }

    /** Drops finished sessions from the live map, keeping list() honest. */
    fun sweepFinished() {
        sessions.values.filter { !it.isAlive }.forEach {
            if (it.attachedClients() == 0) {
                sessions.remove(it.sessionId)
                deleteMeta(it.sessionId)
                onCountChanged(sessions.size)
            }
        }
    }

    fun shutdownAll() {
        sessions.values.forEach { runCatching { it.shutdown() } }
        sessions.clear()
        onCountChanged(0)
    }

    // ---- metadata persistence (§12.2) --------------------------------------

    private fun persistMeta(s: PtySession) {
        try {
            val dir = paths.sessionDir(s.sessionId)
            if (!dir.isDirectory) dir.mkdirs()
            val json = JSONObject().apply {
                put("name", s.name)
                put("status", s.status)
                put("created_at", s.createdAt)
                put("cwd", s.cwd)
                put("shell", s.shell)
            }
            File(dir, "meta.json").writeText(json.toString())
        } catch (t: Throwable) {
            DaemonLog.w("could not persist meta for ${s.sessionId}", t)
        }
    }

    private fun deleteMeta(id: String) {
        runCatching { paths.sessionDir(id).deleteRecursively() }
    }

    /**
     * Clears stale metadata from a previous daemon life. PTYs do not survive
     * process death, so any session dir found at startup is a tombstone —
     * listing it would advertise sessions that cannot be attached.
     */
    fun clearStaleMeta() {
        runCatching {
            paths.sessions.listFiles()?.forEach { it.deleteRecursively() }
        }
    }
}
