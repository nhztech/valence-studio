package tech.nhz.nhzterm.util

import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Dual-sink logger: logcat for live debugging, var/log/nhztermd.log (§12.2)
 * so a headless daemon leaves a trace when no UI was ever attached.
 *
 * The file is size-capped and rotated once, because a terminal daemon that
 * runs for weeks on a phone must not silently eat storage.
 */
object DaemonLog {

    private const val TAG = "nhztermd"
    private const val MAX_BYTES = 512 * 1024

    private val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    @Volatile
    private var file: File? = null

    fun init(logFile: File) {
        file = logFile
    }

    fun d(msg: String) { write("D", msg, null); logcat(3, msg, null) }
    fun i(msg: String) { write("I", msg, null); logcat(4, msg, null) }
    fun w(msg: String, t: Throwable? = null) { write("W", msg, t); logcat(5, msg, t) }
    fun e(msg: String, t: Throwable? = null) { write("E", msg, t); logcat(6, msg, t) }

    /**
     * Logcat is best-effort. Under a JVM unit-test runner android.util.Log is
     * a stub that THROWS, and a logger must never be able to take the daemon
     * (or a test) down with it.
     */
    private fun logcat(level: Int, msg: String, t: Throwable?) {
        try {
            when (level) {
                3 -> Log.d(TAG, msg)
                4 -> Log.i(TAG, msg)
                5 -> Log.w(TAG, msg, t)
                else -> Log.e(TAG, msg, t)
            }
        } catch (_: Throwable) {
            // Not on a device (or Log is stubbed) — the file sink still works.
        }
    }

    private fun write(level: String, msg: String, t: Throwable?) {
        val f = file ?: return
        try {
            synchronized(this) {
                if (f.length() > MAX_BYTES) rotate(f)
                val line = buildString {
                    append(stamp.format(Date())).append(' ')
                    append(level).append(' ').append(msg).append('\n')
                    if (t != null) {
                        append(t.stackTraceToString()).append('\n')
                    }
                }
                f.appendText(line)
            }
        } catch (io: Throwable) {
            // Logging must never take the daemon down.
        }
    }

    private fun rotate(f: File) {
        val old = File(f.parentFile, f.name + ".1")
        if (old.exists()) old.delete()
        f.renameTo(old)
    }
}
