package tech.nhz.nhzterm

import tech.nhz.nhzterm.session.ScrollbackBuffer

/**
 * Part 1 Phase 3 gate — scrollback ring buffer (§8).
 *
 * This is what a client replays on attach, so a bug here shows up as a
 * corrupted screen every time someone reopens the app.
 */
object ScrollbackTest {

    private var passed = 0
    private var failed = 0

    private fun check(name: String, cond: Boolean, detail: String = "") {
        if (cond) { passed++; println("  PASS  $name") }
        else { failed++; println("  FAIL  $name ${if (detail.isEmpty()) "" else "-> $detail"}") }
    }

    private fun testBasics() {
        println("basic accumulation")
        val b = ScrollbackBuffer(100)
        check("empty snapshot", b.snapshot() == "")
        b.append("hello\n")
        check("one line retained", b.snapshot() == "hello\n", b.snapshot())
        check("line counted", b.lineCount() == 1, "${b.lineCount()}")
        b.append("world\n")
        check("two lines in order", b.snapshot() == "hello\nworld\n", b.snapshot())
    }

    private fun testPartialLines() {
        println("partial lines (prompts have no trailing newline)")
        val b = ScrollbackBuffer(100)
        b.append("$ ")
        // The prompt must be visible in scrollback even though it is not a
        // complete line — otherwise a reattached client sees no prompt.
        check("unterminated tail is visible", b.snapshot() == "$ ", "'${b.snapshot()}'")
        check("tail is not counted as a line", b.lineCount() == 0, "${b.lineCount()}")
        b.append("ls\n")
        check("tail completes into a line", b.snapshot() == "$ ls\n", "'${b.snapshot()}'")
        check("now one line", b.lineCount() == 1)
    }

    private fun testChunkSplitting() {
        println("writes split across arbitrary chunk boundaries")
        // A PTY read() returns whatever bytes happen to be ready; line
        // boundaries never align with read boundaries.
        val b = ScrollbackBuffer(100)
        "line one\nline two\nline three\n".forEach { b.append(it.toString()) }
        check(
            "reassembled correctly from 1-char writes",
            b.snapshot() == "line one\nline two\nline three\n",
            b.snapshot(),
        )
        check("three lines", b.lineCount() == 3, "${b.lineCount()}")

        val b2 = ScrollbackBuffer(100)
        b2.append("a\nb\nc\n")
        check("multiple lines in one write", b2.lineCount() == 3, "${b2.lineCount()}")
    }

    private fun testRingEviction() {
        println("ring eviction at capacity (§8 bounded memory)")
        val b = ScrollbackBuffer(5)
        for (i in 1..10) b.append("line $i\n")
        check("capped at 5 lines", b.lineCount() == 5, "${b.lineCount()}")
        val snap = b.snapshot()
        check("oldest evicted", !snap.contains("line 1\n"), snap)
        check("newest retained", snap.contains("line 10\n"), snap)
        check("exact window kept", snap == "line 6\nline 7\nline 8\nline 9\nline 10\n", snap)

        // Memory must not grow without bound — this is the whole point.
        val b2 = ScrollbackBuffer(10)
        for (i in 1..10_000) b2.append("some reasonably long output line $i\n")
        check("10k lines still capped at 10", b2.lineCount() == 10, "${b2.lineCount()}")
        check("byte accounting stays small", b2.approximateBytes < 1000, "${b2.approximateBytes}")
    }

    private fun testTuiRedraw() {
        println("TUI redraw safety (htop emits no newlines)")
        val b = ScrollbackBuffer(100)
        // A full-screen program can emit megabytes with zero newlines. If the
        // partial buffer never flushed, memory would grow forever.
        repeat(50) { b.append("\u001b[H\u001b[2J" + "x".repeat(10_000)) }
        check("partial buffer flushed, not unbounded", b.approximateBytes < 2_000_000, "${b.approximateBytes}")
        check("lines were produced", b.lineCount() > 0, "${b.lineCount()}")
    }

    private fun testUnicodeAndAnsi() {
        println("unicode + ANSI preserved verbatim")
        val b = ScrollbackBuffer(100)
        val fancy = "\u001b[31m┌──┤ htop ├──┐\u001b[0m 🚀 日本語\n"
        b.append(fancy)
        check("escape sequences survive", b.snapshot() == fancy, b.snapshot())
    }

    private fun testClear() {
        println("clear")
        val b = ScrollbackBuffer(100)
        b.append("data\npartial")
        b.clear()
        check("empty after clear", b.snapshot() == "")
        check("count zero", b.lineCount() == 0)
        check("bytes zero", b.approximateBytes == 0)
    }

    private fun testConcurrency() {
        println("concurrent append + snapshot (reader thread vs attach)")
        val b = ScrollbackBuffer(1000)
        val writer = Thread { repeat(2000) { b.append("output line $it\n") } }
        var error: Throwable? = null
        val reader = Thread {
            try { repeat(2000) { b.snapshot(); b.lineCount() } } catch (t: Throwable) { error = t }
        }
        writer.start(); reader.start()
        writer.join(10_000); reader.join(10_000)
        check("no concurrent-modification crash", error == null, "${error?.message}")
        check("buffer intact", b.lineCount() == 1000, "${b.lineCount()}")
    }

    @JvmStatic
    fun main(args: Array<String>) {
        println("=== Part 1 / Phase 3 — scrollback ring buffer (§8) ===")
        testBasics()
        testPartialLines()
        testChunkSplitting()
        testRingEviction()
        testTuiRedraw()
        testUnicodeAndAnsi()
        testClear()
        testConcurrency()
        println()
        println("passed=$passed failed=$failed")
        if (failed > 0) { println("SCROLLBACK GATE: FAILED"); System.exit(1) }
        println("SCROLLBACK GATE: PASSED")
    }
}
