/*
 * nhzterm — PTY harness (Part 1, Phase 1 gate)
 *
 * ptyhelper.c is JNI-bound and cannot run off-device. This harness exercises
 * the EXACT same syscall sequence (forkpty + termios + winsize + signals)
 * against a real kernel, so the PTY strategy in §4 is proven correct before
 * an APK is ever built. If this passes, the logic is sound; only the JNI
 * marshalling is left to verify on hardware.
 *
 * Build & run:  cc -o pty_harness pty_harness.c -lutil && ./pty_harness
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static int passed = 0, failed = 0;

static void check(const char *name, int cond, const char *detail) {
    if (cond) { passed++; printf("  PASS  %s\n", name); }
    else { failed++; printf("  FAIL  %s -> %s\n", name, detail ? detail : ""); }
}

/* Mirrors configure_termios() in ptyhelper.c exactly. */
static void configure_termios(int fd) {
    struct termios tio;
    if (tcgetattr(fd, &tio) != 0) return;
    tio.c_iflag |= (ICRNL | IXON | IUTF8);
    tio.c_iflag &= ~(INLCR | IGNCR | ISTRIP);
    tio.c_oflag |= (OPOST | ONLCR);
    tio.c_lflag |= (ISIG | ICANON | ECHO | ECHOE | ECHOK | IEXTEN);
    tio.c_cflag |= (CREAD | CS8);
    tio.c_cc[VINTR]  = 003;
    tio.c_cc[VQUIT]  = 034;
    tio.c_cc[VERASE] = 0177;
    tio.c_cc[VKILL]  = 025;
    tio.c_cc[VEOF]   = 004;
    tio.c_cc[VSUSP]  = 032;
    tio.c_cc[VMIN]   = 1;
    tio.c_cc[VTIME]  = 0;
    tcsetattr(fd, TCSANOW, &tio);
}

/* Mirrors createSubprocess()'s core. */
static int spawn_pty(char *const argv[], int cols, int rows, pid_t *out_pid) {
    struct winsize ws = { .ws_col = cols, .ws_row = rows, .ws_xpixel = 0, .ws_ypixel = 0 };
    int master = -1;
    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) return -1;
    if (pid == 0) {
        for (int s = 1; s < NSIG; ++s) signal(s, SIG_DFL);
        sigset_t m; sigemptyset(&m); sigprocmask(SIG_SETMASK, &m, NULL);
        execvp(argv[0], argv);
        fprintf(stderr, "nhzterm: cannot exec %s: %s\r\n", argv[0], strerror(errno));
        _exit(127);
    }
    configure_termios(master);
    int fl = fcntl(master, F_GETFL, 0);
    if (fl >= 0) fcntl(master, F_SETFL, fl | O_NONBLOCK);
    *out_pid = pid;
    return master;
}

/* Reads until `want` is seen or timeout. Non-blocking fd + select, exactly
 * like the daemon's reader thread. */
static int read_until(int fd, const char *want, char *buf, size_t cap, int timeout_ms) {
    size_t len = 0;
    int waited = 0;
    while (waited < timeout_ms) {
        fd_set rf; FD_ZERO(&rf); FD_SET(fd, &rf);
        struct timeval tv = { .tv_sec = 0, .tv_usec = 50000 };
        int r = select(fd + 1, &rf, NULL, NULL, &tv);
        if (r > 0 && FD_ISSET(fd, &rf)) {
            ssize_t n = read(fd, buf + len, cap - len - 1);
            if (n > 0) {
                len += (size_t) n;
                buf[len] = '\0';
                if (want && strstr(buf, want)) return 1;
            } else if (n == 0) break;
            else if (errno != EAGAIN && errno != EINTR) break;
        }
        waited += 50;
    }
    buf[len] = '\0';
    return want ? (strstr(buf, want) != NULL) : (int) len;
}

