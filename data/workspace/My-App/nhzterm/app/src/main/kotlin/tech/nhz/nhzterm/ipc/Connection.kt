package tech.nhz.nhzterm.ipc

import android.net.LocalSocket
import tech.nhz.nhzterm.api.FrameCodec
import tech.nhz.nhzterm.util.DaemonLog
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * One client connection: framing + a dedicated writer thread + the protocol
 * handler.
 *
 * Why a writer QUEUE rather than writing inline from the PTY reader thread:
 * a slow or stalled client (screen off, WebView suspended) would otherwise
 * block on a full socket buffer and stall the session's reader thread — one
 * unresponsive UI would freeze a build. Queueing decouples them, and an
 * over-full queue drops the client instead of the daemon.
 */
class Connection(
    private val socket: LocalSocket,
    private val id: Int,
    handlerFactory: ((String) -> Unit) -> ProtocolHandler,
) {

    private val codec = FrameCodec(socket.inputStream, socket.outputStream)
    private val outbox = LinkedBlockingQueue<String>(OUTBOX_CAPACITY)

    @Volatile private var running = true

    private val handler: ProtocolHandler = handlerFactory { frame -> enqueue(frame) }

    private fun enqueue(frame: String) {
        if (!running) return
        // offer(), never put(): blocking here would propagate backpressure into
        // the PTY reader thread, which must never stall.
        if (!outbox.offer(frame)) {
            DaemonLog.w("connection #$id outbox full — dropping client")
            running = false
            runCatching { socket.close() }
        }
    }

    fun serve() {
        val writer = Thread({ writeLoop() }, "nhztermd-tx-$id").apply {
            isDaemon = true
            start()
        }
        try {
            while (running) {
                val frame = try {
                    codec.readFrame()
                } catch (io: IOException) {
                    DaemonLog.d("connection #$id read error: ${io.message}")
                    break
                } ?: break // clean EOF
                handler.onFrame(frame)
            }
        } finally {
            running = false
            handler.close()
            writer.interrupt()
            runCatching { socket.close() }
            DaemonLog.d("connection #$id served, cleaned up")
        }
    }

    private fun writeLoop() {
        while (running) {
            val frame = try {
                outbox.poll(200, TimeUnit.MILLISECONDS)
            } catch (i: InterruptedException) {
                break
            } ?: continue
            try {
                codec.writeFrame(frame)
            } catch (io: IOException) {
                DaemonLog.d("connection #$id write failed: ${io.message}")
                running = false
                break
            }
        }
    }

    private companion object {
        /** ~8k frames of backlog before a client is considered hopeless. */
        const val OUTBOX_CAPACITY = 8192
    }
}
