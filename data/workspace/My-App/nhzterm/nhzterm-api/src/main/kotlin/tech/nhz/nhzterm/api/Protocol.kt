package tech.nhz.nhzterm.api

/**
 * nhzterm-api protocol constants — concept doc §6.
 *
 * Transport: Android LocalSocket, ABSTRACT namespace (no filesystem path).
 * Framing:   4-byte big-endian unsigned length header + UTF-8 JSON body.
 */
object Protocol {

    /** Integer protocol version exchanged in the handshake (§6.2, §8). */
    const val VERSION: Int = 1

    /**
     * Abstract-namespace LocalSocket name. Abstract sockets have no path on
     * disk, so there is nothing to chmod — the auth token (§13) plus Android's
     * per-app sandbox are the actual boundary.
     */
    const val SOCKET_NAME: String = "tech.nhz.nhzterm.nhztermd"

    /** Max accepted frame body, guards against a hostile/desynced peer. */
    const val MAX_FRAME_BYTES: Int = 8 * 1024 * 1024

    /** Message `type` values. */
    object Type {
        const val HELLO = "hello"
        const val HELLO_ACK = "hello_ack"
        const val REQUEST = "request"
        const val RESPONSE = "response"

        // Streamed events, daemon -> client (§6.5)
        const val OUTPUT = "output"
        const val SESSION_STATUS_CHANGED = "session_status_changed"
        const val ERROR = "error"

        // Control side-channel, nhzsh -> daemon (§9)
        const val FOREGROUND_PID = "foreground_pid"
    }

    /** Method names (§6.3, §6.4). Public surface must match the doc exactly. */
    object Method {
        const val SESSION_CREATE = "session.create"
        const val SESSION_ATTACH = "session.attach"
        const val SESSION_LIST = "session.list"
        const val SESSION_KILL = "session.kill"
        const val SESSION_WRITE = "session.write"
        const val SESSION_RESIZE = "session.resize"
        const val SESSION_RENAME = "session.rename"

        const val PROCESS_SPAWN = "process.spawn"
        const val PROCESS_STATUS = "process.status"
        const val PROCESS_STOP = "process.stop"
        const val PROCESS_LIST = "process.list"
        const val PROCESS_KILL = "process.kill"
    }

    /** Error codes — initial set (§6.6). */
    object ErrorCode {
        const val AUTH_FAILED = "AUTH_FAILED"
        const val PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH"
        const val SESSION_LIMIT_REACHED = "SESSION_LIMIT_REACHED"
        const val SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
        const val PROCESS_NOT_FOUND = "PROCESS_NOT_FOUND"
        const val INTERNAL_ERROR = "INTERNAL_ERROR"
    }

    /** Handshake rejection reasons (§6.2). */
    object Reason {
        const val BAD_TOKEN = "bad_token"
        const val PROTOCOL_MISMATCH = "protocol_mismatch"
    }

    /** Session status values (§6.3 `session.list`). */
    object Status {
        const val RUNNING = "running"
        const val IDLE = "idle"
        const val FINISHED = "finished"
    }

    /** Operational limits (§8). */
    object Limits {
        const val MAX_SESSIONS = 15
        const val SCROLLBACK_LINES = 5000
        const val DEFAULT_COLS = 80
        const val DEFAULT_ROWS = 24
    }
}
