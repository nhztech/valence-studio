package tech.nhz.nhzterm.pty

import tech.nhz.nhzterm.util.DaemonLog
import java.io.File

/**
 * PTY acquisition strategy (§4).
 *
 * The daemon probes at startup rather than hardcoding one method, because
 * Termux environments vary wildly — some have tmux, some don't, some run
 * busybox variants with different screen/socat availability.
 *
 * Probe order is deliberate:
 *   1. tmux   — mature, battle-tested PTY handling, session persistence built in
 *   2. screen — fallback if tmux absent
 *   3. socat  — can allocate a pty and bridge it
 *   4. JNI forkpty() — compiled last-resort helper (Phase 1.4: deferred until
 *      the tool-based path is confirmed working; §"Explicitly deferred")
 */
enum class PtyMethod { TMUX, SCREEN, SOCAT, JNI_FORKPTY, NONE }

data class PtyCapability(
    val method: PtyMethod,
    /** Absolute path to the tool, or null for JNI/NONE. */
    val toolPath: String?,
) {
    val usable: Boolean get() = method != PtyMethod.NONE
}

object PtyProbe {

    /**
     * Directories searched for the PTY tools. `command -v` is unreliable here:
     * the daemon is an Android app, so its PATH is the zygote's, not Termux's.
     * We look where Termux actually installs things.
     */
    private val SEARCH_PATHS = listOf(
        "/data/data/com.termux/files/usr/bin",
        "/data/data/com.termux/files/usr/bin/applets",
        "/system/bin",
        "/system/xbin",
        "/vendor/bin",
    )

    @Volatile
    private var cached: PtyCapability? = null

    /** Probes once and caches. Thread-safe. */
    fun detect(force: Boolean = false): PtyCapability {
        cached?.let { if (!force) return it }
        synchronized(this) {
            cached?.let { if (!force) return it }
            val found = runProbe()
            cached = found
            return found
        }
    }

    private fun runProbe(): PtyCapability {
        DaemonLog.i("PTY probe starting (§4 order: tmux -> screen -> socat -> jni)")

        which("tmux")?.let {
            DaemonLog.i("PTY probe: tmux found at $it")
            return PtyCapability(PtyMethod.TMUX, it)
        }
        which("screen")?.let {
            DaemonLog.i("PTY probe: screen found at $it (tmux absent)")
            return PtyCapability(PtyMethod.SCREEN, it)
        }
        which("socat")?.let {
            DaemonLog.i("PTY probe: socat found at $it (tmux/screen absent)")
            return PtyCapability(PtyMethod.SOCAT, it)
        }

        // Phase 1.4 — the compiled helper is only built if a target device
        // genuinely has none of the above. Report NONE honestly rather than
        // pretending a .so exists.
        if (NativePty.isAvailable()) {
            DaemonLog.i("PTY probe: falling back to JNI forkpty() helper")
            return PtyCapability(PtyMethod.JNI_FORKPTY, null)
        }

        DaemonLog.e("PTY probe: NO usable PTY method found — sessions cannot start")
        return PtyCapability(PtyMethod.NONE, null)
    }

    /** Locates an executable without depending on the process's PATH. */
    fun which(tool: String): String? {
        for (dir in SEARCH_PATHS) {
            val f = File(dir, tool)
            if (f.isFile && f.canExecute()) return f.absolutePath
        }
        // Last resort: honour PATH if the environment does provide one.
        System.getenv("PATH")?.split(':')?.forEach { dir ->
            if (dir.isNotBlank()) {
                val f = File(dir, tool)
                if (f.isFile && f.canExecute()) return f.absolutePath
            }
        }
        return null
    }
}
