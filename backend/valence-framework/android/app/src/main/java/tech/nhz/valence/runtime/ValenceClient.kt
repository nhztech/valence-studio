package tech.nhz.valence.runtime

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import java.io.ByteArrayInputStream

/**
 * Packaged documents are privileged. Remote top-level navigation is always
 * refused; optional allowlisted network hosts are only for API/subresource use.
 */
object PatchGoogle {
    private val IMPORT_RE = Regex("""import\s*\{([\s\S]*?)\}\s*from\s*(["'][^"']*firebase-auth[^"']*["'])\s*;?""")
    private val NAME_RE = Regex("\\bsignInWithPopup\\b")
    private const val SHIM = """

const signInWithPopup = async (__vAuth, __vProvider, ...__vRest) => {
  const __vNative = typeof window !== "undefined" ? window.ValenceNative : null;
  const __vGoogle = __vProvider && __vProvider.providerId === "google.com";
  if (__vGoogle && __vNative) {
    const __vRes = await new Promise((res, rej) => {
      const __vL = (e) => { window.removeEventListener("valence:google-signin", __vL); const d = e.detail || {}; if (d.idToken) res(d); else rej(new Error(d.error || "google-signin-failed")); };
      window.addEventListener("valence:google-signin", __vL);
      try { __vNative.invoke(JSON.stringify({ id: "vg" + Date.now(), channel: "google", method: "signIn", args: {} })); } catch (er) { window.removeEventListener("valence:google-signin", __vL); rej(er); }
    });
    return await signInWithCredential(__vAuth, GoogleAuthProvider.credential(__vRes.idToken));
  }
  return __valencePopup(__vAuth, __vProvider, ...__vRest);
};"""
    fun patch(text: String): String? {
        if (!text.contains("signInWithPopup") || text.contains("__valencePopup")) return null
        var patched = false
        val out = IMPORT_RE.replace(text) { m ->
            val names = m.groupValues[1]
            val source = m.groupValues[2]
            if (!NAME_RE.containsMatchIn(names)) return@replace m.value
            var list = NAME_RE.replace(names, "signInWithPopup as __valencePopup")
            if (!list.contains("signInWithCredential")) list += ", signInWithCredential"
            if (!list.contains("GoogleAuthProvider")) list += ", GoogleAuthProvider"
            patched = true
            "import {" + list + "} from " + source + ";" + SHIM
        }
        return if (patched) out else null
    }
}

class ValenceClient(
    private val assets: WebViewAssetLoader,
) : WebViewClientCompat() {

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? {
        val url = request.url
        if (url.host == ValenceActivity.ORIGIN_HOST) {
            return assets.shouldInterceptRequest(url)
        }
        maybePatchRemote(request)?.let { return it }
        if (ValenceBuildConfig.MODE != "bundled") {
            val ok = (url.scheme == "https" || url.scheme == "wss") &&
                (!request.isForMainFrame || sameLiveHost(url.host))
            if (ok) return null
            return denied(url.scheme ?: "unknown", url.host)
        }
        if (isAllowedNetworkRequest(request)) return null
        return denied(url.scheme ?: "unknown", url.host)
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (ValenceBuildConfig.MODE != "bundled") {
            // The app IS the site: allow the live host, refuse everything else.
            return !sameLiveHost(request.url.host)
        }
        // Keep the privileged bridge attached only to the packaged main document.
        return request.url.host != ValenceActivity.ORIGIN_HOST
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: androidx.webkit.WebResourceErrorCompat,
    ) {
        if (ValenceBuildConfig.MODE != "bundled" && request.isForMainFrame) {
            if (ValenceBuildConfig.MODE == "hybrid" && request.url.host != ValenceActivity.ORIGIN_HOST) {
                // hybrid: live site unreachable → bundled files
                view.loadUrl("https://${ValenceActivity.ORIGIN_HOST}/${ValenceBuildConfig.ENTRY}")
            } else {
                view.loadUrl("https://${ValenceActivity.ORIGIN_HOST}/nointernet.html")
            }
            return
        }
        super.onReceivedError(view, request, error)
    }

    private fun maybePatchRemote(request: WebResourceRequest): WebResourceResponse? {
        if (ValenceBuildConfig.MODE == "bundled") return null
        if (ValenceBuildConfig.GOOGLE_WEB_CLIENT_ID.isBlank()) return null
        val url = request.url
        if (url.scheme != "https") return null
        val p = url.path ?: ""
        val isJs = p.endsWith(".js") || p.endsWith(".mjs")
        val isHtml = p.endsWith(".html") || p.endsWith("/") || p.isEmpty() || !p.contains(".")
        if (!isJs && !isHtml) return null
        return try {
            val body = java.net.URL(url.toString()).readText()
            val patched = PatchGoogle.patch(body) ?: return null
            WebResourceResponse(
                if (isJs) "application/javascript" else "text/html",
                "utf-8",
                java.io.ByteArrayInputStream(patched.toByteArray()),
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun sameLiveHost(host: String?): Boolean {
        val live = try {
            java.net.URI(ValenceBuildConfig.LIVE_URL).host
        } catch (_: Exception) {
            null
        }
        return host != null && (host == live || host == ValenceActivity.ORIGIN_HOST)
    }

    private fun isAllowedNetworkRequest(request: WebResourceRequest): Boolean {
        if (!ValenceBuildConfig.NETWORK_ENABLED) return false
        val url = request.url
        if (url.scheme != "https" && url.scheme != "wss") return false
        val destination = request.requestHeaders["Sec-Fetch-Dest"]?.lowercase()
        if (request.isForMainFrame || destination == "document" || destination == "iframe") return false
        val host = url.host?.lowercase() ?: return false
        return ValenceBuildConfig.ALLOWED_HOSTS.any { matches(host, it.lowercase()) }
    }

    private fun matches(host: String, pattern: String): Boolean = when {
        pattern == "*" -> true
        pattern.startsWith("*.") -> {
            val base = pattern.removePrefix("*.")
            host == base || host.endsWith(".$base")
        }
        else -> host == pattern
    }

    private fun denied(scheme: String, host: String?): WebResourceResponse {
        val safeHost = host?.replace("\"", "") ?: ""
        val body = """{"error":"blocked-by-valence","scheme":"$scheme","host":"$safeHost"}""".toByteArray()
        return WebResourceResponse(
            "application/json",
            "utf-8",
            403,
            "Blocked by Valence",
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(body),
        )
    }
}
