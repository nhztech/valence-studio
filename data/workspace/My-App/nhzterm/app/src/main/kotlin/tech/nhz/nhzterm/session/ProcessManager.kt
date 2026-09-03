package tech.nhz.nhzterm.session

import tech.nhz.nhzterm.api.Protocol
import tech.nhz.nhzterm.pty.NativePty
import tech.nhz.nhzterm.util.DaemonLog
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * process.* methods (§6.4).
 *
 * Distinct from sessions: these are NON-interactive, no PTY, output captured
 * rather than streamed. This is the automation path — Valence Studio kicking
 * off a gradle build it wants to poll, not a terminal a human types into.
 */
class ProcessManager(
    private val homeDir: File,
    private val killGraceMs: Long,
) {

    class Tracked(
        val processId: String,
        val process: Process,
        val cmd: String,
    ) {
        val startedAt: Long = System.currentTimeMillis()
        @Volatile var exitCode: Int? = null

        val pid: Int get() = pidOf(process)

        val isRunning: Boolean
            get() = exitCode == null && try { process.isAliveCompat() } catch (t: Throwable) { false }
    }

    private val tracked = ConcurrentHashMap<String, Tracked>()
    private val counter = AtomicInteger(0)

    /** process.spawn (§6.4). */
    fun spawn(cmd: String, args: List<String>, cwd: String?): Tracked {
        val dir = cwd?.let(::File)?.takeIf { it.isDirectory } ?: homeDir
        val pb = ProcessBuilder(listOf(cmd) + args)
            .directory(dir)
            // Merge stderr into stdout: a caller polling status wants the
            // failure reason in one stream, not split across two pipes that
            // can deadlock if only one is drained.
            .redirectErrorStream(true)
        val proc = try {
            pb.start()
        } catch (t: Throwable) {
            throw SessionError(Protocol.ErrorCode.INTERNAL_ERROR, "spawn failed: ${t.message}")
        }

        val id = "p%d-%d".format(counter.incrementAndGet(), System.currentTimeMillis() % 100000)
        val t = Tracked(id, proc, cmd)
        tracked[id] = t

        // Drain the pipe. An undrained pipe buffer fills at ~64KB and blocks
        // the child forever — the classic "build hangs at 40%" bug.
        Thread({
            runCatching { proc.inputStream.use { s -> val b = ByteArray(4096); while (s.read(b) >= 0) Unit } }
            t.exitCode = runCatching { proc.waitFor() }.getOrNull()
            DaemonLog.d("process $id exited: ${t.exitCode}")
        }, "proc-$id").apply { isDaemon = true }.start()

        DaemonLog.i("process spawned: $id pid=${t.pid} cmd=$cmd")
        return t
    }

    fun require(processId: String): Tracked =
        tracked[processId] ?: throw SessionError(
            Protocol.ErrorCode.PROCESS_NOT_FOUND, "no such process: $processId",
        )

    fun list(): List<Tracked> = tracked.values.sortedBy { it.startedAt }

    /** process.stop (§6.4) — SIGTERM, grace, SIGKILL (§14 decision 3). */
    fun stop(processId: String) {
        val t = require(processId)
        if (!t.isRunning) return
        t.process.destroy()
        val deadline = System.currentTimeMillis() + killGraceMs
        while (System.currentTimeMillis() < deadline && t.isRunning) Thread.sleep(50)
        if (t.isRunning) {
            DaemonLog.i("process $processId ignored SIGTERM, destroying forcibly")
            t.process.destroyForciblyCompat()
        }
        tracked.remove(processId)
    }

    /**
     * process.kill (§6.4) — targets a raw PID, which is the session's tracked
     * FOREGROUND pid (§9), not a spawned process.
     *
     * @throws SessionError PROCESS_NOT_FOUND if pid is null/invalid, so the UI
     *         can show a clear "nothing running" state rather than silently
     *         appearing to work (§9 edge case).
     */
    fun killPid(pid: Int?, graceMs: Long = killGraceMs) {
        if (pid == null || pid <= 0) {
            throw SessionError(Protocol.ErrorCode.PROCESS_NOT_FOUND, "no foreground process to kill")
        }
        DaemonLog.i("process.kill: SIGTERM -> group $pid")
        runCatching { NativePty.sendSignalToGroup(pid, NativePty.SIGTERM) }
        if (graceMs > 0) Thread.sleep(graceMs.coerceAtMost(5_000L))
        if (isPidAlive(pid)) {
            DaemonLog.i("process.kill: grace expired, SIGKILL -> group $pid")
            runCatching { NativePty.sendSignalToGroup(pid, NativePty.SIGKILL) }
        }
    }

    /** /proc is the only reliable liveness check for a pid we did not fork. */
    fun isPidAlive(pid: Int): Boolean = File("/proc/$pid").isDirectory

    fun shutdownAll() {
        tracked.values.forEach { runCatching { it.process.destroyForciblyCompat() } }
        tracked.clear()
    }

    companion object {
        /** Process.pid() is API 26+; reflection covers minSdk 24. */
        fun pidOf(p: Process): Int = try {
            val f = p.javaClass.getDeclaredField("pid")
            f.isAccessible = true
            f.getInt(p)
        } catch (t: Throwable) {
            -1
        }

        fun Process.isAliveCompat(): Boolean = try {
            exitValue(); false
        } catch (e: IllegalThreadStateException) {
            true
        }

        fun Process.destroyForciblyCompat() {
            try { destroyForcibly() } catch (t: Throwable) { destroy() }
        }
    }
}