static void test_basic_exec(void) {
    printf("real PTY: spawn and capture output\n");
    char *argv[] = { "sh", "-c", "echo NHZTERM_OK", NULL };
    pid_t pid; char buf[4096] = {0};
    int fd = spawn_pty(argv, 80, 24, &pid);
    check("forkpty returned a master fd", fd >= 0, strerror(errno));
    if (fd < 0) return;
    check("child pid is valid", pid > 0, "");
    check("output reached the master side", read_until(fd, "NHZTERM_OK", buf, sizeof buf, 3000), buf);
    close(fd);
    waitpid(pid, NULL, 0);
}

static void test_is_a_tty(void) {
    printf("real PTY: child sees a CONTROLLING TERMINAL\n");
    /* This is THE test that separates a real PTY from a pipe. `test -t 0`
     * fails on a pipe. If this passes, vim/htop can work (§2 principle 2). */
    char *argv[] = { "sh", "-c", "test -t 0 && test -t 1 && echo IS_A_TTY || echo NOT_A_TTY", NULL };
    pid_t pid; char buf[4096] = {0};
    int fd = spawn_pty(argv, 80, 24, &pid);
    if (fd < 0) { check("spawn", 0, "forkpty failed"); return; }
    read_until(fd, "TTY", buf, sizeof buf, 3000);
    check("stdin+stdout are a tty (NOT a pipe)", strstr(buf, "IS_A_TTY") != NULL, buf);
    close(fd);
    waitpid(pid, NULL, 0);
}

static void test_winsize(void) {
    printf("real PTY: window size is visible to the child\n");
    /* A TUI asks the kernel how big the terminal is. If this reports the
     * wrong size, htop draws garbage. */
    char *argv[] = { "sh", "-c", "stty size 2>/dev/null || echo NOSTTY", NULL };
    pid_t pid; char buf[4096] = {0};
    int fd = spawn_pty(argv, 132, 43, &pid);
    if (fd < 0) { check("spawn", 0, "forkpty failed"); return; }
    read_until(fd, NULL, buf, sizeof buf, 3000);
    if (strstr(buf, "NOSTTY")) {
        printf("  SKIP  stty unavailable\n");
    } else {
        check("child sees 43 rows x 132 cols", strstr(buf, "43 132") != NULL, buf);
    }
    close(fd);
    waitpid(pid, NULL, 0);

    /* Resize must be observable while running (§6.3 session.resize). */
    char *argv2[] = { "sh", "-c", "trap 'stty size' WINCH; sleep 5 & wait", NULL };
    pid_t pid2; char buf2[4096] = {0};
    int fd2 = spawn_pty(argv2, 80, 24, &pid2);
    if (fd2 >= 0) {
        usleep(400000);
        struct winsize ws = { .ws_col = 100, .ws_row = 30, .ws_xpixel = 0, .ws_ypixel = 0 };
        int ok = ioctl(fd2, TIOCSWINSZ, &ws) == 0;
        check("TIOCSWINSZ succeeds on master", ok, strerror(errno));
        read_until(fd2, "30 100", buf2, sizeof buf2, 3000);
        check("SIGWINCH delivered with new size", strstr(buf2, "30 100") != NULL, buf2);
        close(fd2);
        kill(pid2, SIGKILL);
        waitpid(pid2, NULL, 0);
    }
}

static void test_interactive_io(void) {
    printf("real PTY: bidirectional interactive I/O\n");
    /* Write into the master, the shell reads it as keyboard input. This is
     * session.write (§6.3). */
    char *argv[] = { "sh", NULL };
    pid_t pid; char buf[8192] = {0};
    int fd = spawn_pty(argv, 80, 24, &pid);
    if (fd < 0) { check("spawn", 0, "forkpty failed"); return; }
    usleep(300000);
    const char *cmd = "echo INTERACTIVE_OK\n";
    ssize_t w = write(fd, cmd, strlen(cmd));
    check("write to master accepted", w == (ssize_t) strlen(cmd), "short write");
    check("command executed, output returned", read_until(fd, "INTERACTIVE_OK", buf, sizeof buf, 3000), buf);
    /* Echo is on, so the typed text itself must also come back — that's what
     * makes the terminal feel like a terminal. */
    check("input was echoed back (ECHO enabled)",
          strstr(buf, "echo INTERACTIVE_OK") != NULL, buf);
    const char *exitcmd = "exit\n";
    if (write(fd, exitcmd, strlen(exitcmd)) < 0) { /* ignore */ }
    close(fd);
    waitpid(pid, NULL, 0);
}

