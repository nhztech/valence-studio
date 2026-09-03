package tech.nhz.valence.runtime

import android.annotation.SuppressLint
import android.app.Dialog
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import org.json.JSONObject

/**
 * Host activity. Chromium (Android System WebView) is the renderer.
 * Packaged HTML is served from APK assets via WebViewAssetLoader so the
 * document origin is a secure https:// host that does not exist on the internet.
 */
class ValenceActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var bridge: ValenceBridge
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null
    private var pendingWebResources: Array<String> = emptyArray()

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = pendingFileChooser ?: return@registerForActivityResult
        pendingFileChooser = null
        callback.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data),
        )
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Crash reporter: show the exact stack on-screen + save it, so failures are never blind.
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            val trace = android.util.Log.getStackTraceString(error)
            runCatching {
                java.io.File(filesDir, "crash.log").writeText("${java.util.Date()} thread=${thread.name}\n$trace")
            }
            val h = android.os.Handler(android.os.Looper.getMainLooper())
            val latch = java.util.concurrent.CountDownLatch(1)
            h.post {
                runCatching {
                    android.app.AlertDialog.Builder(this)
                        .setTitle("Valence crashed — screenshot this")
                        .setMessage(trace.take(3000))
                        .setPositiveButton("OK") { _, _ -> latch.countDown() }
                        .setCancelable(false)
                        .show()
                }
                latch.countDown()
            }
            try { latch.await(60, java.util.concurrent.TimeUnit.SECONDS) } catch (_: InterruptedException) {}
            android.os.Process.killProcess(android.os.Process.myPid())
        }

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(Color.parseColor("#070708"))
        }
        setContentView(webView)

        copyAssetsToWeb()
        val webRoot = ValenceBuildConfig.ENTRY.substringBeforeLast('/', "")
        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(ORIGIN_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/", WebViewAssetLoader.InternalStoragePathHandler(this, java.io.File(filesDir, "web")))
            .addPathHandler("/_assets/", object : WebViewAssetLoader.PathHandler {
                // Origin root = the project's web root (entry dir), like real hosting.
                // `/manifest.json` → assets/public/manifest.json — zero file rewrites.
                override fun handle(path: String): WebResourceResponse? {
                    val rel = when {
                        path.isEmpty() || path == "/" -> ValenceBuildConfig.ENTRY
                        webRoot.isEmpty() -> if (path.endsWith("/")) "${path}index.html" else path
                        path.endsWith("/") -> "$webRoot/${path}index.html"
                        else -> "$webRoot/$path"
                    }
                    return try {
                        val mime = MimeTypeMap.getSingleton()
                            .getMimeTypeFromExtension(MimeTypeMap.getFileExtensionFromUrl(rel))
                            ?: if (rel.endsWith(".html")) "text/html" else "application/octet-stream"
                        WebResourceResponse(mime, null, assets.open(rel))
                    } catch (_: Exception) {
                        null
                    }
                }
            })
            .build()

        webView.webViewClient = ValenceClient(assetLoader)
        webView.webChromeClient = ValenceChromeClient(this)
        bridge = ValenceBridge(this, webView)
        webView.addJavascriptInterface(bridge, "ValenceNative")

        // Seed localStorage from the native session snapshot BEFORE app code runs,
        // so a cold offline start lands on the saved session (login bypass).
        try {
            val liveOrigin = try {
                java.net.URI(ValenceBuildConfig.LIVE_URL).let { "${it.scheme}://${it.host}" }
            } catch (_: Exception) { "" }
            val origins = (setOf("https://$ORIGIN_HOST") + liveOrigin).filter { it.isNotEmpty() }.toSet()
            val seed = "(function(){try{var N=window.ValenceNative;if(!N||N.__vSeeded)return;N.__vSeeded=1;" +
                "var r=JSON.parse(N.invoke(JSON.stringify({id:'ds',channel:'sys',method:'stGet',args:{}})));" +
                "var it=(r&&r.items)||{};for(var k in it){try{if(!(k in localStorage))localStorage.setItem(k,it[k]);}catch(e){}}}catch(e){}})();"
            androidx.webkit.WebViewCompat.addDocumentStartJavaScript(webView, seed, origins)
        } catch (_: Exception) { }

        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.allowFileAccessFromFileURLs = false
        s.allowUniversalAccessFromFileURLs = false
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.mediaPlaybackRequiresUserGesture = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

        // Google rejects OAuth flows in WebViews it can identify (the "; wv" marker
        // and Safari-style "Version/X.X" token). Present a regular mobile Chrome UA
        // so redirect-based sign-in has a fighting chance.
        s.userAgentString = s.userAgentString
            .replace("; wv", "")
            .replace(Regex("Version/\\d+\\.\\d+ "), "")

        // Real popup windows (window.open / signInWithPopup) are handled natively
        // through ValenceChromeClient.onCreateWindow → openPopupWindow().
        s.setSupportMultipleWindows(true)
        s.javaScriptCanOpenWindowsAutomatically = true
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        WebView.setWebContentsDebuggingEnabled(true)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) webView.goBack() else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )

        val online = isOnline()
        val prefix = if (java.io.File(filesDir, "web/" + ValenceBuildConfig.ENTRY).exists()) "" else "_assets/"
        if (ValenceBuildConfig.MODE != "bundled" && online) {
            // LIVE/HYBRID: internet → the live site; no internet → bundled files/nointernet.
            webView.loadUrl(ValenceBuildConfig.LIVE_URL)
        } else {
            // Offline or bundled → writable web dir (fallback: raw assets)
            webView.loadUrl("https://$ORIGIN_HOST/$prefix" + ValenceBuildConfig.ENTRY)
        }
        if (online && ValenceBuildConfig.SOURCE_URL.isNotEmpty()) autoUpdate(ValenceBuildConfig.SOURCE_URL)
    }

    private fun copyAssetsToWeb() {
        val web = java.io.File(filesDir, "web")
        if (web.exists()) return
        try {
        web.mkdirs()
        fun rec(dir: String, out: java.io.File) {
            for (n in assets.list(dir) ?: return) {
                val sub = if (dir.isEmpty()) n else "$dir/$n"
                val kids = assets.list(sub)
                if (kids != null && kids.isNotEmpty()) {
                    val d = java.io.File(out, n); d.mkdirs(); rec(sub, d)
                } else {
                    assets.open(sub).use { i -> java.io.File(out, n).outputStream().use { o -> i.copyTo(o) } }
                }
            }
        }
        rec("", web)
        } catch (_: Exception) { }
    }

    private fun isOnline(): Boolean {
        return try {
            val cm = getSystemService(android.net.ConnectivityManager::class.java) ?: return true
            val net = cm.activeNetwork ?: return false
            cm.getNetworkCapabilities(net)?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) ?: true
        } catch (_: Exception) {
            true
        }
    }

    private fun sha1(t: String): String = try {
        java.security.MessageDigest.getInstance("SHA-1").digest(t.toByteArray()).joinToString("") { "%02x".format(it) }
    } catch (_: Exception) { "" }

    private fun autoUpdate(src: String) {
        Thread {
            try {
                val entryName = ValenceBuildConfig.ENTRY
                if (entryName == "nointernet.html") return@Thread
                val web = java.io.File(filesDir, "web")
                val curFile = java.io.File(web, entryName)
                val cur = if (curFile.exists()) curFile.readText() else ""
                val new = java.net.URL(src).readText()
                if (sha1(cur) == sha1(new)) return@Thread
                val srcHost = java.net.URI(src).host
                val refs = Regex("""(?:src|href)\s*=\s*["']([^"'#]+)["']""")
                    .findAll(new).map { it.groupValues[1] }.distinct().take(20)
                for (r in refs) {
                    if (r.startsWith("socket.io/")) continue
                    val ru = try { java.net.URL(java.net.URL(src), r) } catch (_: Exception) { null } ?: continue
                    if (ru.host != srcHost) continue
                    runCatching {
                        val data = ru.readBytes()
                        if (data.size in 1 until 8_000_000) {
                            val f = java.io.File(web, r.trimStart('/')); f.parentFile?.mkdirs(); f.writeBytes(data)
                        }
                    }
                }
                curFile.writeText(new)
                runOnUiThread {
                    if (webView.url?.contains(ORIGIN_HOST) == true) {
                        webView.loadUrl("https://$ORIGIN_HOST/$entryName")
                    }
                }
            } catch (_: Exception) { }
            // background re-check every 15 minutes (non-blocking, never interrupts the app)
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                if (ValenceBuildConfig.SOURCE_URL.isNotEmpty() && isOnline()) autoUpdate(ValenceBuildConfig.SOURCE_URL)
            }, 15 * 60 * 1000)
        }.start()
    }

    fun openFileChooser(
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean {
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = callback
        return try {
            fileChooserLauncher.launch(params.createIntent())
            true
        } catch (error: Exception) {
            pendingFileChooser = null
            callback.onReceiveValue(null)
            Toast.makeText(this, "No compatible file picker is available", Toast.LENGTH_LONG).show()
            false
        }
    }

    fun requestWebPermissions(
        request: PermissionRequest,
        androidPermissions: Array<String>,
        webResources: Array<String>,
    ) {
        pendingWebPermission?.deny()
        pendingWebPermission = request
        pendingWebResources = webResources
        ActivityCompat.requestPermissions(this, androidPermissions, WEB_PERMISSION_REQUEST)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == WEB_PERMISSION_REQUEST) {
            val request = pendingWebPermission
            val resources = pendingWebResources
            pendingWebPermission = null
            pendingWebResources = emptyArray()
            val granted = grantResults.isNotEmpty() &&
                grantResults.all { it == android.content.pm.PackageManager.PERMISSION_GRANTED }
            if (request != null) {
                if (granted) request.grant(resources) else request.deny()
            }
            return
        }
        bridge.onRequestPermissionsResult(requestCode, grantResults)
    }

    /* ── Native Google account picker: powers valence.google.signIn() ── */
    private val googleSignInLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val payload = JSONObject()
            try {
                val account = GoogleSignIn.getSignedInAccountFromIntent(result.data)
                    .getResult(ApiException::class.java)
                payload.put("ok", true)
                payload.put("idToken", account.idToken ?: "")
                payload.put("email", account.email ?: "")
                payload.put("name", account.displayName ?: "")
            } catch (e: Exception) {
                val code = if (e is ApiException) e.statusCode.toString() else "unknown"
                payload.put("ok", false)
                payload.put("error", "google-signin-failed:$code")
            }
            val script = "window.dispatchEvent(new CustomEvent('valence:google-signin',{detail:$payload}));"
            webView.post { webView.evaluateJavascript(script, null) }
        }

    fun startGoogleSignIn() {
        val options = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(ValenceBuildConfig.GOOGLE_WEB_CLIENT_ID)
            .requestEmail()
            .build()
        val client = GoogleSignIn.getClient(this, options)
        // signOut first so the account chooser always appears instead of silently
        // reusing the previous account.
        client.signOut().addOnCompleteListener {
            googleSignInLauncher.launch(client.signInIntent)
        }
    }

    /* ── Native popup window: powers window.open() and signInWithPopup() ── */
    private var popupDialog: Dialog? = null
    private var popupWebView: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    fun openPopupWindow(resultMsg: Message): Boolean {
        val popup = WebView(this)
        val ps = popup.settings
        ps.javaScriptEnabled = true
        ps.domStorageEnabled = true
        ps.setSupportMultipleWindows(true)
        ps.javaScriptCanOpenWindowsAutomatically = true
        ps.userAgentString = webView.settings.userAgentString
        CookieManager.getInstance().setAcceptThirdPartyCookies(popup, true)
        popup.webViewClient = WebViewClient()
        popup.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView) = closePopupWindow(window)
        }
        val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar)
        dialog.setContentView(
            popup,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        dialog.setOnDismissListener {
            if (popupWebView === popup) {
                popupWebView = null
                popupDialog = null
            }
            popup.destroy()
        }
        dialog.show()
        popupDialog = dialog
        popupWebView = popup
        val transport = resultMsg.obj as WebView.WebViewTransport
        transport.webView = popup
        resultMsg.sendToTarget()
        return true
    }

    fun closePopupWindow(window: WebView) {
        if (window === popupWebView) popupDialog?.dismiss()
    }

    override fun onDestroy() {
        popupDialog?.dismiss()
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = null
        pendingWebPermission?.deny()
        pendingWebPermission = null
        pendingWebResources = emptyArray()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val ORIGIN_HOST = "appassets.androidplatform.net"
        private const val WEB_PERMISSION_REQUEST = 4199
    }
}
