package tech.nhz.nhzterm.session

import tech.nhz.nhzterm.api.Protocol
import tech.nhz.nhzterm.pty.NativePty
import tech.nhz.nhzterm.util.DaemonLog
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.lang.reflect.Constructor
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One PTY-backed session (§6.3). Owns the master fd, the child pid, a reader
 * thread, and the scrollback ring.
 *
 * Sessions are headless-first (§2.3): the reader thread runs whether or not
 * anybody is attached, so a build started from Valence Studio keeps making
 * progress with the UI closed, and its output is in scrollback when a client
 * finally attaches.
 */
class PtySession(
    val sessionId: String,
    var name: String,
    val shell: String,
    val cwd: String,
    scrollbackLines: Int,
    initialCols: Int,
    initialRows: Int,
) {

    /** Consumers of live output. Copy-on-write: many reads, rare attach/detach. */
    private val listeners = CopyOnWriteArrayList<(String) -> Unit>()
    private val statusListeners = CopyOnWriteArrayList<(String) -> Unit>()

    val scrollback = ScrollbackBuffer(scrollbackLines)
    val createdAt: Long = System.currentTimeMillis()

    @Volatile var cols: Int = initialCols; private set
    @Volatile var rows: Int = initialRows; private set
    @Volatile var status: String = Protocol.Status.RUNNING; private set
    @Volatile var exitCode: Int? = null; private set

    /** Foreground pid self-reported by nhzsh (§9). Null = nothing running. */
    @Volatile var foregroundPid: Int? = null

    @Volatile var lastActivityAt: Long = System.currentTimeMillis(); private set

    private var masterFd: Int = -1
    private var childPid: Int = -1
    private var readerThread: Thread? = null
    private var output: FileOutputStream? = null
    private val alive = AtomicBoolean(false)

    val pid: Int get() = childPid
    val isAlive: Boolean get() = alive.get()

    /**
     * Spawns the shell on a real PTY.
     * @throws IllegalStateException if the PTY could not be acquired.
     */
    fun start(env: Array<String>) {
        val pidOut = IntArray(1)
        val fd = NativePty.createSubprocess(
            shell, arrayOf(shellArgv0()), env, cwd, cols, rows, pidOut,
        )
        if (fd < 0) throw IllegalStateException("forkpty failed for session $sessionId")

        masterFd = fd
        childPid = pidOut[0]
        alive.set(true)
        status = Protocol.Status.RUNNING

        val jfd = wrapFd(fd)
        output = FileOutputStream(jfd)
        val input = FileInputStream(jfd)

        readerThread = Thread({ readLoop(input) }, "pty-$sessionId").apply {
            isDaemon = true
            start()
        }
        DaemonLog.i("session $sessionId started: pid=$childPid fd=$fd shell=$shell")
    }

    /** argv[0] is what the shell reports as its own name. */
    private fun shellArgv0(): String = shell.substringAfterLast('/')

    private fun readLoop(input: FileInputStream) {
        val buf = ByteArray(READ_CHUNK)
        // A UTF-8 sequence can straddle a read boundary. Decoding each chunk
        // independently would corrupt multibyte glyphs, so carry the remainder.
        var carry = ByteArray(0)

        while (alive.get()) {
            val n = try {
                input.read(buf)
            } catch (t: Throwable) {
                // EIO on the master means the child closed the slave — normal exit.
                break
            }
            if (n < 0) break
            if (n == 0) { Thread.sleep(4); continue }

            lastActivityAt = System.currentTimeMillis()

            val combined = if (carry.isEmpty()) buf.copyOf(n) else carry + buf.copyOf(n)
            val safeLen = truncateToCompleteUtf8(combined)
            carry = if (safeLen < combined.size) combined.copyOfRange(safeLen, combined.size) else ByteArray(0)
            if (safeLen == 0) continue

            val text = String(combined, 0, safeLen, Charsets.UTF_8)
            scrollback.append(text)
            listeners.forEach { l ->
                try { l(text) } catch (t: Throwable) { DaemonLog.w("output listener threw", t) }
            }
        }
        onChildExited()
    }

    /**
     * Returns the length of the longest prefix ending on a complete UTF-8
     * sequence, so we never split a multibyte character across two frames.
     */
    private fun truncateToCompleteUtf8(b: ByteArray): Int {
        var i = b.size
        var scanned = 0
        while (i > 0 && scanned < 4) {
            val c = b[i - 1].toInt() and 0xFF
            if (c and 0x80 == 0) return i                 // ASCII: complete
            if (c and 0xC0 == 0xC0) {                     // lead byte
                val need = when {
                    c and 0xE0 == 0xC0 -> 2
                    c and 0xF0 == 0xE0 -> 3
                    c and 0xF8 == 0xF0 -> 4
                    else -> 1
                }
                val have = b.size - (i - 1)
                return if (have >= need) b.size else i - 1
            }
            i--; scanned++                                 // continuation byte
        }
        return b.size
    }

    private fun onChildExited() {
        if (!alive.compareAndSet(true, false)) return
        exitCode = try { NativePty.waitFor(childPid, false) } catch (t: Throwable) { null }
        status = Protocol.Status.FINISHED
        foregroundPid = null
        DaemonLog.i("session $sessionId finished: pid=$childPid exit=$exitCode")
        statusListeners.forEach {
            try { it(status) } catch (t: Throwable) { DaemonLog.w("status listener threw", t) }
        }
    }

    /** session.write (§6.3) — bytes go in as if typed. */
    fun write(data: String) {
        if (!alive.get()) return
        try {
            output?.apply {
                write(data.toByteArray(Charsets.UTF_8))
                flush()
            }
            lastActivityAt = System.currentTimeMillis()
        } catch (t: Throwable) {
            DaemonLog.w("session $sessionId write failed", t)
        }
    }

    /** session.resize (§6.3) — kernel raises SIGWINCH so TUIs redraw. */
    fun resize(newCols: Int, newRows: Int) {
        if (newCols <= 0 || newRows <= 0) return
        cols = newCols; rows = newRows
        if (alive.get() && masterFd >= 0) NativePty.setWinSize(masterFd, newCols, newRows)
    }

    fun addOutputListener(l: (String) -> Unit) { listeners.add(l) }
    fun removeOutputListener(l: (String) -> Unit) { listeners.remove(l) }
    fun addStatusListener(l: (String) -> Unit) { statusListeners.add(l) }
    fun removeStatusListener(l: (String) -> Unit) { statusListeners.remove(l) }
    fun attachedClients(): Int = listeners.size

    /**
     * session.kill (§6.3). Decision 3 (§14): SIGTERM, grace, then SIGKILL, so
     * the shell can restore the terminal and flush state before it dies.
     */
    fun kill(graceMs: Long) {
        if (childPid <= 0) return
        DaemonLog.i("session $sessionId: SIGTERM -> pid $childPid (grace ${graceMs}ms)")
        runCatching { NativePty.sendSignalToGroup(childPid, NativePty.SIGTERM) }

        if (graceMs > 0) {
            val deadline = System.currentTimeMillis() + graceMs
            while (System.currentTimeMillis() < deadline) {
                if (!alive.get() || NativePty.waitFor(childPid, false) >= 0) break
                Thread.sleep(50)
            }
        }
        if (alive.get()) {
            DaemonLog.i("session $sessionId: grace expired, SIGKILL")
            runCatching { NativePty.sendSignalToGroup(childPid, NativePty.SIGKILL) }
        }
        shutdown()
    }

    fun shutdown() {
        alive.set(false)
        readerThread?.interrupt()
        runCatching { output?.close() }
        if (masterFd >= 0) { runCatching { NativePty.closeFd(masterFd) }; masterFd = -1 }
        if (status != Protocol.Status.FINISHED) status = Protocol.Status.FINISHED
    }

    /** Marks idle when nothing has happened for a while (§6.3 status). */
    fun refreshIdleStatus(idleAfterMs: Long = 30_000L) {
        if (!alive.get()) return
        status = if (System.currentTimeMillis() - lastActivityAt > idleAfterMs) {
            Protocol.Status.IDLE
        } else {
            Protocol.Status.RUNNING
        }
    }

    private companion object {
        const val READ_CHUNK = 8192

        /**
         * There is no public API to build a FileDescriptor from an int, but
         * every Android terminal app does this; the field is stable across
         * all supported API levels.
         */
        fun wrapFd(fd: Int): FileDescriptor {
            return try {
                val ctor: Constructor<FileDescriptor> =
                    FileDescriptor::class.java.getDeclaredConstructor(Int::class.javaPrimitiveType)
                ctor.isAccessible = true
                ctor.newInstance(fd)
            } catch (t: Throwable) {
                val jfd = FileDescriptor()
                val f = FileDescriptor::class.java.getDeclaredField("descriptor")
                f.isAccessible = true
                f.setInt(jfd, fd)
                jfd
            }
        }
    }
}
