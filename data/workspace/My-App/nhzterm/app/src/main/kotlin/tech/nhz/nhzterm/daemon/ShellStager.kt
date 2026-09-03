package tech.nhz.nhzterm.daemon

import tech.nhz.nhzterm.util.DaemonLog
import java.io.File
import java.security.MessageDigest

/**
 * Stages `nhzsh` at a real, exec-permitted file path (Part 1 Phase 1, §12.2).
 *
 * WHY THIS EXISTS — the bug this fixes:
 * `jniLibs/arm64-v8a/libnhzsh.so` is the source of truth for the compiled
 * binary, and Android's installer guarantees exec permission there. But that
 * location is only useful for code the Kotlin layer calls IN-PROCESS via JNI.
 *
 * A PTY session is a separate CHILD PROCESS — tmux/screen/socat/forkpty must
 * `exec()` a real file at a real path. Handing them the `.so` path is fragile:
 * the native library dir can be a symlink into the APK on some devices, and
 * on others the extracted `.so` is not guaranteed to survive as a plain file.
 *
 * So on daemon startup we copy the `.so` into `system/bin/nhzsh` in app-private
 * storage and chmod it executable. That is the path sessions actually exec, and
 * it matches NHZOS's own directory doctrine (`system/bin/`, alongside a future
 * `su` and `nhzpm`).
 */
object ShellStager {

    const val LIB_NAME = "libnhzsh.so"

    /**
     * Copies [source] to [target] if needed, then marks it executable.
     *
     * Idempotent and content-aware: an unchanged binary is not re-copied, so
     * an app upgrade restages while a routine restart does not. Copying on
     * every start would also risk clobbering a binary a live session is
     * currently executing.
     *
     * @return the staged file, or null if staging was impossible.
     */
    fun stage(source: File, target: File): File? {
        if (!source.isFile) {
            DaemonLog.w("nhzsh staging: $LIB_NAME absent at ${source.absolutePath}")
            return null
        }

        try {
            target.parentFile?.mkdirs()

            if (needsRestage(source, target)) {
                // Write to a temp file then rename: an interrupted copy must
                // never leave a truncated, executable, half-shell in place.
                val tmp = File(target.parentFile, "${target.name}.staging")
                if (tmp.exists()) tmp.delete()

                source.inputStream().use { input ->
                    tmp.outputStream().use { output -> input.copyTo(output) }
                }

                if (target.exists() && !target.delete()) {
                    // A running session may hold the old inode open. Rename
                    // still succeeds on Linux; the old inode lives until that
                    // process exits, which is exactly the semantics we want.
                    DaemonLog.d("nhzsh staging: existing target busy, replacing by rename")
                }
                if (!tmp.renameTo(target)) {
                    tmp.delete()
                    DaemonLog.e("nhzsh staging: rename into place failed")
                    return null
                }
                DaemonLog.i("nhzsh staged: ${source.absolutePath} -> ${target.absolutePath} (${target.length()} bytes)")
            } else {
                DaemonLog.d("nhzsh staging: already current, skipping copy")
            }

            // Exec permission is the entire point; owner-only, since nothing
            // outside this app's uid has any business running it.
            val ok = target.setExecutable(true, true) and target.setReadable(true, true)
            if (!ok || !target.canExecute()) {
                DaemonLog.e("nhzsh staging: could not mark ${target.absolutePath} executable")
                return null
            }

            return target
        } catch (t: Throwable) {
            DaemonLog.e("nhzsh staging failed", t)
            return null
        }
    }

    /**
     * True if the target is missing, a different size, or different content.
     * Size is checked first because it settles the common case without
     * hashing several hundred KB on every daemon start.
     */
    private fun needsRestage(source: File, target: File): Boolean {
        if (!target.isFile) return true
        if (target.length() != source.length()) return true
        return sha256(source) != sha256(target)
    }

    private fun sha256(f: File): String = try {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        md.digest().joinToString("") { "%02x".format(it) }
    } catch (t: Throwable) {
        // Unreadable => treat as different, forcing a restage.
        ""
    }
}
