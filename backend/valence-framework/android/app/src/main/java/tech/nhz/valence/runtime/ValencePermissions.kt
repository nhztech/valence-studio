package tech.nhz.valence.runtime

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Runtime permission broker. Private files and SQLite deliberately need no permission. */
class ValencePermissions(private val activity: Activity) {
    private val nextCode = AtomicInteger(4200)
    private val requests = ConcurrentHashMap<Int, String>()

    fun status(name: String): JSONObject {
        val permissions = androidPermissions(name)
        val state = if (permissions.all { isGranted(it) }) "granted" else "denied"
        return JSONObject().put("name", name).put("state", state)
    }

    fun request(name: String): JSONObject {
        if (!ValenceBuildConfig.DECLARED_PERMISSIONS.contains(name)) {
            throw PermissionException(
                "ENOTDECLARED",
                "$name is not declared in valence.json permissions",
            )
        }
        val permissions = androidPermissions(name)
        if (permissions.all { isGranted(it) }) return status(name)
        val requestCode = nextCode.getAndIncrement()
        requests[requestCode] = name
        activity.runOnUiThread {
            ActivityCompat.requestPermissions(activity, permissions, requestCode)
        }
        return JSONObject()
            .put("name", name)
            .put("state", "prompted")
            .put("requestCode", requestCode)
    }

    fun complete(requestCode: Int, grantResults: IntArray): JSONObject? {
        val name = requests.remove(requestCode) ?: return null
        val granted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        return JSONObject()
            .put("name", name)
            .put("state", if (granted) "granted" else "denied")
            .put("requestCode", requestCode)
    }

    private fun isGranted(permission: String): Boolean {
        if (permission == Manifest.permission.POST_NOTIFICATIONS && Build.VERSION.SDK_INT < 33) return true
        return ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun androidPermissions(name: String): Array<String> = when (name) {
        "camera" -> arrayOf(Manifest.permission.CAMERA)
        "microphone" -> arrayOf(Manifest.permission.RECORD_AUDIO)
        "location" -> arrayOf(
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION,
        )
        "notifications" -> if (Build.VERSION.SDK_INT >= 33) {
            arrayOf(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            emptyArray()
        }
        "bluetooth" -> if (Build.VERSION.SDK_INT >= 31) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            arrayOf(Manifest.permission.BLUETOOTH)
        }
        else -> throw PermissionException("EINVAL", "unknown permission: $name")
    }
}
