package tech.nhz.nhzterm.api

import android.net.LocalSocket
import android.net.LocalSocketAddress
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * nhzterm-api — the documented client library (Part 1, Phase 6).
 *
 * This is what Valence Studio (or any other consumer) imports instead of
 * hand-building socket messages. The public surface matches §6.3/§6.4 exactly.
 *
 * Usage:
 *   val c = NhztermClient()
 *   c.connect(token)
 *   val s = c.sessionCreate()
 *   c.onOutput = { id, data -> print(data) }
 *   c.sessionAttach(s.sessionId)
 *   c.sessionWrite(s.sessionId, "ls -la\n")
 */
class NhztermClient(
    private val socketName: String = Protocol.SOCKET_NAME,
    private val timeoutMs: Long = 10_000L,
) : AutoCloseable {

    data class Session(val sessionId: String, val cols: Int, val rows: Int)
    data class SessionInfo(val sessionId: String, val name: String, val status: String, val createdAt: Long)
    data class Attached(val scrollback: String, val status: String)
    data class SpawnedProcess(val processId: String, val pid: Int)
    data class ProcessStatus(val status: String, val exitCode: Int?)

    class ProtocolException(val code: String, message: String) : IOException(message)

    /** Streamed events (§6.5). Called on the reader thread — do not block. */
    var onOutput: ((sessionId: String, data: String) -> Unit)? = null
    var onStatusChanged: ((sessionId: String, status: String) -> Unit)? = null
    var onDisconnected: (() -> Unit)? = null

    private var socket: LocalSocket? = null
    private var codec: FrameCodec? = null
    private var reader: Thread? = null

    private val requestIds = AtomicInteger(0)
    private val waiters = ConcurrentHashMap<String, Waiter>()

    @Volatile private var running = false

    private class Waiter {
        val latch = CountDownLatch(1)
        @Volatile var result: JSONObject? = null
        @Volatile var error: ProtocolException? = null
    }

    val isConnected: Boolean get() = running

    /**
     * Connects and performs the §6.2 handshake.
     * @throws ProtocolException on AUTH_FAILED / PROTOCOL_MISMATCH.
     */
    @Throws(IOException::class)
    fun connect(token: String) {
        val s = LocalSocket()
        s.connect(LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT))
        s.soTimeout = 0 // blocking reads; the reader thread owns this socket

        socket = s
        codec = FrameCodec(s.inputStream, s.outputStream)
        running = true

        reader = Thread({ readLoop() }, "nhzterm-api-rx").apply {
            isDaemon = true
            start()
        }

        val ack = exchange(
            JSONObject().apply {
                put("type", Protocol.Type.HELLO)
                put("protocol_version", Protocol.VERSION)
                put("token", token)
            },
            expectType = Protocol.Type.HELLO_ACK,
        )

        if (!ack.optBoolean("accepted", false)) {
            val reason = ack.optString("reason", "unknown")
            close()
            val code = if (reason == Protocol.Reason.PROTOCOL_MISMATCH) {
                Protocol.ErrorCode.PROTOCOL_MISMATCH
            } else {
                Protocol.ErrorCode.AUTH_FAILED
            }
            throw ProtocolException(code, "handshake rejected: $reason")
        }
    }

    /** Reads the token from a path the daemon wrote (§13). */
    @Throws(IOException::class)
    fun connectWithTokenFile(tokenFile: File) = connect(tokenFile.readText().trim())

    // ---- session methods (§6.3) --------------------------------------------

    fun sessionCreate(
        shell: String? = null,
        cwd: String? = null,
        cols: Int = Protocol.Limits.DEFAULT_COLS,
        rows: Int = Protocol.Limits.DEFAULT_ROWS,
    ): Session {
        val r = call(
            Protocol.Method.SESSION_CREATE,
            JSONObject().apply {
                shell?.let { put("shell", it) }
                cwd?.let { put("cwd", it) }
                put("cols", cols)
                put("rows", rows)
            },
        )
        return Session(
            r.getString("session_id"),
            r.optInt("pty_cols", cols),
            r.optInt("pty_rows", rows),
        )
    }

    fun sessionAttach(sessionId: String): Attached {
        val r = call(Protocol.Method.SESSION_ATTACH, JSONObject().put("session_id", sessionId))
        return Attached(r.optString("scrollback", ""), r.optString("status", Protocol.Status.RUNNING))
    }

    fun sessionList(): List<SessionInfo> {
        val r = call(Protocol.Method.SESSION_LIST, JSONObject())
        val arr: JSONArray = r.optJSONArray("sessions") ?: JSONArray()
        return (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            SessionInfo(
                o.getString("session_id"),
                o.optString("name", ""),
                o.optString("status", ""),
                o.optLong("created_at", 0L),
            )
        }
    }

    fun sessionKill(sessionId: String) {
        call(Protocol.Method.SESSION_KILL, JSONObject().put("session_id", sessionId))
    }

    /** Fire and forget (§6.3) — output returns on the stream, not as a reply. */
    fun sessionWrite(sessionId: String, data: String) {
        emit(
            JSONObject().apply {
                put("type", Protocol.Type.REQUEST)
                put("method", Protocol.Method.SESSION_WRITE)
                put("params", JSONObject().put("session_id", sessionId).put("data", data))
            },
        )
    }

    fun sessionResize(sessionId: String, cols: Int, rows: Int) {
        call(
            Protocol.Method.SESSION_RESIZE,
            JSONObject().put("session_id", sessionId).put("cols", cols).put("rows", rows),
        )
    }

    fun sessionRename(sessionId: String, name: String) {
        call(Protocol.Method.SESSION_RENAME, JSONObject().put("session_id", sessionId).put("name", name))
    }

    // ---- process methods (§6.4) --------------------------------------------

    fun processSpawn(cmd: String, args: List<String> = emptyList(), cwd: String? = null): SpawnedProcess {
        val r = call(
            Protocol.Method.PROCESS_SPAWN,
            JSONObject().apply {
                put("cmd", cmd)
                put("args", JSONArray(args))
                cwd?.let { put("cwd", it) }
            },
        )
        return SpawnedProcess(r.getString("process_id"), r.optInt("pid", -1))
    }

    fun processStatus(processId: String): ProcessStatus {
        val r = call(Protocol.Method.PROCESS_STATUS, JSONObject().put("process_id", processId))
        return ProcessStatus(
            r.optString("status", "unknown"),
            if (r.has("exit_code")) r.getInt("exit_code") else null,
        )
    }

    fun processStop(processId: String) {
        call(Protocol.Method.PROCESS_STOP, JSONObject().put("process_id", processId))
    }

    fun processList(): List<JSONObject> {
        val r = call(Protocol.Method.PROCESS_LIST, JSONObject())
        val arr = r.optJSONArray("processes") ?: JSONArray()
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    /** §9. Pass a pid, or a sessionId to target its tracked foreground pid. */
    fun processKill(pid: Int? = null, sessionId: String? = null) {
        call(
            Protocol.Method.PROCESS_KILL,
            JSONObject().apply {
                pid?.let { put("pid", it) }
                sessionId?.let { put("session_id", it) }
            },
        )
    }

    // ---- plumbing ------------------------------------------------------------

    private fun call(method: String, params: JSONObject): JSONObject {
        val id = "c" + requestIds.incrementAndGet()
        return exchange(
            JSONObject().apply {
                put("type", Protocol.Type.REQUEST)
                put("id", id)
                put("method", method)
                put("params", params)
            },
            requestId = id,
        )
    }

    /** Sends and blocks for the matching reply. */
    private fun exchange(
        msg: JSONObject,
        requestId: String? = null,
        expectType: String? = null,
    ): JSONObject {
        val key = requestId ?: expectType ?: throw IllegalArgumentException("no correlation key")
        val waiter = Waiter()
        waiters[key] = waiter
        try {
            emit(msg)
            if (!waiter.latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                throw IOException("timeout waiting for $key")
            }
            waiter.error?.let { throw it }
            return waiter.result ?: JSONObject()
        } finally {
            waiters.remove(key)
        }
    }

    private fun emit(msg: JSONObject) {
        val c = codec ?: throw IOException("not connected")
        c.writeFrame(msg.toString())
    }

    private fun readLoop() {
        val c = codec ?: return
        try {
            while (running) {
                val raw = c.readFrame() ?: break
                val msg = try { JSONObject(raw) } catch (t: Throwable) { continue }

                when (msg.optString("type")) {
                    Protocol.Type.OUTPUT ->
                        onOutput?.invoke(msg.optString("session_id"), msg.optString("data"))

                    Protocol.Type.SESSION_STATUS_CHANGED ->
                        onStatusChanged?.invoke(msg.optString("session_id"), msg.optString("status"))

                    Protocol.Type.HELLO_ACK ->
                        complete(Protocol.Type.HELLO_ACK, msg, null)

                    Protocol.Type.RESPONSE ->
                        complete(msg.optString("id"), msg.optJSONObject("result") ?: JSONObject(), null)

                    Protocol.Type.ERROR -> {
                        val err = ProtocolException(
                            msg.optString("code", Protocol.ErrorCode.INTERNAL_ERROR),
                            msg.optString("message", "error"),
                        )
                        val id = msg.optString("id", "")
                        if (id.isNotEmpty()) complete(id, null, err)
                        // An error with no id is an unsolicited stream event;
                        // there is no caller to hand it to.
                    }
                }
            }
        } catch (t: Throwable) {
            // Fall through to cleanup.
        } finally {
            running = false
            // Never leave a caller blocked forever on a dead connection.
            waiters.values.forEach {
                it.error = ProtocolException(Protocol.ErrorCode.INTERNAL_ERROR, "connection closed")
                it.latch.countDown()
            }
            waiters.clear()
            onDisconnected?.invoke()
        }
    }

    private fun complete(key: String, result: JSONObject?, error: ProtocolException?) {
        val w = waiters[key] ?: return
        w.result = result
        w.error = error
        w.latch.countDown()
    }

    override fun close() {
        running = false
        runCatching { socket?.close() }
        socket = null
        codec = null
        reader?.interrupt()
        reader = null
    }
}
