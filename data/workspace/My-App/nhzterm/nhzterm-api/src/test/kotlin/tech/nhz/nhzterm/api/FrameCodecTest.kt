package tech.nhz.nhzterm.api

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream

/**
 * Part 1 Phase 0 gate — framing must be provably correct before any protocol
 * logic is layered on top (§6.1).
 *
 * Written as a plain main() harness with no JUnit dependency so it runs both
 * under `gradle test` style tooling and standalone via kotlinc/java, which is
 * how it is verified off-device.
 */
object FrameCodecTest {

    private var passed = 0
    private var failed = 0

    private fun check(name: String, cond: Boolean, detail: String = "") {
        if (cond) {
            passed++
            println("  PASS  $name")
        } else {
            failed++
            println("  FAIL  $name ${if (detail.isEmpty()) "" else "-> $detail"}")
        }
    }

    private fun <T> expectThrows(name: String, type: Class<T>, block: () -> Unit) {
        try {
            block()
            check(name, false, "expected ${type.simpleName}, nothing thrown")
        } catch (t: Throwable) {
            check(name, type.isInstance(t), "expected ${type.simpleName}, got ${t::class.java.simpleName}: ${t.message}")
        }
    }

    /** Round-trips a list of payloads through a real byte pipe. */
    private fun roundTrip(payloads: List<String>): List<String?> {
        val sink = ByteArrayOutputStream()
        val writer = FrameCodec(ByteArrayInputStream(ByteArray(0)), sink)
        payloads.forEach { writer.writeFrame(it) }

        val reader = FrameCodec(ByteArrayInputStream(sink.toByteArray()), ByteArrayOutputStream())
        return payloads.indices.map { reader.readFrame() }
    }

    private fun testLengthCodec() {
        println("length header encode/decode")
        val buf = ByteArray(4)
        listOf(0, 1, 2, 127, 128, 255, 256, 65535, 65536, 1 shl 23, Protocol.MAX_FRAME_BYTES, Int.MAX_VALUE).forEach {
            FrameCodec.encodeLength(it, buf)
            check("roundtrip length $it", FrameCodec.decodeLength(buf) == it, "got ${FrameCodec.decodeLength(buf)}")
        }

        // Byte order must be BIG-endian, on the wire, exactly as specced.
        FrameCodec.encodeLength(0x01020304, buf)
        check(
            "big-endian byte order",
            buf[0] == 0x01.toByte() && buf[1] == 0x02.toByte() &&
                buf[2] == 0x03.toByte() && buf[3] == 0x04.toByte(),
            buf.joinToString(" ") { String.format("%02x", it) },
        )
    }

