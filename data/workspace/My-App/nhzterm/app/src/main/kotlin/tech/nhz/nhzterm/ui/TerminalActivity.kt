package tech.nhz.nhzterm.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import tech.nhz.nhzterm.daemon.NhztermdService
import tech.nhz.nhzterm.util.DaemonLog

/**
 * The reference client (§10). A WebView hosting xterm.js, bridged to the
 * daemon in-process (§3) — no bridge binary, no network hop.
 */
class TerminalActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var bridge: TerminalBridge? = null
    private var service: NhztermdService? = null
    private var bound = false

    /** Vol Up / Vol Down held = modifier (§10.7). */
    private var volUpHeld = false
    private var volDownHeld = false
    private var volChorded = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val svc = (binder as? NhztermdService.LocalBinder)?.service ?: return
            service = svc
            bound = true
            bridge = TerminalBridge(svc, webView).also {
                webView.addJavascriptInterface(it, "NhzBridge")
            }
            webView.addJavascriptInterface(UiActions(), "NhzUi")
            // Load only AFTER the bridge exists, or the page's boot() would
            // run with no window.NhzBridge and silently do nothing.
            webView.loadUrl("file:///android_asset/terminal.html")
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            bound = false
            service = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        }

        webView = WebView(this).apply {
            setBackgroundColor(0xFF282A36.toInt())
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true          // localStorage holds style prefs
                // Assets only: nothing is fetched from the network, matching
                // "no web-tech dependency in the core" (§2.1).
                allowFileAccess = false
                allowContentAccess = false
                cacheMode = WebSettings.LOAD_NO_CACHE
                textZoom = 100                    // never let system font scale break the grid
            }
        }
        setContentView(webView)

        // §7.1 — zero manual daemon management.
        NhztermdService.ensureRunning(this)
        bindService(Intent(this, NhztermdService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onDestroy() {
        bridge?.close()
        if (bound) runCatching { unbindService(connection) }
        webView.destroy()
        super.onDestroy()
    }

    // ---- volume key emulation (§10.7) --------------------------------------

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // §10.9 hardware-keyboard shortcuts. Ctrl+Alt is the prefix so these
        // never shadow the Ctrl sequences the terminal itself needs.
        if (event != null && event.isCtrlPressed && event.isAltPressed) {
            when (keyCode) {
                KeyEvent.KEYCODE_C -> { jsCall("window.__nhzterm_newsession()"); return true }
                KeyEvent.KEYCODE_R -> { jsCall("window.__nhzterm_renamesession()"); return true }
                KeyEvent.KEYCODE_N, KeyEvent.KEYCODE_DPAD_DOWN -> { jsCall("window.__nhzterm_cyclesession(1)"); return true }
                KeyEvent.KEYCODE_P, KeyEvent.KEYCODE_DPAD_UP -> { jsCall("window.__nhzterm_cyclesession(-1)"); return true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { jsCall("window.__nhzterm_drawer(true)"); return true }
                KeyEvent.KEYCODE_DPAD_LEFT -> { jsCall("window.__nhzterm_drawer(false)"); return true }
                in KeyEvent.KEYCODE_1..KeyEvent.KEYCODE_9 -> {
                    val n = keyCode - KeyEvent.KEYCODE_1
                    jsCall("window.__nhzterm_gotosession($n)")
                    return true
                }
            }
        }

        when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP -> { volUpHeld = true; volChorded = false; return true }
            KeyEvent.KEYCODE_VOLUME_DOWN -> { volDownHeld = true; volChorded = false; return true }
        }
        if (volUpHeld || volDownHeld) {
            val ch = event?.unicodeChar?.takeIf { it != 0 }?.toChar()
            if (ch != null) {
                volChorded = true
                val mod = if (volDownHeld) "down" else "up"
                webView.evaluateJavascript(
                    "window.__nhzterm_volkey('$mod', '${ch.lowercaseChar()}')", null,
                )
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP -> {
                volUpHeld = false
                // A tap with no chord should still change the volume, or the
                // user loses the volume rocker entirely while in the app.
                if (!volChorded) return super.onKeyDown(keyCode, event)
                return true
            }
            KeyEvent.KEYCODE_VOLUME_DOWN -> {
                volDownHeld = false
                if (!volChorded) return super.onKeyDown(keyCode, event)
                return true
            }
        }
        return super.onKeyUp(keyCode, event)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIF) NhztermdService.ensureRunning(this)
    }

    /** Native side of the context menu (§10.3). */
    inner class UiActions {

        @JavascriptInterface
        fun copy(text: String) {
            if (text.isEmpty()) return
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("nhzterm", text))
            toast("Copied")
        }

        @JavascriptInterface
        fun paste(): String {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            return cm.primaryClip?.getItemAt(0)?.coerceToText(this@TerminalActivity)?.toString() ?: ""
        }

        @JavascriptInterface
        fun openUrl(url: String) {
            runCatching {
                val safe = if (url.startsWith("http")) url else "https://$url"
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(safe)))
            }.onFailure { toast("Cannot open link") }
        }

        @JavascriptInterface
        fun share(text: String) {
            if (text.isEmpty()) { toast("Nothing selected"); return }
            val i = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            startActivity(Intent.createChooser(i, "Share"))
        }

        /** Per-session override of the screen timeout (§10.3). */
        @JavascriptInterface
        fun keepScreenOn() {
            runOnUiThread {
                val on = webView.keepScreenOn
                webView.keepScreenOn = !on
                if (!on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                toast(if (!on) "Screen will stay on" else "Screen timeout restored")
            }
        }

        @JavascriptInterface
        fun help() {
            runOnUiThread {
                val text = runCatching {
                    assets.open("doc/README.md").bufferedReader().use { it.readText() }
                }.getOrDefault("Help unavailable.")
                AlertDialog.Builder(this@TerminalActivity)
                    .setTitle("nhzterm Help")
                    .setMessage(text)
                    .setPositiveButton("Close", null)
                    .show()
            }
        }

        @JavascriptInterface
        fun settings() {
            runOnUiThread {
                val svc = service
                if (svc == null) { toast("Daemon not bound"); return@runOnUiThread }
                val wakeOn = svc.config.wakeLockEnabled
                AlertDialog.Builder(this@TerminalActivity)
                    .setTitle("Settings")
                    .setMessage(
                        "Max sessions: ${svc.config.maxSessions}\n" +
                            "Scrollback: ${svc.config.scrollbackLines} lines\n" +
                            "Kill grace: ${svc.config.killGraceMs} ms\n" +
                            "Wake lock: ${if (wakeOn) "on" else "off"}",
                    )
                    .setPositiveButton("Close", null)
                    .setNeutralButton(if (wakeOn) "Wake lock off" else "Wake lock on") { _, _ ->
                        svc.applyWakeLock(!wakeOn)
                    }
                    .show()
            }
        }

        @JavascriptInterface
        fun report() {
            runOnUiThread {
                val log = runCatching {
                    service?.paths?.daemonLog?.takeIf { it.isFile }?.readText()?.takeLast(4000)
                }.getOrNull() ?: "(no log)"
                val i = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, "nhzterm issue report")
                    putExtra(Intent.EXTRA_TEXT, "Describe the issue:\n\n\n--- log tail ---\n$log")
                }
                startActivity(Intent.createChooser(i, "Report issue"))
            }
        }

        /**
         * Blocking text prompt for session rename (§10.4).
         *
         * WebView's window.prompt() is unreliable inside a JavascriptInterface
         * context, so the dialog is native and the JS thread waits on a latch.
         * Safe because @JavascriptInterface methods run on a dedicated binder
         * thread, never the UI thread — blocking here cannot deadlock the UI.
         */
        @JavascriptInterface
        fun prompt(title: String, initial: String): String {
            val latch = java.util.concurrent.CountDownLatch(1)
            var result = ""
            runOnUiThread {
                val input = android.widget.EditText(this@TerminalActivity).apply {
                    setText(initial)
                    setSelection(initial.length)
                    setSingleLine(true)
                }
                AlertDialog.Builder(this@TerminalActivity)
                    .setTitle(title)
                    .setView(input)
                    .setPositiveButton("OK") { _, _ ->
                        result = input.text.toString()
                        latch.countDown()
                    }
                    .setNegativeButton("Cancel") { _, _ -> latch.countDown() }
                    .setOnCancelListener { latch.countDown() }
                    .show()
            }
            // Bounded wait: a dismissed-without-callback dialog must not hang
            // the bridge thread forever.
            latch.await(60, java.util.concurrent.TimeUnit.SECONDS)
            return result
        }

        @JavascriptInterface
        fun toast(msg: String) {
            runOnUiThread { Toast.makeText(this@TerminalActivity, msg, Toast.LENGTH_SHORT).show() }
        }
    }

    private fun jsCall(js: String) {
        runOnUiThread { runCatching { webView.evaluateJavascript(js, null) } }
    }

    private fun toast(msg: String) =
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }

    private companion object {
        const val REQ_NOTIF = 100
    }
}
