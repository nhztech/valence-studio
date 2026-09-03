package tech.nhz.nhzterm

import tech.nhz.nhzterm.api.Protocol
import tech.nhz.nhzterm.daemon.AuthToken
import tech.nhz.nhzterm.daemon.DaemonConfig
import java.io.File

/**
 * Part 1 Phase 0 gate for the platform-independent daemon core:
 * config parsing/clamping (§8, §14) and auth-token handling (§13).
 *
 * These classes were written to touch no Android APIs precisely so they can be
 * proven off-device before the APK is ever built.
 */
object DaemonCoreTest {

    private var passed = 0
    private var failed = 0

    private fun check(name: String, cond: Boolean, detail: String = "") {
        if (cond) { passed++; println("  PASS  $name") }
        else { failed++; println("  FAIL  $name ${if (detail.isEmpty()) "" else "-> $detail"}") }
    }

    private fun testConfigDefaults() {
        println("config defaults (§8, §14 decisions)")
        val d = DaemonConfig()
        check("max sessions is 15", d.maxSessions == 15, "${d.maxSessions}")
        check("scrollback is 5000", d.scrollbackLines == 5000, "${d.scrollbackLines}")
        check("wake lock OFF by default", !d.wakeLockEnabled)
        check("decision 1: no idle timeout", d.sessionIdleTimeoutMs == 0L, "${d.sessionIdleTimeoutMs}")
        check("decision 3: SIGTERM grace 3s", d.killGraceMs == 3_000L, "${d.killGraceMs}")
        check("defaults match Protocol.Limits", d.maxSessions == Protocol.Limits.MAX_SESSIONS)
        // Integration Point: sessions spawn nhzsh, not a placeholder sh.
        check("default shell is nhzsh", d.defaultShell == "nhzsh", d.defaultShell)
    }

    private fun testConfigRoundTrip() {
        println("config json round-trip")
        val original = DaemonConfig(
            maxSessions = 8, scrollbackLines = 2000, wakeLockEnabled = true,
            sessionIdleTimeoutMs = 60_000L, killGraceMs = 1_500L, defaultShell = "nhzsh",
        )
        val reparsed = DaemonConfig.parse(original.toJson().toString())
        check("survives serialize->parse", reparsed == original, "$reparsed")
    }

    private fun testConfigClamping() {
        println("config clamping (hostile / hand-edited file)")
        // The session cap is a resource guarantee — a config file must not be
        // able to raise it above the documented 15.
        val over = DaemonConfig.parse("""{"max_sessions": 9999}""")
        check("max_sessions clamped to 15", over.maxSessions == 15, "${over.maxSessions}")

        val under = DaemonConfig.parse("""{"max_sessions": 0}""")
        check("max_sessions floored to 1", under.maxSessions == 1, "${under.maxSessions}")

        val neg = DaemonConfig.parse("""{"session_idle_timeout_ms": -500}""")
        check("negative idle timeout floored to 0", neg.sessionIdleTimeoutMs == 0L, "${neg.sessionIdleTimeoutMs}")

        val grace = DaemonConfig.parse("""{"kill_grace_ms": 999999}""")
        check("kill grace capped at 60s", grace.killGraceMs == 60_000L, "${grace.killGraceMs}")

        val blank = DaemonConfig.parse("""{"default_shell": "   "}""")
        check("blank shell falls back to the default", blank.defaultShell == "nhzsh", blank.defaultShell)

        val empty = DaemonConfig.parse("{}")
        check("empty json yields defaults", empty == DaemonConfig(), "$empty")
    }

    private fun testConfigLoadRecovery() {
        println("config load / corruption recovery")
        val tmp = File.createTempFile("nhztermd", ".json").apply { delete() }
        try {
            val fresh = DaemonConfig.load(tmp)
            check("missing file yields defaults", fresh == DaemonConfig())
            check("missing file gets written", tmp.isFile && tmp.length() > 0)

            // A truncated write (battery death mid-save) must not brick the daemon.
            tmp.writeText("{ this is not json")
            val recovered = DaemonConfig.load(tmp)
            check("corrupt file recovers to defaults", recovered == DaemonConfig())
            check("corrupt file is rewritten valid", DaemonConfig.parse(tmp.readText()) == DaemonConfig())
        } finally { tmp.delete() }
    }

    private fun testAuthToken() {
        println("auth token (§13)")
        val tmp = File.createTempFile("auth", ".token").apply { delete() }
        try {
            val t1 = AuthToken.loadOrCreate(tmp)
            check("token is 64 hex chars (256-bit)", t1.length == 64, "${t1.length}")
            check("token is hex only", t1.all { it in "0123456789abcdef" })

            // Stability matters: a regenerated token on every restart would
            // break every already-connected client's stored credential.
            check("token is stable across reloads", AuthToken.loadOrCreate(tmp) == t1)

            val t2 = AuthToken.loadOrCreate(File.createTempFile("auth2", ".token").apply { delete() })
            check("tokens are unique per file", t2 != t1)

            // A half-written token file must be replaced, not accepted.
            tmp.writeText("deadbeef")
            val regenerated = AuthToken.loadOrCreate(tmp)
            check("truncated token regenerated", regenerated.length == 64 && regenerated != "deadbeef")

            tmp.writeText("")
            check("empty token regenerated", AuthToken.loadOrCreate(tmp).length == 64)
        } finally { tmp.delete() }
    }

    private fun testTokenComparison() {
        println("token comparison")
        val token = "a".repeat(64)
        check("exact match accepted", AuthToken.matches(token, token))
        check("null rejected", !AuthToken.matches(token, null))
        check("empty rejected", !AuthToken.matches(token, ""))
        check("wrong token rejected", !AuthToken.matches(token, "b".repeat(64)))
        check("prefix rejected", !AuthToken.matches(token, "a".repeat(63)))
        check("longer rejected", !AuthToken.matches(token, "a".repeat(65)))
        check("case sensitive", !AuthToken.matches(token, "A".repeat(64)))
    }

    @JvmStatic
    fun main(args: Array<String>) {
        println("=== Part 1 / Phase 0 — daemon core (§8/§13/§14) ===")
        testConfigDefaults()
        testConfigRoundTrip()
        testConfigClamping()
        testConfigLoadRecovery()
        testAuthToken()
        testTokenComparison()
        println()
        println("passed=$passed failed=$failed")
        if (failed > 0) { println("PHASE 0 GATE: FAILED"); System.exit(1) }
        println("PHASE 0 GATE: PASSED")
    }
}
