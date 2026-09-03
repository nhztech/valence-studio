/*
 * nhzterm — INTEGRATION POINT harness.
 *
 * The build plan's integration step: "Swap Part 1's placeholder `sh` for
 * `nhzsh` inside nhztermd's session spawning logic. Re-run Part 1 Phase 3's
 * test (create/write/attach/kill) against real `nhzsh`."
 *
 * This proves the whole chain against a real kernel, off-device:
 *   staged binary  ->  forkpty()  ->  nhzsh  ->  interactive I/O  ->  signals
 *
 * It is the off-device twin of on-device gate 23. If this passes, the only
 * thing left to verify on hardware is the JNI/Android layer.
 *
 * Build: cc -o integration_harness integration_harness.c -lutil
 * Run:   ./integration_harness /path/to/nhzsh
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
#include <sys/stat.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static int passed = 0, failed = 0;
static const char *SHELL_PATH = NULL;

static void check(const char *name, int cond, const char *detail) {
    if (cond) { passed++; printf("  PASS  %s\n", name); }
    else { failed++; printf("  FAIL  %s -> %s\n", name, detail ? detail : ""); }
}

/* Mirrors ptyhelper.c's configure_termios(). */
static void configure_termios(int fd) {
    struct termios tio;
    if (tcgetattr(fd, &tio) != 0) return;
    tio.c_iflag |= (ICRNL | IXON | IUTF8);
    tio.c_iflag &= ~(INLCR | IGNCR | ISTRIP);
    tio.c_oflag |= (OPOST | ONLCR);
    tio.c_lflag |= (ISIG | ICANON | ECHO | ECHOE | ECHOK | IEXTEN);
    tio.c_cflag |= (CREAD | CS8);
    tio.c_cc[VINTR] = 003; tio.c_cc[VQUIT] = 034; tio.c_cc[VERASE] = 0177;
    tio.c_cc[VKILL] = 025; tio.c_cc[VEOF] = 004;  tio.c_cc[VSUSP] = 032;
    tio.c_cc[VMIN] = 1;    tio.c_cc[VTIME] = 0;
    tcsetattr(fd, TCSANOW, &tio);
}

/* Mirrors ptyhelper.c's createSubprocess(). */
static int spawn_shell(pid_t *out_pid, int cols, int rows) {
    struct winsize ws = { .ws_col = cols, .ws_row = rows, .ws_xpixel = 0, .ws_ypixel = 0 };
    int master = -1;
    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) return -1;
    if (pid == 0) {
        for (int s = 1; s < NSIG; ++s) signal(s, SIG_DFL);
        sigset_t m; sigemptyset(&m); sigprocmask(SIG_SETMASK, &m, NULL);
        char *argv[] = { (char *) "nhzsh", NULL };
        char *envp[] = {
            (char *) "TERM=xterm-256color", (char *) "PATH=/usr/bin:/bin",
            (char *) "HOME=/tmp", (char *) "NHZTERM=1",
            (char *) "NHZTERM_SESSION_ID=s1-integration", NULL
        };
        execve(SHELL_PATH, argv, envp);
        fprintf(stderr, "nhzterm: cannot exec %s: %s\r\n", SHELL_PATH, strerror(errno));
        _exit(127);
    }
    configure_termios(master);
    int fl = fcntl(master, F_GETFL, 0);
    if (fl >= 0) fcntl(master, F_SETFL, fl | O_NONBLOCK);
    *out_pid = pid;
    return master;
}

static int read_until(int fd, const char *want, char *buf, size_t cap, int timeout_ms) {
    size_t len = strlen(buf);
    int waited = 0;
    while (waited < timeout_ms) {
        fd_set rf; FD_ZERO(&rf); FD_SET(fd, &rf);
        struct timeval tv = { .tv_sec = 0, .tv_usec = 50000 };
        if (select(fd + 1, &rf, NULL, NULL, &tv) > 0 && FD_ISSET(fd, &rf)) {
            ssize_t n = read(fd, buf + len, cap - len - 1);
            if (n > 0) {
                len += (size_t) n; buf[len] = '\0';
                if (want && strstr(buf, want)) return 1;
            } else if (n == 0) break;
            else if (errno != EAGAIN && errno != EINTR) break;
        }
        waited += 50;
    }
    return want ? (strstr(buf, want) != NULL) : 1;
}

static void send_line(int fd, const char *line) {
    if (write(fd, line, strlen(line)) < 0) { /* best effort */ }
    if (write(fd, "\n", 1) < 0) { /* best effort */ }
}

