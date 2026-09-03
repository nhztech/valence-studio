package tech.nhz.nhzterm.api

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * Length-prefixed JSON framing (§6.1).
 *
 * Wire format, per message:
 *   [0..3]  body length, 4-byte BIG-ENDIAN unsigned int
 *   [4..n]  body, UTF-8 JSON
 *
 * Deliberately depends on nothing Android-specific: it operates on plain
 * InputStream/OutputStream so it works identically over a LocalSocket, over
 * the in-app JavascriptInterface bridge, and inside JVM unit tests.
 *
 * Not internally synchronized. The daemon gives each connection its own
 * codec, and serializes writes through a single writer per connection.
 */
class FrameCodec(
    private val input: InputStream,
    private val output: OutputStream,
    private val maxFrameBytes: Int = Protocol.MAX_FRAME_BYTES,
) {

    private val header = ByteArray(4)

    /** Writes one frame. Flushes, so the peer sees it immediately. */
    @Throws(IOException::class)
    fun writeFrame(json: String) {
        val body = json.toByteArray(Charsets.UTF_8)
        if (body.size > maxFrameBytes) {
            throw IOException("frame too large to send: ${body.size} > $maxFrameBytes")
        }
        encodeLength(body.size, header)
        synchronized(output) {
            output.write(header)
            output.write(body)
            output.flush()
        }
    }

    /**
     * Reads exactly one frame.
     * @return the UTF-8 JSON body, or null on a clean end-of-stream
     *         (peer closed between frames — normal disconnect, not an error).
     * @throws IOException on a truncated frame or a length that violates the cap.
     */
    @Throws(IOException::class)
    fun readFrame(): String? {
        if (!readFullyOrEof(header)) return null

        val length = decodeLength(header)
        if (length < 0 || length > maxFrameBytes) {
            // Either a hostile peer or the stream has desynced. Both are
            // unrecoverable for this connection: the next bytes cannot be
            // trusted to be a header, so the caller must drop the connection.
            throw IOException("invalid frame length: $length (max $maxFrameBytes)")
        }
        if (length == 0) return ""

        val body = ByteArray(length)
        if (!readFullyOrEof(body)) {
            throw EOFException("truncated frame body: expected $length bytes")
        }
        return String(body, Charsets.UTF_8)
    }

    /**
     * Fills [buf] completely.
     * @return false only if EOF arrived before ANY byte was read.
     * @throws EOFException if EOF arrived mid-buffer (partial read).
     */
    @Throws(IOException::class)
    private fun readFullyOrEof(buf: ByteArray): Boolean {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n < 0) {
                if (off == 0) return false
                throw EOFException("stream ended mid-frame after $off/${buf.size} bytes")
            }
            off += n
        }
        return true
    }

    companion object {
        /** Big-endian, unsigned. */
        fun encodeLength(length: Int, into: ByteArray) {
            into[0] = (length ushr 24 and 0xFF).toByte()
            into[1] = (length ushr 16 and 0xFF).toByte()
            into[2] = (length ushr 8 and 0xFF).toByte()
            into[3] = (length and 0xFF).toByte()
        }

        /**
         * Decodes a big-endian unsigned length into an Int.
         * Values above Int.MAX_VALUE come back negative and are rejected by
         * the caller as invalid — 2 GiB frames are nonsense here regardless.
         */
        fun decodeLength(from: ByteArray): Int {
            return ((from[0].toInt() and 0xFF) shl 24) or
                ((from[1].toInt() and 0xFF) shl 16) or
                ((from[2].toInt() and 0xFF) shl 8) or
                (from[3].toInt() and 0xFF)
        }
    }
}
