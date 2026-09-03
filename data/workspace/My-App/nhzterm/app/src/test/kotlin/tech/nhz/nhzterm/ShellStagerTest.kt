package tech.nhz.nhzterm

import tech.nhz.nhzterm.daemon.ShellStager
import java.io.File

/**
 * Part 1 Phase 1 gate — nhzsh staging (§12.2).
 *
 * This covers the exact real-device bug: sessions were handed the path of the
 * JNI `.so`, which cannot be exec()'d by a separate child process. The staged
 * copy at system/bin/nhzsh must exist, be executable, and be byte-identical.
 */
object ShellStagerTest {

    private var passed = 0
    private var failed = 0

    private fun check(name: String, cond: Boolean, detail: String = "") {
        if (cond) { passed++; println("  PASS  $name") }
        else { failed++; println("  FAIL  $name ${if (detail.isEmpty()) "" else "-> $detail"}") }
    }

    @JvmStatic
    fun main(args: Array<String>) {
        println("=== Part 1 / Phase 1 — nhzsh staging (§12.2) ===")

        val work = File(System.getProperty("java.io.tmpdir"), "nhzterm-stage-test").apply {
            deleteRecursively(); mkdirs()
        }
        val libDir = File(work, "lib").apply { mkdirs() }
        val binDir = File(work, "system/bin")
        val source = File(libDir, ShellStager.LIB_NAME)
        val target = File(binDir, "nhzsh")

        // A real ELF-ish payload; content only needs to be stable and binary.
        val payload = ByteArray(4096) { (it % 251).toByte() }

        println("first stage")
        run {
            source.writeBytes(payload)
            val out = ShellStager.stage(source, target)
            check("staging returns the target", out?.absolutePath == target.absolutePath, "${out?.absolutePath}")
            check("target file exists", target.isFile, "missing")
            check("parent dirs created", binDir.isDirectory, "system/bin missing")
            check("content is byte-identical", target.readBytes().contentEquals(payload), "content differs")
            check("size matches", target.length() == source.length(), "${target.length()} vs ${source.length()}")
            // THE point of the whole exercise.
            check("target is EXECUTABLE", target.canExecute(), "not executable")
            check("target is readable", target.canRead(), "not readable")
        }

        println("idempotence (routine daemon restart)")
        run {
            val before = target.lastModified()
            Thread.sleep(1100) // filesystem mtime granularity
            ShellStager.stage(source, target)
            check("unchanged binary is NOT re-copied", target.lastModified() == before, "was rewritten")
            check("still executable", target.canExecute(), "lost exec bit")
        }

        println("restage on change (app upgrade)")
        run {
            val v2 = ByteArray(8192) { (it % 97).toByte() }
            source.writeBytes(v2)
            ShellStager.stage(source, target)
            check("new content copied through", target.readBytes().contentEquals(v2), "stale content")
            check("new size", target.length() == 8192L, "${target.length()}")
            check("still executable after restage", target.canExecute(), "lost exec bit")
        }

        println("same size, different content (must not be skipped)")
        run {
            // A size-only check would wrongly skip this. Hashing catches it.
            val sameSize = ByteArray(8192) { 0x42 }
            source.writeBytes(sameSize)
            ShellStager.stage(source, target)
            check("content-aware restage", target.readBytes().contentEquals(sameSize), "skipped a real change")
        }

        println("recovery: target deleted out from under us")
        run {
            target.delete()
            check("target gone", !target.exists(), "still there")
            val out = ShellStager.stage(source, target)
            check("re-staged after deletion", out != null && target.isFile, "not recovered")
            check("executable again", target.canExecute(), "not executable")
        }

        println("recovery: truncated/corrupt target")
        run {
            target.writeBytes(ByteArray(10))
            ShellStager.stage(source, target)
            check("corrupt target replaced", target.length() == source.length(), "${target.length()}")
        }

        println("missing source degrades cleanly")
        run {
            val absent = File(libDir, "libnothing.so")
            val out = ShellStager.stage(absent, File(binDir, "nothing"))
            // Must return null, NOT throw — a missing .so should fall back to
            // sh, not crash the daemon on startup.
            check("returns null for a missing source", out == null, "returned $out")
            check("no stray target created", !File(binDir, "nothing").exists(), "created anyway")
        }

        println("no staging leftovers")
        run {
            val leftovers = binDir.listFiles()?.filter { it.name.endsWith(".staging") } ?: emptyList()
            check("no .staging temp files remain", leftovers.isEmpty(), "$leftovers")
        }

        println("staged binary actually runs (exec proof)")
        run {
            // The real question isn't "is the bit set" but "can a CHILD PROCESS
            // exec this path" — which is precisely what failed on device.
            val script = File(libDir, "libscript.so")
            script.writeText("#!/bin/sh\necho STAGED_EXEC_OK\n")
            val execTarget = File(binDir, "scriptsh")
            ShellStager.stage(script, execTarget)

            val output = try {
                val p = ProcessBuilder(execTarget.absolutePath).redirectErrorStream(true).start()
                val text = p.inputStream.bufferedReader().readText().trim()
                p.waitFor()
                text
            } catch (t: Throwable) {
                "EXEC FAILED: ${t.message}"
            }
            check("a child process can exec the staged file", output == "STAGED_EXEC_OK", output)
        }

        work.deleteRecursively()

        println()
        println("passed=$passed failed=$failed")
        if (failed > 0) { println("PHASE 1 STAGING GATE: FAILED"); System.exit(1) }
        println("PHASE 1 STAGING GATE: PASSED")
    }
}
