/*
 * nhzterm — libptyhelper.so
 *
 * The single job of this file: acquire a REAL pseudo-terminal (§2 principle 2
 * — "Real PTY from day one", no pipe-mode compromise) and exec a shell on its
 * slave side, then hand the master fd back to Kotlin.
 *
 * This is the piece the JVM cannot do. A Process/ProcessBuilder gives you
 * pipes, and pipes are why vim/htop/less can never work: those programs need a
 * controlling terminal to query size, set raw mode, and receive SIGWINCH.
 */

#include <jni.h>
#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <android/log.h>

#define LOG_TAG "nhztermd-pty"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)

/* Frees a NULL-terminated char* array built by build_string_array(). */
static void free_string_array(char **arr) {
    if (!arr) return;
    for (char **p = arr; *p; ++p) free(*p);
    free(arr);
}

/* Converts a Java String[] into a NULL-terminated char*[] for execve(). */
static char **build_string_array(JNIEnv *env, jobjectArray jarr) {
    jsize n = (*env)->GetArrayLength(env, jarr);
    char **out = calloc((size_t) n + 1, sizeof(char *));
    if (!out) return NULL;

    for (jsize i = 0; i < n; ++i) {
        jstring js = (jstring) (*env)->GetObjectArrayElement(env, jarr, i);
        if (!js) { out[i] = strdup(""); continue; }
        const char *s = (*env)->GetStringUTFChars(env, js, NULL);
        out[i] = strdup(s ? s : "");
        (*env)->ReleaseStringUTFChars(env, js, s);
        (*env)->DeleteLocalRef(env, js);
        if (!out[i]) { free_string_array(out); return NULL; }
    }
    out[n] = NULL;
    return out;
}

/*
 * Sane initial line discipline. Without this the child inherits whatever the
 * kernel defaults to, and the classic symptoms are: no echo, Enter producing
 * ^M instead of a newline, and Ctrl-C doing nothing.
 */
static void configure_termios(int fd) {
    struct termios tio;
    if (tcgetattr(fd, &tio) != 0) return;

    tio.c_iflag |= (ICRNL | IXON | IUTF8);
    tio.c_iflag &= ~(INLCR | IGNCR | ISTRIP);
    tio.c_oflag |= (OPOST | ONLCR);
    tio.c_lflag |= (ISIG | ICANON | ECHO | ECHOE | ECHOK | IEXTEN);
    tio.c_cflag |= (CREAD | CS8);

    tio.c_cc[VINTR]  = 003;  /* Ctrl-C */
    tio.c_cc[VQUIT]  = 034;  /* Ctrl-\ */
    tio.c_cc[VERASE] = 0177; /* DEL — Android soft keyboards send DEL, not ^H */
    tio.c_cc[VKILL]  = 025;  /* Ctrl-U */
    tio.c_cc[VEOF]   = 004;  /* Ctrl-D */
    tio.c_cc[VSUSP]  = 032;  /* Ctrl-Z */
    tio.c_cc[VMIN]   = 1;
    tio.c_cc[VTIME]  = 0;

    tcsetattr(fd, TCSANOW, &tio);
}