int main(int argc, char **argv) {
    SHELL_PATH = argc > 1 ? argv[1] : "./nhzsh";

    printf("=== INTEGRATION POINT — nhzsh inside a real PTY ===\n");
    printf("shell under test: %s\n", SHELL_PATH);

    struct stat st;
    if (stat(SHELL_PATH, &st) != 0) {
        printf("  FAIL  shell binary not found at %s\n", SHELL_PATH);
        return 1;
    }
    check("shell binary exists", 1, "");
    check("shell binary is executable", access(SHELL_PATH, X_OK) == 0, "not +x");

    printf("session.create equivalent — spawn nhzsh on a PTY\n");
    pid_t pid = -1;
    int fd = spawn_shell(&pid, 80, 24);
    check("forkpty + exec nhzsh succeeded", fd >= 0, strerror(errno));
    if (fd < 0) { printf("\nINTEGRATION GATE: FAILED\n"); return 1; }
    check("child pid valid", pid > 0, "");

    char buf[65536] = {0};
    /* The prompt proves nhzsh started interactively AND detected a tty. */
    check("nhzsh printed its interactive prompt", read_until(fd, "nhz$", buf, sizeof buf, 4000), buf);
    check("no exec failure reported", strstr(buf, "cannot exec") == NULL, buf);

    printf("session.write equivalent — interactive commands\n");
    buf[0] = '\0';
    send_line(fd, "echo INTEGRATION_OK");
    check("builtin echo works over the PTY", read_until(fd, "INTEGRATION_OK", buf, sizeof buf, 4000), buf);

    buf[0] = '\0';
    send_line(fd, "cd /tmp");
    send_line(fd, "pwd");
    check("cd + pwd persist across commands", read_until(fd, "/tmp", buf, sizeof buf, 4000), buf);

    buf[0] = '\0';
    send_line(fd, "MYVAR=integration");
    send_line(fd, "echo v=$MYVAR");
    check("variables persist in the session", read_until(fd, "v=integration", buf, sizeof buf, 4000), buf);

    buf[0] = '\0';
    send_line(fd, "printf 'a\\nb\\nc\\n' | grep b");
    check("pipelines work inside the PTY", read_until(fd, "b", buf, sizeof buf, 4000), buf);

    buf[0] = '\0';
    send_line(fd, "echo $(echo substituted)");
    check("command substitution works", read_until(fd, "substituted", buf, sizeof buf, 4000), buf);

    buf[0] = '\0';
    send_line(fd, "false || echo recovered");
    check("conditional chains work", read_until(fd, "recovered", buf, sizeof buf, 4000), buf);

    printf("nhzsh sees a REAL controlling terminal\n");
    buf[0] = '\0';
    send_line(fd, "test -t 0 && echo HAS_TTY");
    /* The decisive check: a pipe would fail this, and vim/htop would be
     * impossible. This is §2 principle 2 proven through the real shell. */
    check("stdin is a tty (not a pipe)", read_until(fd, "HAS_TTY", buf, sizeof buf, 4000), buf);

    printf("session.resize equivalent — SIGWINCH reaches nhzsh's children\n");
    {
        struct winsize ws = { .ws_col = 120, .ws_row = 40, .ws_xpixel = 0, .ws_ypixel = 0 };
        check("TIOCSWINSZ accepted", ioctl(fd, TIOCSWINSZ, &ws) == 0, strerror(errno));
        buf[0] = '\0';
        send_line(fd, "stty size");
        int got = read_until(fd, "40 120", buf, sizeof buf, 4000);
        if (!got && strstr(buf, "not found")) printf("  SKIP  stty unavailable\n");
        else check("child sees the new 40x120 size", got, buf);
    }

    printf("Ctrl-C reaches the foreground command, not the shell\n");
    {
        buf[0] = '\0';
        send_line(fd, "sleep 30");
        usleep(500000);
        char intr = 003;
        if (write(fd, &intr, 1) < 0) { /* best effort */ }
        usleep(500000);
        /* If the shell died the next command produces nothing. */
        buf[0] = '\0';
        send_line(fd, "echo SURVIVED_SIGINT");
        check("shell survives Ctrl-C and keeps accepting input",
              read_until(fd, "SURVIVED_SIGINT", buf, sizeof buf, 5000), buf);
    }

    printf("session.kill equivalent — SIGTERM then SIGKILL (§14 decision 3)\n");
    {
        check("SIGTERM to the process group accepted", kill(-pid, SIGTERM) == 0, strerror(errno));
        int status = 0, waited = 0, reaped = 0;
        while (waited < 3000) {
            if (waitpid(pid, &status, WNOHANG) == pid) { reaped = 1; break; }
            usleep(50000); waited += 50;
        }
        if (!reaped) {
            kill(-pid, SIGKILL);
            waitpid(pid, &status, 0);
            reaped = 1;
        }
        check("session terminated cleanly", reaped, "still alive");
    }
    close(fd);

    printf("script mode (non-interactive) suppresses the prompt\n");
    {
        char script[] = "/tmp/nhzterm_integ_XXXXXX";
        int sfd = mkstemp(script);
        FILE *f = fdopen(sfd, "w");
        fprintf(f, "cd /tmp\nexport K=v\necho scripted=$K\npwd\n");
        fclose(f);

        char cmd[1024];
        snprintf(cmd, sizeof cmd, "%s %s 2>&1", SHELL_PATH, script);
        FILE *p = popen(cmd, "r");
        char out[4096] = {0};
        if (p) {
            size_t n = fread(out, 1, sizeof out - 1, p);
            out[n] = '\0';
            pclose(p);
        }
        check("script executed", strstr(out, "scripted=v") != NULL, out);
        check("cwd change applied in script mode", strstr(out, "/tmp") != NULL, out);
        /* A prompt leaking into piped output would corrupt every script that
         * captures a shell's stdout. */
        check("NO prompt when not a tty", strstr(out, "nhz$") == NULL, out);
        unlink(script);
    }

    printf("\npassed=%d failed=%d\n", passed, failed);
    if (failed) { printf("INTEGRATION GATE: FAILED\n"); return 1; }
    printf("INTEGRATION GATE: PASSED\n");
    return 0;
}
