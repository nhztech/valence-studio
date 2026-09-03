package tech.nhz.nhzterm.ipc

import android.net.LocalServerSocket
import android.net.LocalSocket
import tech.nhz.nhzterm.util.DaemonLog
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Phase 0: accept raw LocalSocket connections and hand each to a handler on
 * its own thread. NO protocol logic lives here — the handshake (Phase 2) and
 * the method dispatch (Phase 3/4) are layered on top by the caller.
 *
 * Abstract namespace, so there is no socket file to create, chmod, or clean up
 * after a crash (§12.2).
 */
class SocketListener(
    private val socketName: String,
    private val onConnection: (LocalSocket, Int) -> Unit,
) {

    private val running = AtomicBoolean(false)
    private val connectionIds = AtomicInteger(0)

    private var server: LocalServerSocket? = null
    private var acceptThread: Thread? = null

    // Each connection is long-lived (a client stays attached streaming output),
    // so a cached pool of one-thread-per-connection is the honest model here,
    // not a fixed pool that could starve.
    private val workers = Executors.newCachedThreadPool { r ->
        Thread(r, "nhztermd-conn").apply { isDaemon = true }
    }

    val isRunning: Boolean get() = running.get()

    @Throws(IOException::class)
    fun start() {
        if (!running.compareAndSet(false, true)) return

        // Binding fails with EADDRINUSE if a previous instance is still alive.
        // That is deliberately fatal: two daemons owning PTYs would be worse
        // than none, and START_STICKY will retry us.
        server = LocalServerSocket(socketName)
        DaemonLog.i("listening on abstract LocalSocket: $socketName")

        acceptThread = Thread({ acceptLoop() }, "nhztermd-accept").apply {
            isDaemon = true
            start()
        }
    }

    private fun acceptLoop() {
        val srv = server ?: return
        while (running.get()) {
            val client = try {
                srv.accept()
            } catch (io: IOException) {
                // close() on the server socket unblocks accept() by throwing;
                // that's a normal shutdown, not a failure.
                if (running.get()) DaemonLog.e("accept failed", io)
                break
            }
            val id = connectionIds.incrementAndGet()
            DaemonLog.d("connection #$id accepted")
            try {
                workers.execute {
                    try {
                        onConnection(client, id)
                    } catch (t: Throwable) {
                        DaemonLog.e("connection #$id handler crashed", t)
                    } finally {
                        runCatching { client.close() }
                        DaemonLog.d("connection #$id closed")
                    }
                }
            } catch (t: Throwable) {
                DaemonLog.e("could not dispatch connection #$id", t)
                runCatching { client.close() }
            }
        }
        DaemonLog.i("accept loop ended")
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        runCatching { server?.close() }
        server = null
        acceptThread?.interrupt()
        acceptThread = null
        workers.shutdownNow()
        DaemonLog.i("listener stopped")
    }
}