JNIEXPORT jint JNICALL
Java_tech_nhz_nhzterm_pty_NativePty_createSubprocess(
        JNIEnv *env, jobject thiz,
        jstring jcmd, jobjectArray jargv, jobjectArray jenvp,
        jstring jcwd, jint cols, jint rows, jintArray jpid_out) {
    (void) thiz;

    const char *cmd = (*env)->GetStringUTFChars(env, jcmd, NULL);
    const char *cwd = (*env)->GetStringUTFChars(env, jcwd, NULL);
    char **argv = build_string_array(env, jargv);
    char **envp = build_string_array(env, jenvp);

    int master = -1;
    pid_t pid = -1;

    if (!cmd || !argv || !envp) {
        LOGE("createSubprocess: allocation failed");
        goto fail;
    }

    struct winsize ws;
    ws.ws_col    = (unsigned short) (cols > 0 ? cols : 80);
    ws.ws_row    = (unsigned short) (rows > 0 ? rows : 24);
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;

    /*
     * forkpty() = openpty + fork + login_tty in the child. login_tty is the
     * important part: it calls setsid() and TIOCSCTTY so the slave becomes the
     * child's CONTROLLING terminal. Without that, job control and signals
     * don't work and it degrades to a glorified pipe.
     */
    pid = forkpty(&master, NULL, NULL, &ws);

    if (pid < 0) {
        LOGE("forkpty failed: %s", strerror(errno));
        goto fail;
    }

    if (pid == 0) {
        /* ---- child ---- */
        /* Restore default signal handling; the JVM leaves handlers installed
         * and an inherited SIG_IGN survives execve, which would make the
         * shell immune to Ctrl-C. */
        for (int sig = 1; sig < NSIG; ++sig) signal(sig, SIG_DFL);
        sigset_t mask;
        sigemptyset(&mask);
        sigprocmask(SIG_SETMASK, &mask, NULL);

        if (cwd && *cwd) {
            if (chdir(cwd) != 0) { /* non-fatal: fall through to $HOME/cwd */ }
        }

        execve(cmd, argv, envp);

        /* Only reached if execve failed. Write to the slave so the user sees
         * WHY instead of a session that opens and instantly dies. */
        fprintf(stderr, "nhzterm: cannot exec %s: %s\r\n", cmd, strerror(errno));
        fflush(stderr);
        _exit(127);
    }

    /* ---- parent ---- */
    configure_termios(master);

    /* Non-blocking: the reader thread must never wedge the daemon on a session
     * that has stopped producing output. */
    int flags = fcntl(master, F_GETFL, 0);
    if (flags >= 0) fcntl(master, F_SETFL, flags | O_NONBLOCK);
    fcntl(master, F_SETFD, FD_CLOEXEC);

    if (jpid_out) {
        jint p = (jint) pid;
        (*env)->SetIntArrayRegion(env, jpid_out, 0, 1, &p);
    }

    LOGI("pty created: master=%d pid=%d %dx%d cmd=%s", master, pid, cols, rows, cmd);

    (*env)->ReleaseStringUTFChars(env, jcmd, cmd);
    (*env)->ReleaseStringUTFChars(env, jcwd, cwd);
    free_string_array(argv);
    free_string_array(envp);
    return master;

fail:
    if (cmd) (*env)->ReleaseStringUTFChars(env, jcmd, cmd);
    if (cwd) (*env)->ReleaseStringUTFChars(env, jcwd, cwd);
    free_string_array(argv);
    free_string_array(envp);
    return -1;
}

JNIEXPORT void JNICALL
Java_tech_nhz_nhzterm_pty_NativePty_setWinSize(
        JNIEnv *env, jobject thiz, jint fd, jint cols, jint rows) {
    (void) env; (void) thiz;
    struct winsize ws;
    ws.ws_col    = (unsigned short) (cols > 0 ? cols : 80);
    ws.ws_row    = (unsigned short) (rows > 0 ? rows : 24);
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;
    /* The kernel sends SIGWINCH to the foreground group for us, which is how
     * vim/htop learn to redraw at the new size. */
    if (ioctl(fd, TIOCSWINSZ, &ws) != 0) {
        LOGE("TIOCSWINSZ fd=%d failed: %s", fd, strerror(errno));
    }
}

JNIEXPORT void JNICALL
Java_tech_nhz_nhzterm_pty_NativePty_closeFd(JNIEnv *env, jobject thiz, jint fd) {
    (void) env; (void) thiz;
    if (fd >= 0) close(fd);
}

JNIEXPORT jint JNICALL
Java_tech_nhz_nhzterm_pty_NativePty_waitFor(
        JNIEnv *env, jobject thiz, jint pid, jboolean block) {
    (void) env; (void) thiz;
    int status = 0;
    int r = waitpid((pid_t) pid, &status, block ? WUNTRACED : WNOHANG);
    if (r == 0) return -1;            /* still running (WNOHANG) */
    if (r < 0)  return -1;            /* already reaped or gone  */
    if (WIFEXITED(status))   return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return -1;
}

JNIEXPORT void JNICALL
Java_tech_nhz_nhzterm_pty_NativePty_sendSignal(
        JNIEnv *env, jobject thiz, jint pid, jint signal) {
    (void) env; (void) thiz;
    if (pid > 0) kill((pid_t) pid, signal);
}

JNIEXPORT void JNICALL
Java_tech_nhz_nhzterm_pty_NativePty_sendSignalToGroup(
        JNIEnv *env, jobject thiz, jint pid, jint signal) {
    (void) env; (void) thiz;
    /* Negative pid = "the whole process group". A pipeline like
     * `cat | grep foo` is several processes; killing only the leader would
     * leave the rest running and holding the PTY open. */
    if (pid > 0) kill((pid_t) -pid, signal);
}
