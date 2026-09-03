package tech.nhz.nhzterm.ui

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import tech.nhz.nhzterm.daemon.AuthToken
import tech.nhz.nhzterm.daemon.NhztermdService
import tech.nhz.nhzterm.ipc.ProtocolHandler
import tech.nhz.nhzterm.util.DaemonLog

/**
 * In-app bridge (§3): xterm.js in the WebView talks to nhztermd through a
 * JavascriptInterface, NOT a socket.
 *
 * Since the UI and the daemon live in the same app, there is no separate
 * bridge process, no network hop, and no WebSocket server — that design was
 * explicitly superseded (§15). A genuinely external client (Valence Studio)
 * still uses the LocalSocket path; both share ProtocolHandler, so the two
 * transports can never drift apart.
 */
class TerminalBridge(
    private val service: NhztermdService,
    private val webView: WebView,
) {

    private val handler: ProtocolHandler = ProtocolHandler(
        authToken = service.authToken,
        sessions = service.sessions,
        processes = service.processes,
        tokenMatcher = AuthToken::matches,
        send = { frame -> deliver(frame) },
    )

    /** JS -> native. Same JSON messages as the socket protocol. */
    @JavascriptInterface
    fun send(json: String) {
        try {
            handler.onFrame(json)
        } catch (t: Throwable) {
            DaemonLog.e("bridge send failed", t)
        }
    }

    /**
     * The in-app client is already inside the trust boundary — it IS the app —
     * so it can read the token directly instead of doing a file dance.
     */
    @JavascriptInterface
    fun token(): String = service.authToken

    /** native -> JS. Must hop to the UI thread; WebView is not thread-safe. */
    private fun deliver(frame: String) {
        // JSON.parse on a quoted string is the only injection-proof way to get
        // arbitrary terminal bytes (quotes, backslashes, newlines) into JS.
        val payload = JSONObject.quote(frame)
        webView.post {
            try {
                webView.evaluateJavascript("window.__nhzterm_recv($payload)", null)
            } catch (t: Throwable) {
                DaemonLog.w("bridge deliver failed", t)
            }
        }
    }

    fun close() = handler.close()
}
