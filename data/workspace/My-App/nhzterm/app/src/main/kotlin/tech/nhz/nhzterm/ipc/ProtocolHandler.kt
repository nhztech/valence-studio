package tech.nhz.nhzterm.ipc

import org.json.JSONArray
import org.json.JSONObject
import tech.nhz.nhzterm.api.Protocol
import tech.nhz.nhzterm.session.PtySession
import tech.nhz.nhzterm.session.ProcessManager
import tech.nhz.nhzterm.session.SessionError
import tech.nhz.nhzterm.session.SessionManager
import tech.nhz.nhzterm.util.DaemonLog

/**
 * The protocol brain (§6.2-§6.6).
 *
 * Transport-agnostic on purpose: it takes a request STRING and emits response
 * STRINGS through a sink. That is what lets the same code serve a LocalSocket
 * client (Valence Studio) and the in-app WebView JavascriptInterface bridge
 * with zero duplication (§3).
 */
class ProtocolHandler(
    private val authToken: String,
    private val sessions: SessionManager,
    private val processes: ProcessManager,
    private val tokenMatcher: (String, String?) -> Boolean,
    /** Emits a frame back to this client. Must be safe to call from any thread. */
    private val send: (String) -> Unit,
) {

    @Volatile
    private var authenticated = false

    /** Sessions this connection is streaming, so detach can be clean. */
    private val attached = mutableMapOf<String, Pair<(String) -> Unit, (String) -> Unit>>()

    val isAuthenticated: Boolean get() = authenticated

    /** Feeds one inbound frame. Never throws — always answers something. */
    fun onFrame(raw: String) {
        val msg = try {
            JSONObject(raw)
        } catch (t: Throwable) {
            sendError(null, Protocol.ErrorCode.INTERNAL_ERROR, "malformed json")
            return
        }

        when (val type = msg.optString("type")) {
            Protocol.Type.HELLO -> handleHello(msg)
            Protocol.Type.REQUEST -> handleRequest(msg)
            Protocol.Type.FOREGROUND_PID -> handleForegroundPid(msg)
            else -> sendError(msg.optString("id", null), Protocol.ErrorCode.INTERNAL_ERROR, "unknown type: $type")
        }
    }

    // ---- Phase 2: handshake (§6.2) -----------------------------------------

    private fun handleHello(msg: JSONObject) {
        val version = msg.optInt("protocol_version", -1)

        // Version is checked FIRST: a client speaking a different protocol may
        // not even be able to parse our rejection, so give it the precise
        // reason rather than a confusing auth failure.
        if (version != Protocol.VERSION) {
            DaemonLog.w("handshake rejected: protocol $version != ${Protocol.VERSION}")
            send(
                JSONObject().apply {
                    put("type", Protocol.Type.HELLO_ACK)
                    put("protocol_version", Protocol.VERSION)
                    put("accepted", false)
                    put("reason", Protocol.Reason.PROTOCOL_MISMATCH)
                }.toString(),
            )
            return
        }

        val token = if (msg.has("token") && !msg.isNull("token")) msg.optString("token") else null
        if (!tokenMatcher(authToken, token)) {
            DaemonLog.w("handshake rejected: bad token")
            send(
                JSONObject().apply {
                    put("type", Protocol.Type.HELLO_ACK)
                    put("protocol_version", Protocol.VERSION)
                    put("accepted", false)
                    put("reason", Protocol.Reason.BAD_TOKEN)
                }.toString(),
            )
            return
        }

        authenticated = true
        DaemonLog.i("handshake accepted (protocol v${Protocol.VERSION})")
        send(
            JSONObject().apply {
                put("type", Protocol.Type.HELLO_ACK)
                put("protocol_version", Protocol.VERSION)
                put("accepted", true)
            }.toString(),
        )
    }

    // ---- Phases 3 & 4: method dispatch -------------------------------------

    private fun handleRequest(msg: JSONObject) {
        val id = msg.optString("id", null)
        val method = msg.optString("method")
        val params = msg.optJSONObject("params") ?: JSONObject()

        // Nothing but hello works before auth. This is the whole point of the
        // handshake — an unauthenticated peer must not enumerate sessions.
        if (!authenticated) {
            sendError(id, Protocol.ErrorCode.AUTH_FAILED, "handshake required before $method")
            return
        }

        try {
            val result = dispatch(method, params)
            if (result != null) sendResponse(id, result)
        } catch (e: SessionError) {
            sendError(id, e.code, e.message ?: e.code)
        } catch (t: Throwable) {
            DaemonLog.e("method $method failed", t)
            sendError(id, Protocol.ErrorCode.INTERNAL_ERROR, t.message ?: "internal error")
        }
    }

    private fun dispatch(method: String, p: JSONObject): JSONObject? = when (method) {

        Protocol.Method.SESSION_CREATE -> {
            val s = sessions.create(
                shell = p.optString("shell", null),
                cwd = p.optString("cwd", null),
                cols = p.optInt("cols", Protocol.Limits.DEFAULT_COLS),
                rows = p.optInt("rows", Protocol.Limits.DEFAULT_ROWS),
                name = p.optString("name", null),
            )
            JSONObject().apply {
                put("session_id", s.sessionId)
                put("pty_cols", s.cols)
                put("pty_rows", s.rows)
            }
        }

        Protocol.Method.SESSION_ATTACH -> {
            val s = sessions.require(p.getString("session_id"))
            attach(s)
            JSONObject().apply {
                put("scrollback", s.scrollback.snapshot())
                put("status", s.status)
            }
        }

        Protocol.Method.SESSION_LIST -> JSONObject().apply {
            put(
                "sessions",
                JSONArray().apply {
                    sessions.list().forEach { s ->
                        put(
                            JSONObject().apply {
                                put("session_id", s.sessionId)
                                put("name", s.name)
                                put("status", s.status)
                                put("created_at", s.createdAt)
                            },
                        )
                    }
                },
            )
        }

        Protocol.Method.SESSION_KILL -> {
            val sid = p.getString("session_id")
            detach(sid)
            sessions.kill(sid)
            ok()
        }

        // Fire-and-forget (§6.3): output comes back on the stream, not as a reply.
        Protocol.Method.SESSION_WRITE -> {
            sessions.require(p.getString("session_id")).write(p.optString("data", ""))
            null
        }

        Protocol.Method.SESSION_RESIZE -> {
            sessions.require(p.getString("session_id"))
                .resize(p.getInt("cols"), p.getInt("rows"))
            ok()
        }

        Protocol.Method.SESSION_RENAME -> {
            sessions.rename(p.getString("session_id"), p.getString("name"))
            ok()
        }

        Protocol.Method.PROCESS_SPAWN -> {
            val args = p.optJSONArray("args")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            val t = processes.spawn(p.getString("cmd"), args, p.optString("cwd", null))
            JSONObject().apply {
                put("process_id", t.processId)
                put("pid", t.pid)
            }
        }

        Protocol.Method.PROCESS_STATUS -> {
            val t = processes.require(p.getString("process_id"))
            JSONObject().apply {
                put("status", if (t.isRunning) "running" else "exited")
                t.exitCode?.let { put("exit_code", it) }
            }
        }

        Protocol.Method.PROCESS_STOP -> {
            processes.stop(p.getString("process_id"))
            ok()
        }

        Protocol.Method.PROCESS_LIST -> JSONObject().apply {
            put(
                "processes",
                JSONArray().apply {
                    processes.list().forEach { t ->
                        put(
                            JSONObject().apply {
                                put("process_id", t.processId)
                                put("pid", t.pid)
                                put("cmd", t.cmd)
                                put("status", if (t.isRunning) "running" else "exited")
                                t.exitCode?.let { put("exit_code", it) }
                            },
                        )
                    }
                },
            )
        }

        /**
         * §9. Accepts an explicit pid, or resolves the session's tracked
         * foreground pid. If nothing is in the foreground it returns
         * PROCESS_NOT_FOUND rather than silently doing nothing.
         */
        Protocol.Method.PROCESS_KILL -> {
            val pid = when {
                p.has("pid") && !p.isNull("pid") -> p.optInt("pid").takeIf { it > 0 }
                p.has("session_id") -> sessions.require(p.getString("session_id")).foregroundPid
                else -> null
            }
            processes.killPid(pid)
            ok()
        }

        else -> throw SessionError(Protocol.ErrorCode.INTERNAL_ERROR, "unknown method: $method")
    }

    /** §9 control side-channel: nhzsh reporting what is in the foreground. */
    private fun handleForegroundPid(msg: JSONObject) {
        if (!authenticated) return
        val sid = msg.optString("session_id")
        val session = sessions.get(sid) ?: return
        session.foregroundPid = if (msg.isNull("pid")) null else msg.optInt("pid").takeIf { it > 0 }
        DaemonLog.d("foreground_pid: $sid -> ${session.foregroundPid}")
    }

    // ---- streaming (§6.5) ---------------------------------------------------

    private fun attach(s: PtySession) {
        if (attached.containsKey(s.sessionId)) return

        val outListener: (String) -> Unit = { data ->
            send(
                JSONObject().apply {
                    put("type", Protocol.Type.OUTPUT)
                    put("session_id", s.sessionId)
                    put("data", data)
                }.toString(),
            )
        }
        val statusListener: (String) -> Unit = { st ->
            send(
                JSONObject().apply {
                    put("type", Protocol.Type.SESSION_STATUS_CHANGED)
                    put("session_id", s.sessionId)
                    put("status", st)
                }.toString(),
            )
        }

        s.addOutputListener(outListener)
        s.addStatusListener(statusListener)
        attached[s.sessionId] = outListener to statusListener
    }

    private fun detach(sessionId: String) {
        val pair = attached.remove(sessionId) ?: return
        sessions.get(sessionId)?.let {
            it.removeOutputListener(pair.first)
            it.removeStatusListener(pair.second)
        }
    }

    /** Must run when the connection drops, or a dead client leaks listeners. */
    fun close() {
        attached.keys.toList().forEach { detach(it) }
        attached.clear()
    }

    // ---- helpers ------------------------------------------------------------

    private fun ok() = JSONObject().put("ok", true)

    private fun sendResponse(id: String?, result: JSONObject) {
        send(
            JSONObject().apply {
                put("type", Protocol.Type.RESPONSE)
                if (id != null) put("id", id)
                put("result", result)
            }.toString(),
        )
    }

    private fun sendError(id: String?, code: String, message: String) {
        send(
            JSONObject().apply {
                put("type", Protocol.Type.ERROR)
                if (id != null) put("id", id)
                put("code", code)
                put("message", message)
            }.toString(),
        )
    }
}
