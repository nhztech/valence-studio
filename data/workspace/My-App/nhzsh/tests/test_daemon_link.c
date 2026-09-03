/* nhzsh — Part 2 Phase 6 gate: foreground-PID reporting (§9).
 *
 * Build plan: "with a stub/mock listener standing in for nhztermd, confirm the
 * two messages arrive in the right order around a real command's lifetime."
 *
 * This is the hook that makes the UI's "Kill Process" able to kill the running
 * command WITHOUT killing the session's shell.
 */
#include "../src/daemon_link.h"
#include "../src/executor.h"
#include "../src/state.h"

#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static int passed = 0, failed = 0;

static void check(const char *name, int cond, const char *detail) {
    if (cond) { passed++; printf("  PASS  %s\n", name); }
    else { failed++; printf("  FAIL  %s -> %s\n", name, detail ? detail : ""); }
}

/* Reads one length-prefixed frame (nhzterm-api §6.1) from the mock daemon end. */
static char *read_frame(int fd) {
    unsigned char hdr[4];
    ssize_t n = read(fd, hdr, 4);
    if (n != 4) return NULL;
    size_t len = ((size_t) hdr[0] << 24) | ((size_t) hdr[1] << 16) |
                 ((size_t) hdr[2] << 8)  | (size_t) hdr[3];
    if (len == 0 || len > 65536) return NULL;
    char *buf = malloc(len + 1);
    if (!buf) return NULL;
    size_t off = 0;
    while (off < len) {
        ssize_t r = read(fd, buf + off, len - off);
        if (r <= 0) { free(buf); return NULL; }
        off += (size_t) r;
    }
    buf[len] = '\0';
    return buf;
}

int main(void) {
    printf("=== Part 2 / Phase 6 — daemon foreground-PID hook (§9) ===\n");

    /* socketpair stands in for nhztermd's control side-channel. */
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
        printf("socketpair failed\n");
        return 1;
    }

    /* A read timeout so a missing message FAILS the test instead of hanging
     * the whole suite forever. */
    struct timeval tv = { .tv_sec = 5, .tv_usec = 0 };
    setsockopt(sv[1], SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);

    shell_state st;
    state_init(&st);
    st.interactive = 0;
    st.daemon_fd = sv[0];
    free(st.session_id);
    st.session_id = strdup("s1-test");

    printf("framing\n");
    daemon_link_report_foreground(&st, 12345);
    char *f = read_frame(sv[1]);
    check("frame received", f != NULL, "nothing arrived");
    if (f) {
        check("type is foreground_pid", strstr(f, "\"type\":\"foreground_pid\"") != NULL, f);
        check("session id included", strstr(f, "\"session_id\":\"s1-test\"") != NULL, f);
        check("pid included", strstr(f, "\"pid\":12345") != NULL, f);
        free(f);
    }

    printf("null report (nothing in foreground)\n");
    daemon_link_report_foreground(&st, -1);
    f = read_frame(sv[1]);
    check("null frame received", f != NULL, "nothing arrived");
    if (f) {
        /* MUST be null, not 0 — the daemon uses null to mean "nothing running"
         * so a later process.kill returns PROCESS_NOT_FOUND instead of
         * killing the shell itself. */
        check("pid is null, not 0", strstr(f, "\"pid\":null") != NULL, f);
        free(f);
    }

    printf("ordering around a real command's lifetime\n");
    {
        /* Run a real external command and confirm exactly two reports bracket
         * it: the pid on exec, then null on completion. */
        int devnull = open("/dev/null", O_WRONLY);
        int saved = dup(STDOUT_FILENO);
        dup2(devnull, STDOUT_FILENO);
        /* Must be an EXTERNAL command: builtins run in-process and correctly
         * do NOT report a foreground pid (there is no child to kill). */
        executor_run_line(&st, "/bin/true");
        fflush(stdout);
        dup2(saved, STDOUT_FILENO);
        close(saved);
        close(devnull);

        char *first = read_frame(sv[1]);
        char *second = read_frame(sv[1]);

        check("first message sent on exec", first != NULL, "missing");
        check("second message sent on completion", second != NULL, "missing");

        if (first && second) {
            int first_has_pid = strstr(first, "\"pid\":null") == NULL;
            int second_is_null = strstr(second, "\"pid\":null") != NULL;
            check("order: real pid FIRST", first_has_pid, first);
            check("order: null SECOND", second_is_null, second);
        }
        free(first);
        free(second);
    }

    printf("resilience: a dead daemon must not kill the shell\n");
    {
        close(sv[1]);   /* daemon vanishes */
        signal(SIGPIPE, SIG_IGN);
        daemon_link_report_foreground(&st, 999);
        daemon_link_report_foreground(&st, -1);
        check("survived writing to a closed socket", 1, "");

        /* And with no daemon configured at all, nhzsh must still work. */
        shell_state s2;
        state_init(&s2);
        s2.interactive = 0;
        s2.daemon_fd = -1;
        daemon_link_report_foreground(&s2, 123);
        check("no-op when daemon_fd is -1", 1, "");
        state_free(&s2);
    }

    st.daemon_fd = -1;   /* already closed above */
    state_free(&st);

    printf("\npassed=%d failed=%d\n", passed, failed);
    if (failed) { printf("PHASE 6 GATE: FAILED\n"); return 1; }
    printf("PHASE 6 GATE: PASSED\n");
    return 0;
}
