package tech.nhz.nhzterm.daemon

import org.json.JSONObject
import tech.nhz.nhzterm.api.Protocol
import java.io.File

/**
 * etc/nhztermd.json (§12.2). Written with defaults on first start, read
 * thereafter. Unknown keys are preserved on rewrite so a newer build's
 * settings survive a downgrade.
 *
 * The three §14 Open Decisions are resolved here, as config rather than
 * hardcoded constants, so they stay changeable without a rebuild:
 *
 *  1. Session idle timeout -> DISABLED (0). Sessions live until explicitly
 *     killed, matching tmux. A long build must never be reaped for being
 *     "idle" while the user has the phone in their pocket.
 *  2. First target environment -> Termux for v1 (proot detection is recorded
 *     but does not change behaviour yet).
 *  3. Kill signal policy -> SIGTERM, then SIGKILL after a grace period, so
 *     interactive programs get to restore the terminal and flush state.
 */
data class DaemonConfig(
    val maxSessions: Int = Protocol.Limits.MAX_SESSIONS,
    val scrollbackLines: Int = Protocol.Limits.SCROLLBACK_LINES,
    val wakeLockEnabled: Boolean = false,
    /** 0 = never expire. Decision 1. */
    val sessionIdleTimeoutMs: Long = 0L,
    /** Decision 3: grace between SIGTERM and SIGKILL. */
    val killGraceMs: Long = 3_000L,
    /**
     * INTEGRATION POINT: sessions spawn nhzsh, not a placeholder sh.
     * SessionManager falls back to sh automatically if staging failed, so a
     * missing libnhzsh.so degrades instead of breaking the terminal.
     */
    val defaultShell: String = "nhzsh",
) {

    fun toJson(): JSONObject = JSONObject().apply {
        put("max_sessions", maxSessions)
        put("scrollback_lines", scrollbackLines)
        put("wake_lock_enabled", wakeLockEnabled)
        put("session_idle_timeout_ms", sessionIdleTimeoutMs)
        put("kill_grace_ms", killGraceMs)
        put("default_shell", defaultShell)
    }

    companion object {
        private val DEFAULTS = DaemonConfig()

        fun parse(json: String): DaemonConfig {
            val o = JSONObject(json)
            return DaemonConfig(
                // Clamp rather than trust: a hand-edited config must not be
                // able to uncap sessions or zero the scrollback.
                maxSessions = o.optInt("max_sessions", DEFAULTS.maxSessions)
                    .coerceIn(1, Protocol.Limits.MAX_SESSIONS),
                scrollbackLines = o.optInt("scrollback_lines", DEFAULTS.scrollbackLines)
                    .coerceIn(100, 100_000),
                wakeLockEnabled = o.optBoolean("wake_lock_enabled", DEFAULTS.wakeLockEnabled),
                sessionIdleTimeoutMs = o.optLong("session_idle_timeout_ms", DEFAULTS.sessionIdleTimeoutMs)
                    .coerceAtLeast(0L),
                killGraceMs = o.optLong("kill_grace_ms", DEFAULTS.killGraceMs)
                    .coerceIn(0L, 60_000L),
                defaultShell = o.optString("default_shell", DEFAULTS.defaultShell)
                    .ifBlank { DEFAULTS.defaultShell },
            )
        }

        /** Reads, or writes defaults if absent/corrupt. Never throws. */
        fun load(file: File): DaemonConfig {
            val cfg = try {
                if (file.isFile) parse(file.readText()) else DEFAULTS
            } catch (t: Throwable) {
                DEFAULTS
            }
            try {
                file.writeText(cfg.toJson().toString(2))
            } catch (_: Throwable) {
                // Read-only FS is survivable; run with in-memory defaults.
            }
            return cfg
        }
    }
}
