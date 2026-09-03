package tech.nhz.nhzterm.util

import android.content.Context
import java.io.File

/**
 * Runtime directory layout under app-private storage (§12.2).
 *
 *   etc/         nhztermd.json, nhzshrc, active themes
 *   system/bin/  nhzsh — the EXEC-PERMITTED staged copy (§12.2)
 *   sessions/    per-session meta.json (metadata only; scrollback stays in RAM)
 *   var/log/     nhztermd.log
 *   var/cache/
 *   run/         auth.token
 *   home/        default cwd for automation-spawned sessions (§6.4)
 *
 * On `system/bin/`: jniLibs/libnhzsh.so is the SOURCE OF TRUTH for the compiled
 * binary, but it is only usable for in-process JNI calls. A PTY session is a
 * separate child process — tmux/screen/socat/forkpty must exec() a real file at
 * a real path. So the daemon stages the .so into system/bin/nhzsh at startup,
 * preserving exec permission. That path also matches NHZOS's own directory
 * doctrine (system/bin/, alongside future su and nhzpm).
 */
class Paths(context: Context) {

    private val root: File = context.filesDir

    val etc = File(root, "etc")
    val themes = File(etc, "themes")
    val system = File(root, "system")
    val systemBin = File(system, "bin")
    val sessions = File(root, "sessions")
    val varDir = File(root, "var")
    val log = File(varDir, "log")
    val cache = File(varDir, "cache")
    val run = File(root, "run")
    val home = File(root, "home")

    val daemonConfig = File(etc, "nhztermd.json")
    val nhzshrc = File(etc, "nhzshrc")
    val authToken = File(run, "auth.token")
    val daemonLog = File(log, "nhztermd.log")

    /** The staged, exec-permitted shell that PTY sessions actually exec(). */
    val nhzshBin = File(systemBin, "nhzsh")

    /** Native library dir — where libnhzsh.so actually lives and is executable. */
    val nativeLibDir: File = File(context.applicationInfo.nativeLibraryDir)

    fun sessionDir(sessionId: String) = File(sessions, sessionId)

    /**
     * Creates the tree. Idempotent — safe on every service start, which is
     * what makes a clean install "just work" with no bootstrap step (Phase 8).
     */
    fun ensure() {
        listOf(etc, themes, systemBin, sessions, log, cache, run, home).forEach { dir ->
            if (!dir.isDirectory && !dir.mkdirs()) {
                throw IllegalStateException("cannot create runtime dir: $dir")
            }
        }
        // Defense in depth (§12.3). App-private storage is already sandboxed
        // per-app, but the token dir should not be group/world reachable even
        // in the shared-uid case.
        run.setReadable(false, false)
        run.setReadable(true, true)
        run.setExecutable(false, false)
        run.setExecutable(true, true)
    }
}