    private fun testRoundTrip() {
        println("frame round-trip")
        val hello = """{"type":"hello","protocol_version":1,"token":"abc123"}"""
        check("single frame", roundTrip(listOf(hello)) == listOf(hello))

        // Multiple frames back to back must not bleed into each other — this is
        // the property that matters for a streaming daemon connection.
        val many = listOf(
            hello,
            """{"type":"hello_ack","protocol_version":1,"accepted":true}""",
            """{"type":"request","method":"session.create","params":{}}""",
        )
        check("three sequential frames", roundTrip(many) == many)

        check("empty body", roundTrip(listOf("")) == listOf(""))

        // Terminal output is raw bytes and absolutely will contain multibyte
        // UTF-8 (box drawing from htop, powerline glyphs, emoji).
        val unicode = """{"type":"output","data":"┌─┤htop├─┐ ✓ 日本語 🚀"}"""
        check("multibyte utf-8 preserved", roundTrip(listOf(unicode)) == listOf(unicode))

        // Length must be counted in BYTES not CHARS. A naive length() would
        // truncate here and desync every following frame.
        val sink = ByteArrayOutputStream()
        FrameCodec(ByteArrayInputStream(ByteArray(0)), sink).writeFrame("é🚀")
        val expectedBytes = "é🚀".toByteArray(Charsets.UTF_8).size
        check(
            "length is byte count, not char count",
            FrameCodec.decodeLength(sink.toByteArray()) == expectedBytes,
            "header says ${FrameCodec.decodeLength(sink.toByteArray())}, body is $expectedBytes bytes",
        )

        val big = "x".repeat(1_000_000)
        check("1MB frame", roundTrip(listOf(""""$big"""")) == listOf(""""$big""""))
    }

    private fun testCleanEof() {
        println("clean end-of-stream")
        val reader = FrameCodec(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream())
        check("empty stream returns null", reader.readFrame() == null)

        // A peer that disconnects politely between frames is normal, not an error.
        val sink = ByteArrayOutputStream()
        FrameCodec(ByteArrayInputStream(ByteArray(0)), sink).writeFrame("""{"a":1}""")
        val r2 = FrameCodec(ByteArrayInputStream(sink.toByteArray()), ByteArrayOutputStream())
        r2.readFrame()
        check("null after last frame", r2.readFrame() == null)
    }

    private fun testTruncation() {
        println("truncated / hostile input")
        // Partial header.
        expectThrows("partial header throws EOF", EOFException::class.java) {
            FrameCodec(ByteArrayInputStream(byteArrayOf(0, 0)), ByteArrayOutputStream()).readFrame()
        }
        // Header promising 100 bytes, only 5 delivered.
        val truncated = ByteArray(4).also { FrameCodec.encodeLength(100, it) } + "hello".toByteArray()
        expectThrows("truncated body throws EOF", EOFException::class.java) {
            FrameCodec(ByteArrayInputStream(truncated), ByteArrayOutputStream()).readFrame()
        }
        // Absurd length must be refused rather than allocating 2GB.
        val huge = ByteArray(4).also { FrameCodec.encodeLength(Int.MAX_VALUE, it) }
        expectThrows("oversized length refused", IOException::class.java) {
            FrameCodec(ByteArrayInputStream(huge), ByteArrayOutputStream()).readFrame()
        }
        // Negative (high bit set) length must be refused, not treated as small.
        val negative = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte())
        expectThrows("negative length refused", IOException::class.java) {
            FrameCodec(ByteArrayInputStream(negative), ByteArrayOutputStream()).readFrame()
        }
        // Sending beyond the cap must fail fast on the writer side too.
        expectThrows("oversized write refused", IOException::class.java) {
            FrameCodec(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream(), maxFrameBytes = 16)
                .writeFrame("this body is definitely longer than sixteen bytes")
        }
    }

    private fun testDribbleStream() {
        println("fragmented reads (real socket behaviour)")
        // A LocalSocket does NOT guarantee a full frame per read(). Feeding one
        // byte at a time proves readFully() actually loops instead of assuming
        // a single read returns everything.
        val sink = ByteArrayOutputStream()
        val w = FrameCodec(ByteArrayInputStream(ByteArray(0)), sink)
        val msgs = listOf("""{"type":"output","data":"line one"}""", """{"type":"output","data":"line two"}""")
        msgs.forEach { w.writeFrame(it) }

        val dribble = object : InputStream() {
            private val data = sink.toByteArray()
            private var pos = 0
            override fun read(): Int = if (pos >= data.size) -1 else data[pos++].toInt() and 0xFF
            // Force one byte per call regardless of what the caller asked for.
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (pos >= data.size) return -1
                b[off] = data[pos++]
                return 1
            }
        }
        val r = FrameCodec(dribble, ByteArrayOutputStream())
        check("frame 1 across fragmented reads", r.readFrame() == msgs[0])
        check("frame 2 across fragmented reads", r.readFrame() == msgs[1])
        check("null at end", r.readFrame() == null)
    }

    @JvmStatic
    fun main(args: Array<String>) {
        println("=== Part 1 / Phase 0 — FrameCodec (§6.1) ===")
        testLengthCodec()
        testRoundTrip()
        testCleanEof()
        testTruncation()
        testDribbleStream()
        println()
        println("passed=$passed failed=$failed")
        if (failed > 0) {
            println("PHASE 0 GATE: FAILED")
            System.exit(1)
        }
        println("PHASE 0 GATE: PASSED")
    }
}
