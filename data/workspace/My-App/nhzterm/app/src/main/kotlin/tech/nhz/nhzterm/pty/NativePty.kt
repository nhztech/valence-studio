package tech.nhz.nhzterm.pty

import tech.nhz.nhzterm.util.DaemonLog

/**
 * JNI bridge to libptyhelper.so (§4 method 4).
 *
 * The JVM has no forkpty(), so the master-fd + fork + setsid + TIOCSCTTY dance
 * happens in C. This is the only path that gives a genuine controlling
 * terminal with no external tool installed, which is why it ends up being the
 * one the daemon actually relies on in practice — the tmux/screen/socat probe
 * (§4 methods 1-3) is what keeps it working on devices where loading a custom
 * .so is restricted.
 */
object NativePty {

    @Volatile
    private var loaded = false

    init {
        loaded = try {
            System.loadLibrary("ptyhelper")
            true
        } catch (t: Throwable) {
            DaemonLog.w("libptyhelper.so unavailable: ${t.message}")
            false
        }
    }

    fun isAvailable(): Boolean = loaded

    /**
     * forkpty() + exec. Returns the PTY master file descriptor.
     *
     * @param cmd     absolute path to the program (e.g. .../libnhzsh.so)
     * @param argv    argv[0..n], NOT including a trailing null
     * @param envp    "KEY=VALUE" strings
     * @param cwd     working directory for the child
     * @param cols    initial terminal width
     * @param rows    initial terminal height
     * @param pidOut  single-element array; receives the child pid
     * @return master fd, or -1 on failure
     */
    external fun createSubprocess(
        cmd: String,
        argv: Array<String>,
        envp: Array<String>,
        cwd: String,
        cols: Int,
        rows: Int,
        pidOut: IntArray,
    ): Int

    /** TIOCSWINSZ on the master fd, then SIGWINCH reaches the child. */
    external fun setWinSize(fd: Int, cols: Int, rows: Int)

    /** close(2) on the master fd. */
    external fun closeFd(fd: Int)

    /**
     * waitpid(). @param block true = WUNTRACED blocking, false = WNOHANG.
     * @return exit status, or -1 if still running (non-blocking mode).
     */
    external fun waitFor(pid: Int, block: Boolean): Int

    /** kill(2). Sends [signal] to [pid]. */
    external fun sendSignal(pid: Int, signal: Int)

    /**
     * Signals the whole foreground process GROUP (-pid), which is what
     * Ctrl-C must do: a pipeline is several processes, and signalling only
     * the leader leaves the rest orphaned.
     */
    external fun sendSignalToGroup(pid: Int, signal: Int)

    const val SIGHUP = 1
    const val SIGINT = 2
    const val SIGQUIT = 3
    const val SIGKILL = 9
    const val SIGTERM = 15
    const val SIGTSTP = 20
}
