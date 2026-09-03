package tech.nhz.valence.runtime

import android.app.Activity
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject

/**
 * Valence IPC. The renderer calls ValenceNative.invoke(json)
 * and receives a JSON reply. File work is synchronous for small notes;
 * bump this to a background executor if you start writing large blobs.
 */
class ValenceBridge(
    private val activity: Activity,
    private val webView: WebView,
) {
    private val fs = ValenceFs(activity)
    private val database = ValenceDatabase(activity)
    private val permissions = ValencePermissions(activity)

    @JavascriptInterface
    fun invoke(raw: String): String {
        val req = JSONObject(raw)
        val id = req.optString("id")
        val channel = req.optString("channel")
        val method = req.optString("method")
        val args = req.optJSONObject("args") ?: JSONObject()
        return try {
            val result = dispatch(channel, method, args)
            JSONObject()
                .put("id", id)
                .put("ok", true)
                .put("result", result)
                .toString()
        } catch (e: Exception) {
            val code = if (e is ValenceException) e.code else "EFAIL"
            JSONObject()
                .put("id", id)
                .put("ok", false)
                .put(
                    "error",
                    JSONObject().put("code", code).put("message", e.message ?: "error"),
                )
                .toString()
        }
    }

    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray) {
        val result = permissions.complete(requestCode, grantResults) ?: return
        val script = "window.dispatchEvent(new CustomEvent('valence:permission-result',{detail:${result}}));"
        webView.post { webView.evaluateJavascript(script, null) }
    }

    private fun dispatch(channel: String, method: String, args: JSONObject): Any {
        val requiredCapability = when (channel) {
            "fs" -> "filesystem"
            "db" -> "database"
            "dialog" -> "dialogs"
            "notify" -> "notifications"
            else -> null
        }
        if (requiredCapability != null && !ValenceBuildConfig.CAPABILITIES.contains(requiredCapability)) {
            throw ValenceException(
                "ECAPABILITY",
                "$requiredCapability is not enabled in valence.json",
            )
        }
        return when ("$channel.$method") {
            "sys.stDump" -> {
                val host = activity as? ValenceActivity
                if (host != null) {
                    java.io.File(host.filesDir, "valence-session.json")
                        .writeText(args.optString("json", "{}"))
                }
                JSONObject().put("ok", true)
            }
            "sys.stGet" -> {
                val host = activity as? ValenceActivity
                val raw = if (host != null) {
                    val f = java.io.File(host.filesDir, "valence-session.json")
                    if (f.exists()) f.readText() else "{}"
                } else "{}"
                JSONObject(raw)
            }
            "google.signIn" -> {
                val host = activity as? ValenceActivity
                    ?: throw ValenceException("EFAIL", "native activity unavailable")
                if (ValenceBuildConfig.GOOGLE_WEB_CLIENT_ID.isBlank()) {
                    throw ValenceException(
                        "ECONFIG",
                        "google.webClientId is missing in valence.json",
                    )
                }
                activity.runOnUiThread { host.startGoogleSignIn() }
                JSONObject().put("started", true)
            }
            "fs.readFile" -> fs.readFile(args.getString("path"), args.optString("encoding", "utf8"))
            "fs.writeFile" -> {
                val n = fs.writeFile(
                    args.getString("path"),
                    args.optString("data", ""),
                    args.optString("encoding", "utf8"),
                )
                JSONObject().put("bytes", n)
            }
            "fs.readdir" -> fs.readdir(args.getString("path"))
            "fs.mkdir" -> JSONObject().put("path", fs.mkdir(args.getString("path")))
            "fs.unlink" -> {
                fs.unlink(args.getString("path"))
                JSONObject().put("ok", true)
            }
            "fs.rmdir" -> {
                fs.rmdir(args.getString("path"))
                JSONObject().put("ok", true)
            }
            "fs.stat" -> fs.stat(args.getString("path"))
            "fs.exists" -> fs.exists(args.getString("path"))
            "fs.rename" -> {
                fs.rename(args.getString("from"), args.getString("to"))
                JSONObject().put("ok", true)
            }
            "fs.tree" -> fs.tree(args.optString("path", "/"))
            "db.open" -> database.open(args.getString("name"))
            "db.close" -> database.close(args.getString("name"))
            "db.exec" -> database.exec(
                args.getString("name"),
                args.getString("sql"),
                args.optJSONArray("params") ?: JSONArray(),
            )
            "db.run" -> database.run(
                args.getString("name"),
                args.getString("sql"),
                args.optJSONArray("params") ?: JSONArray(),
            )
            "db.all" -> database.all(
                args.getString("name"),
                args.getString("sql"),
                args.optJSONArray("params") ?: JSONArray(),
            )
            "db.get" -> database.get(
                args.getString("name"),
                args.getString("sql"),
                args.optJSONArray("params") ?: JSONArray(),
            )
            "permissions.status" -> permissions.status(args.getString("name"))
            "permissions.request" -> permissions.request(args.getString("name"))
            "app.getInfo" -> JSONObject()
                .put("name", activity.getString(R.string.app_name))
                .put("id", activity.packageName)
                .put("version", "0.1.0")
                .put("platform", "android")
                .put("protocol", "valence://app")
                .put("offline", !ValenceBuildConfig.NETWORK_ENABLED)
                .put("kernel", "android")
            "app.getPath" -> fs.getPath(args.getString("name"))
            "dialog.alert" -> {
                val message = args.optString("message")
                activity.runOnUiThread {
                    Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
                }
                JSONObject().put("ok", true)
            }
            "notify.show" -> {
                val title = args.optString("title", "Valence")
                val body = args.optString("body", "")
                activity.runOnUiThread {
                    Toast.makeText(activity, "$title\n$body", Toast.LENGTH_LONG).show()
                }
                JSONObject().put("ok", true).put("shown", true)
            }
            else -> throw FsException("ENOSYS", "no handler $channel.$method")
        }
    }
}
