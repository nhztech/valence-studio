package tech.nhz.nhzterm.daemon

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.LocalSocket
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import tech.nhz.nhzterm.R
import tech.nhz.nhzterm.api.Protocol
import tech.nhz.nhzterm.ipc.Connection
import tech.nhz.nhzterm.ipc.ProtocolHandler
import tech.nhz.nhzterm.ipc.SocketListener
import tech.nhz.nhzterm.pty.PtyMethod
import tech.nhz.nhzterm.pty.PtyProbe
import tech.nhz.nhzterm.session.ProcessManager
import tech.nhz.nhzterm.session.SessionManager
import tech.nhz.nhzterm.ui.TerminalActivity
import tech.nhz.nhzterm.util.DaemonLog
import tech.nhz.nhzterm.util.Paths
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * nhztermd — the daemon (§3, §7).
 *
 * A Foreground Service with a persistent notification from day one, which is
 * what makes it exempt from the Android 12+ phantom-process-killer BY
 * CONSTRUCTION rather than by mitigation (§7.3).
 */
class NhztermdService : Service() {

    private val started = AtomicBoolean(false)

    lateinit var paths: Paths; private set
    lateinit var config: DaemonConfig; private set
    lateinit var authToken: String; private set
    lateinit var sessions: SessionManager; private set
    lateinit var processes: ProcessManager; private set