static void test_signal_to_group(void) {
    printf("real PTY: signals reach the foreground process group\n");
    char *argv[] = { "sh", "-c", "sleep 30", NULL };
    pid_t pid; 
    int fd = spawn_pty(argv, 80, 24, &pid);
    if (fd < 0) { check("spawn", 0, "forkpty failed"); return; }
    usleep(300000);
    /* Negative pid = whole group, mirroring sendSignalToGroup(). */
    check("kill(-pid, SIGTERM) accepted", kill(-pid, SIGTERM) == 0, strerror(errno));
    int status = 0, waited = 0, reaped = 0;
    while (waited < 3000) {
        if (waitpid(pid, &status, WNOHANG) == pid) { reaped = 1; break; }
        usleep(50000); waited += 50;
    }
    check("process group actually died", reaped, "still running after SIGTERM");
    close(fd);
    if (!reaped) { kill(pid, SIGKILL); waitpid(pid, NULL, 0); }
}

static void test_exec_failure(void) {
    printf("exec failure is reported, not silent\n");
    /* A session that opens and instantly vanishes with no message is the
     * worst possible UX. The child must say why. */
    char *argv[] = { "/nonexistent/nhzterm/definitely-not-here", NULL };
    pid_t pid; char buf[4096] = {0};
    int fd = spawn_pty(argv, 80, 24, &pid);
    if (fd < 0) { check("spawn", 0, "forkpty failed"); return; }
    read_until(fd, "cannot exec", buf, sizeof buf, 3000);
    check("error message written to the pty", strstr(buf, "cannot exec") != NULL, buf);
    int status = 0;
    waitpid(pid, &status, 0);
    check("child exits 127 (command not found)",
          WIFEXITED(status) && WEXITSTATUS(status) == 127, "wrong exit code");
    close(fd);
}

static void test_exit_code(void) {
    printf("exit status propagation\n");
    char *argv[] = { "sh", "-c", "exit 42", NULL };
    pid_t pid;
    int fd = spawn_pty(argv, 80, 24, &pid);
    if (fd < 0) { check("spawn", 0, "forkpty failed"); return; }
    int status = 0;
    waitpid(pid, &status, 0);
    check("exit code 42 observed", WIFEXITED(status) && WEXITSTATUS(status) == 42, "");
    close(fd);
}

static void test_utf8_passthrough(void) {
    printf("UTF-8 / ANSI passthrough (TUI prerequisite)\n");
    char *argv[] = { "sh", "-c", "printf '\\033[31m\\342\\224\\214\\342\\224\\200\\342\\224\\220 \\360\\237\\232\\200\\033[0m\\n'", NULL };
    pid_t pid; char buf[4096] = {0};
    int fd = spawn_pty(argv, 80, 24, &pid);
    if (fd < 0) { check("spawn", 0, "forkpty failed"); return; }
    read_until(fd, "\xf0\x9f\x9a\x80", buf, sizeof buf, 3000);
    check("box-drawing bytes survive intact", strstr(buf, "\xe2\x94\x8c") != NULL, "mangled");
    check("emoji (4-byte utf8) survives", strstr(buf, "\xf0\x9f\x9a\x80") != NULL, "mangled");
    check("ANSI colour escapes survive", strstr(buf, "\033[31m") != NULL, "stripped");
    close(fd);
    waitpid(pid, NULL, 0);
}

int main(void) {
    printf("=== Part 1 / Phase 1 — real PTY acquisition (§4, §2.2) ===\n");
    test_basic_exec();
    test_is_a_tty();
    test_winsize();
    test_interactive_io();
    test_signal_to_group();
    test_exec_failure();
    test_exit_code();
    test_utf8_passthrough();
    printf("\npassed=%d failed=%d\n", passed, failed);
    if (failed) { printf("PHASE 1 GATE: FAILED\n"); return 1; }
    printf("PHASE 1 GATE: PASSED\n");
    return 0;
}
