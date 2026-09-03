package tech.nhz.nhzterm

import tech.nhz.nhzterm.api.Protocol
import tech.nhz.nhzterm.session.ProcessManager
import tech.nhz.nhzterm.session.SessionError
import java.io.File

/**
 * Part 1 Phase 4 gate — process control (§6.4).
 *
 * ProcessManager touches no Android APIs, so it runs against REAL processes
 * off-device. Build plan: "spawn a background process via process.spawn,
 * confirm process.status reflects it running, process.stop ends it."
 */
object ProcessManagerTest {

    private var passed = 0
    private var failed = 0

    private fun check(name: String, cond: Boolean, detail: String = "") {
        if (cond) { passed++; println("  PASS  $name") }
        else { failed++; println("  FAIL  $name ${if (detail.isEmpty()) "" else "-> $detail"}") }
    }

    private fun waitUntil(timeoutMs: Long = 5000, cond: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (cond()) return true
            Thread.sleep(25)
        }
        return cond()
    }

    @JvmStatic
    fun main(args: Array<String>) {
        println("=== Part 1 / Phase 4 — process control (§6.4) ===")

        val home = File(System.getProperty("java.io.tmpdir"), "nhzterm-proc-test").apply { mkdirs() }
        val pm = ProcessManager(home, killGraceMs = 500L)

        println("process.spawn + process.status")
        run {
            val t = pm.spawn("/bin/sh", listOf("-c", "sleep 5"), null)
            check("process_id issued", t.processId.isNotEmpty(), t.processId)
            check("real pid reported", t.pid > 0, "${t.pid}")
            check("status is running", t.isRunning, "not running")

            // The spec's own gate: stop must actually end it.
            pm.stop(t.processId)
            check("stopped process is no longer running", waitUntil { !t.isRunning }, "still alive")
        }

        println("short-lived process reaches 'exited' with a code")
        run {
            val t = pm.spawn("/bin/sh", listOf("-c", "exit 3"), null)
            check("exit code observed", waitUntil { t.exitCode == 3 }, "got ${t.exitCode}")
            check("no longer running", !t.isRunning, "still running")
        }

        println("output draining (a full pipe must not deadlock the child)")
        run {
            // ~200 KB, far beyond the ~64 KB pipe buffer. If the manager did
            // not drain stdout, this would hang forever instead of exiting —
            // the classic "build freezes at 40%" bug.
            val t = pm.spawn("/bin/sh", listOf("-c", "for i in $(seq 1 4000); do echo 'padding line for buffer test'; done"), null)
            check("large-output process completes", waitUntil(10_000) { t.exitCode != null }, "deadlocked")
            check("exited cleanly", t.exitCode == 0, "${t.exitCode}")
        }

        println("stderr is merged into stdout (no second undrained pipe)")
        run {
            val t = pm.spawn("/bin/sh", listOf("-c", "echo err >&2; exit 0"), null)
            check("completes without blocking on stderr", waitUntil { t.exitCode != null }, "hung")
        }

        println("process.list")
        run {
            val before = pm.list().size
            val t = pm.spawn("/bin/sh", listOf("-c", "sleep 3"), null)
            check("appears in list", pm.list().any { it.processId == t.processId }, "missing")
            check("list grew", pm.list().size == before + 1, "${pm.list().size}")
            pm.stop(t.processId)
            check("removed from list after stop", pm.list().none { it.processId == t.processId }, "still listed")
        }

        println("cwd handling")
        run {
            val sub = File(home, "sub").apply { mkdirs() }
            val t = pm.spawn("/bin/sh", listOf("-c", "pwd > out.txt"), sub.absolutePath)
            waitUntil { t.exitCode != null }
            val out = File(sub, "out.txt")
            check("ran in the requested cwd", out.isFile && out.readText().trim() == sub.absolutePath,
                if (out.isFile) out.readText().trim() else "no output file")
            out.delete(); sub.delete()
        }

        println("error handling")
        run {
            var threw = false
            try { pm.require("nosuchprocess") } catch (e: SessionError) {
                threw = e.code == Protocol.ErrorCode.PROCESS_NOT_FOUND
            }
            check("unknown process_id -> PROCESS_NOT_FOUND", threw, "wrong or no error")

            var spawnFailed = false
            try { pm.spawn("/nonexistent/binary/xyz", emptyList(), null) } catch (e: SessionError) {
                spawnFailed = e.code == Protocol.ErrorCode.INTERNAL_ERROR
            }
            check("spawning a missing binary errors cleanly", spawnFailed, "no error raised")
        }

        println("process.kill edge case (§9)")
        run {
            // The §9 edge case: pid null means nothing is in the foreground.
            // It must report PROCESS_NOT_FOUND so the UI can say "nothing
            // running", NOT silently succeed and appear broken.
            var nullRejected = false
            try { pm.killPid(null) } catch (e: SessionError) {
                nullRejected = e.code == Protocol.ErrorCode.PROCESS_NOT_FOUND
            }
            check("null pid -> PROCESS_NOT_FOUND", nullRejected, "accepted a null pid")

            var zeroRejected = false
            try { pm.killPid(0) } catch (e: SessionError) {
                zeroRejected = e.code == Protocol.ErrorCode.PROCESS_NOT_FOUND
            }
            // pid 0 means "my whole process group" to kill(2) — accepting it
            // would let the daemon signal itself.
            check("pid 0 rejected (would signal our own group)", zeroRejected, "accepted pid 0")
        }

        println("liveness probe")
        run {
            check("own pid is alive", pm.isPidAlive(ProcessHandleSelfPid()), "own pid reported dead")
            check("absurd pid is not alive", !pm.isPidAlive(999_999), "phantom pid reported alive")
        }

        pm.shutdownAll()
        check("shutdownAll clears the table", pm.list().isEmpty(), "${pm.list().size} left")

        home.deleteRecursively()

        println()
        println("passed=$passed failed=$failed")
        if (failed > 0) { println("PHASE 4 GATE: FAILED"); System.exit(1) }
        println("PHASE 4 GATE: PASSED")
    }

    private fun ProcessHandleSelfPid(): Int =
        File("/proc/self").canonicalFile.name.toIntOrNull() ?: 1
}