    private var listener: SocketListener? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val housekeeping = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "nhztermd-housekeeping").apply { isDaemon = true }
    }

    inner class LocalBinder : Binder() {
        val service: NhztermdService get() = this@NhztermdService
    }

    private val binder = LocalBinder()

    override fun onCreate() {
        super.onCreate()

        // Notification FIRST, before anything that can throw — otherwise
        // Android kills us for a missing foreground notification and the real
        // error never surfaces (§7.3).
        createNotificationChannel()
        startForegroundCompat()

        paths = Paths(this)
        try {
            paths.ensure()
            DaemonLog.init(paths.daemonLog)
            DaemonLog.i("=== nhztermd starting (protocol v${Protocol.VERSION}) ===")

            config = DaemonConfig.load(paths.daemonConfig)
            DaemonLog.i(
                "config: maxSessions=${config.maxSessions} scrollback=${config.scrollbackLines} " +
                    "idleTimeout=${config.sessionIdleTimeoutMs}ms killGrace=${config.killGraceMs}ms " +
                    "wakeLock=${config.wakeLockEnabled}",
            )

            authToken = AuthToken.loadOrCreate(paths.authToken)
            DaemonLog.i("auth token ready (${authToken.length} hex chars)")

            // §4 probe. Logged loudly: if this reports NONE, sessions cannot
            // start and that must be obvious in the log, not a mystery later.
            val pty = PtyProbe.detect()
            DaemonLog.i("PTY method: ${pty.method}${pty.toolPath?.let { " ($it)" } ?: ""}")
            if (pty.method == PtyMethod.NONE) {
                DaemonLog.e("no PTY method available — session.create will fail")
            }

            ensureNhzshrc()

            // Part 1 Phase 1 (§12.2): stage nhzsh at a real, exec-permitted
            // path BEFORE any session can try to spawn it. Sessions exec() a
            // file; they cannot exec a JNI-loaded .so.
            val staged = ShellStager.stage(
                File(paths.nativeLibDir, ShellStager.LIB_NAME),
                paths.nhzshBin,
            )
            if (staged == null) {
                DaemonLog.w("nhzsh not staged — sessions will fall back to sh")
            } else {
                DaemonLog.i("nhzsh ready at ${staged.absolutePath}")
            }

            sessions = SessionManager(paths, config, buildEnv()) { n -> updateNotification(n) }
            sessions.clearStaleMeta()
            processes = ProcessManager(paths.home, config.killGraceMs)

            startListener()
            startHousekeeping()
            applyWakeLock(config.wakeLockEnabled)

            started.set(true)
            DaemonLog.i("=== nhztermd ready ===")
        } catch (t: Throwable) {
            DaemonLog.e("fatal during startup", t)
            // Do NOT stopSelf(): START_STICKY (§7.2) is the respawn mechanism.
            throw t
        }
    }

    /**
     * Environment handed to every session. TERM matters most: without a sane
     * value, ncurses programs refuse to run or render as garbage.
     */
    private fun buildEnv(): Array<String> {
        val termuxUsr = "/data/data/com.termux/files/usr"
        val path = buildString {
            if (File(termuxUsr, "bin").isDirectory) append("$termuxUsr/bin:")
            append(paths.nativeLibDir.absolutePath).append(':')
            append("/system/bin:/system/xbin")
        }
        val home = if (File("/data/data/com.termux/files/home").isDirectory) {
            "/data/data/com.termux/files/home"
        } else {
            paths.home.absolutePath
        }
        return arrayOf(
            "TERM=xterm-256color",
            "COLORTERM=truecolor",
            "HOME=$home",
            "PATH=$path",
            "LANG=en_US.UTF-8",
            "SHELL=${config.defaultShell}",
            "TMPDIR=${paths.cache.absolutePath}",
            "NHZTERM=1",
            "NHZSHRC=${paths.nhzshrc.absolutePath}",
            "NHZTERM_LIBDIR=${paths.nativeLibDir.absolutePath}",
        )
    }

    private fun ensureNhzshrc() {
        if (paths.nhzshrc.exists()) return
        runCatching {
            paths.nhzshrc.writeText(
                """
                # nhzsh startup config (§12.2)
                # Sourced once per interactive session.

                export PS1='nhz$ '

                alias ll='ls -la'
                alias ..='cd ..'
                """.trimIndent() + "\n",
            )
        }
    }

    private fun startListener() {
        listener = SocketListener(Protocol.SOCKET_NAME) { socket, id ->
            handleConnection(socket, id)
        }.also { it.start() }
    }

    private fun handleConnection(socket: LocalSocket, id: Int) {
        Connection(socket, id) { send ->
            ProtocolHandler(
                authToken = authToken,
                sessions = sessions,
                processes = processes,
                tokenMatcher = AuthToken::matches,
                send = send,
            )
        }.serve()
    }

    /**
     * Light in-process housekeeping (§7.2) — NOT a second monitored process.
     * Sweeps finished sessions and honours an idle timeout if one is set.
     */
    private fun startHousekeeping() {
        housekeeping.scheduleWithFixedDelay({
            try {
                sessions.sweepFinished()
                sessions.reapIdle()
            } catch (t: Throwable) {
                DaemonLog.w("housekeeping pass failed", t)
            }
        }, 30, 30, TimeUnit.SECONDS)
    }

    /**
     * §8 — opt-in, OFF by default. Purpose is keeping the CPU awake during
     * active work with the screen off, NOT surviving process death (the
     * foreground service already guarantees that).
     */
    fun applyWakeLock(enabled: Boolean) {
        if (enabled && wakeLock == null) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nhzterm:daemon").apply {
                setReferenceCounted(false)
                acquire()
            }
            DaemonLog.i("wake lock acquired")
        } else if (!enabled && wakeLock != null) {
            runCatching { wakeLock?.release() }
            wakeLock = null
            DaemonLog.i("wake lock released")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        DaemonLog.d("onStartCommand flags=$flags startId=$startId started=${started.get()}")
        return START_STICKY // §7.2 — Android restarts us; no watchdog process.
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        DaemonLog.i("nhztermd stopping")
        housekeeping.shutdownNow()
        listener?.stop()
        listener = null
        if (this::sessions.isInitialized) sessions.shutdownAll()
        if (this::processes.isInitialized) processes.shutdownAll()
        applyWakeLock(false)
        started.set(false)
        super.onDestroy()
    }

    // ---- foreground notification (§7.3) ------------------------------------

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel_name),
            // LOW: permanently visible but silent. A daemon that buzzes on
            // every restart would be intolerable.
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notif_channel_desc)
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        mgr.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val tapIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, TerminalActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }

        return builder
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(tapIntent)
            .setOngoing(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    setPriority(Notification.PRIORITY_LOW)
                }
            }
            .build()
    }

    private fun startForegroundCompat(text: String = "0 sessions") {
        val n = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    fun updateNotification(sessionCount: Int) {
        val text = if (sessionCount == 1) "1 session" else "$sessionCount sessions"
        runCatching {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIF_ID, buildNotification(text))
        }
    }

    companion object {
        private const val CHANNEL_ID = "nhztermd"
        private const val NOTIF_ID = 1001

        /** §7.1 — zero manual daemon management. No-op if already running. */
        fun ensureRunning(context: Context) {
            val intent = Intent(context, NhztermdService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
