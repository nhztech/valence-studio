package tech.nhz.valence.runtime

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Message
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.core.content.ContextCompat

/** Mediates browser-style Web APIs and Android's system document picker. */
class ValenceChromeClient(private val activity: ValenceActivity) : WebChromeClient() {
    override fun onCreateWindow(
        view: WebView,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: Message,
    ): Boolean = activity.openPopupWindow(resultMsg)

    override fun onCloseWindow(window: WebView) {
        activity.closePopupWindow(window)
    }
    override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
    ): Boolean = activity.openFileChooser(filePathCallback, fileChooserParams)

    override fun onPermissionRequest(request: PermissionRequest) {
        activity.runOnUiThread {
            val trusted = request.origin.host == ValenceActivity.ORIGIN_HOST ||
                (ValenceBuildConfig.MODE != "bundled" && sameLive(request.origin.host))
            if (!trusted) {
                request.deny()
                return@runOnUiThread
            }
            val webResources = mutableListOf<String>()
            val androidPermissions = mutableSetOf<String>()
            request.resources.forEach { resource ->
                when (resource) {
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                        if (ValenceBuildConfig.DECLARED_PERMISSIONS.contains("camera")) {
                            webResources += resource
                            if (!granted(Manifest.permission.CAMERA)) {
                                androidPermissions += Manifest.permission.CAMERA
                            }
                        }
                    }
                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                        if (ValenceBuildConfig.DECLARED_PERMISSIONS.contains("microphone")) {
                            webResources += resource
                            if (!granted(Manifest.permission.RECORD_AUDIO)) {
                                androidPermissions += Manifest.permission.RECORD_AUDIO
                            }
                        }
                    }
                }
            }
            when {
                webResources.isEmpty() -> request.deny()
                androidPermissions.isEmpty() -> request.grant(webResources.toTypedArray())
                else -> activity.requestWebPermissions(
                    request,
                    androidPermissions.toTypedArray(),
                    webResources.toTypedArray(),
                )
            }
        }
    }

    override fun onGeolocationPermissionsShowPrompt(
        origin: String,
        callback: GeolocationPermissions.Callback,
    ) {
        val h = Uri.parse(origin).host
        val local = h == ValenceActivity.ORIGIN_HOST ||
            (ValenceBuildConfig.MODE != "bundled" && sameLive(h))
        val location = granted(Manifest.permission.ACCESS_COARSE_LOCATION) ||
            granted(Manifest.permission.ACCESS_FINE_LOCATION)
        callback.invoke(origin, local && location, false)
    }

    private fun sameLive(host: String?): Boolean {
        val live = try {
            java.net.URI(ValenceBuildConfig.LIVE_URL).host
        } catch (_: Exception) {
            null
        }
        return host != null && host == live
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED
}
