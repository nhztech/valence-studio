/* nhzsh — Part 2 Phase 4 & 5 gate: executor + state/REPL.
 *
 * Build plan Phase 4: "run a simple command, a piped command (cmd1 | cmd2),
 * and a builtin (cd followed by pwd confirming the directory changed)."
 * Phase 5: "run a multi-line .sh script and confirm cwd/env changes on one
 * line are visible on the next."
 */
#include "../src/executor.h"
#include "../src/builtins.h"
#include "../src/state.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static int passed = 0, failed = 0;

static void check(const char *name, int cond, const char *detail) {
    if (cond) { passed++; printf("  PASS  %s\n", name); }
    else { failed++; printf("  FAIL  %s -> %s\n", name, detail ? detail : ""); }
}

/* Runs a line with stdout captured, so we can assert on real output. */
static char *run_capture(shell_state *st, const char *line, int *status) {
    char tmpl[] = "/tmp/nhzsh_cap_XXXXXX";
    int fd = mkstemp(tmpl);
    if (fd < 0) return strdup("");

    int saved = dup(STDOUT_FILENO);
    fflush(stdout);
    dup2(fd, STDOUT_FILENO);

    int rc = executor_run_line(st, line);
    fflush(stdout);

    dup2(saved, STDOUT_FILENO);
    close(saved);
    if (status) *status = rc;

    lseek(fd, 0, SEEK_SET);
    static char buf[65536];
    ssize_t n = read(fd, buf, sizeof buf - 1);
    buf[n > 0 ? n : 0] = '\0';
    close(fd);
    unlink(tmpl);
    return strdup(buf);
}

static void expect_out(shell_state *st, const char *line, const char *want) {
    int rc = 0;
    char *got = run_capture(st, line, &rc);
    char name[512];
    snprintf(name, sizeof name, "run: %s", line);
    check(name, strcmp(got, want) == 0, got);
    free(got);
}

static void expect_status(shell_state *st, const char *line, int want) {
    int rc = 0;
    char *got = run_capture(st, line, &rc);
    char name[512], detail[64];
    snprintf(name, sizeof name, "status %d: %s", want, line);
    snprintf(detail, sizeof detail, "got %d", rc);
    check(name, rc == want, detail);
    free(got);
}

int main(void) {
    printf("=== Part 2 / Phase 4+5 — executor, builtins, state (§5.2) ===\n");

    shell_state st;
    state_init(&st);
    st.interactive = 0;

    printf("simple commands\n");
    expect_out(&st, "echo hello", "hello\n");
    expect_out(&st, "echo hello world", "hello world\n");
    expect_out(&st, "echo -n nonewline", "nonewline");
    expect_out(&st, "true", "");

    printf("external commands\n");
    expect_out(&st, "printf 'abc\\n'", "abc\n");

    printf("pipelines (cmd1 | cmd2)\n");
    expect_out(&st, "printf 'a\\nb\\nc\\n' | grep b", "b\n");
    expect_out(&st, "printf 'x\\ny\\n' | wc -l", "2\n");
    /* Three stages: proves each '|' gets its own real pipe. */
    expect_out(&st, "printf 'a\\nb\\nc\\n' | grep -v b | wc -l", "2\n");

    printf("builtin: cd then pwd (directory really changed)\n");
    {
        expect_out(&st, "cd /tmp", "");
        char *got = run_capture(&st, "pwd", NULL);
        check("pwd reflects the cd", strcmp(got, "/tmp\n") == 0, got);
        free(got);
        /* The PROCESS cwd must have moved too, not just the shell's record. */
        char buf[4096];
        getcwd(buf, sizeof buf);
        check("process cwd moved", strcmp(buf, "/tmp") == 0, buf);
    }

    printf("builtin: export / unset\n");
    expect_out(&st, "export GREETING=hi", "");
    expect_out(&st, "echo $GREETING", "hi\n");
    expect_out(&st, "unset GREETING", "");
    expect_out(&st, "echo [$GREETING]", "[]\n");

    printf("variable assignment (POSIX)\n");
    expect_out(&st, "X=42", "");
    expect_out(&st, "echo $X", "42\n");
    /* `VAR=v cmd` must scope to that command only. */
    expect_out(&st, "TMPV=once true", "");
    expect_out(&st, "echo [$TMPV]", "[]\n");

    printf("builtin: alias\n");
    expect_out(&st, "alias greet='echo aliased'", "");
    expect_out(&st, "greet", "aliased\n");

    printf("exit codes and $?\n");
    expect_status(&st, "true", 0);
    expect_status(&st, "false", 1);
    expect_out(&st, "false", "");
    expect_out(&st, "echo $?", "1\n");
    expect_out(&st, "true", "");
    expect_out(&st, "echo $?", "0\n");
    expect_status(&st, "nosuchcommand_xyz", 127);

    printf("conditional chains short-circuit\n");
    expect_out(&st, "true && echo ran", "ran\n");
    expect_out(&st, "false && echo notran", "");
    expect_out(&st, "false || echo fallback", "fallback\n");
    expect_out(&st, "true || echo notran", "");
    expect_out(&st, "echo a ; echo b", "a\nb\n");
    expect_out(&st, "false && echo no || echo yes", "yes\n");

    printf("redirection\n");
    {
        expect_out(&st, "echo redirected > /tmp/nhzsh_r.txt", "");
        FILE *f = fopen("/tmp/nhzsh_r.txt", "r");
        char buf[256] = {0};
        if (f) { size_t n = fread(buf, 1, sizeof buf - 1, f); buf[n] = '\0'; fclose(f); }
        check("> wrote the file", strcmp(buf, "redirected\n") == 0, buf);

        expect_out(&st, "echo more >> /tmp/nhzsh_r.txt", "");
        f = fopen("/tmp/nhzsh_r.txt", "r");
        memset(buf, 0, sizeof buf);
        if (f) { size_t n = fread(buf, 1, sizeof buf - 1, f); buf[n] = '\0'; fclose(f); }
        check(">> appended, did not truncate", strcmp(buf, "redirected\nmore\n") == 0, buf);

        expect_out(&st, "wc -l < /tmp/nhzsh_r.txt", "2\n");
        unlink("/tmp/nhzsh_r.txt");
    }

    printf("expansion inside execution\n");
    expect_out(&st, "export W=world", "");
    expect_out(&st, "echo hello $W", "hello world\n");
    expect_out(&st, "echo \"quoted $W\"", "quoted world\n");
    expect_out(&st, "echo '$W'", "$W\n");
    expect_out(&st, "echo $(echo nested)", "nested\n");

    printf("history\n");
    state_add_history(&st, "cmd one");
    state_add_history(&st, "cmd two");
    state_add_history(&st, "cmd two");   /* consecutive dup ignored */
    check("history recorded", st.hist_count == 2, "wrong count");

    printf("Phase 5 — multi-line script, state persists across lines\n");
    {
        const char *path = "/tmp/nhzsh_script_test.sh";
        FILE *f = fopen(path, "w");
        fprintf(f,
                "#!/usr/bin/env nhzsh\n"
                "export SCRIPTVAR=persisted\n"
                "cd /tmp\n"
                "echo var=$SCRIPTVAR\n"          /* set on an earlier line */
                "echo dir=$(pwd)\n"              /* cd on an earlier line  */
                "COUNTER=1\n"
                "echo counter=$COUNTER\n");
        fclose(f);

        shell_state s2;
        state_init(&s2);
        s2.interactive = 0;

        char tmpl[] = "/tmp/nhzsh_sout_XXXXXX";
        int fd = mkstemp(tmpl);
        int saved = dup(STDOUT_FILENO);
        fflush(stdout);
        dup2(fd, STDOUT_FILENO);
        executor_run_script(&s2, path);
        fflush(stdout);
        dup2(saved, STDOUT_FILENO);
        close(saved);

        lseek(fd, 0, SEEK_SET);
        char buf[4096] = {0};
        ssize_t n = read(fd, buf, sizeof buf - 1);
        buf[n > 0 ? n : 0] = '\0';
        close(fd);
        unlink(tmpl);

        check("env set on line 1 visible on line 3", strstr(buf, "var=persisted") != NULL, buf);
        check("cwd changed on line 2 visible on line 4", strstr(buf, "dir=/tmp") != NULL, buf);
        check("assignment persists across lines", strstr(buf, "counter=1") != NULL, buf);
        check("shebang skipped, not executed", strstr(buf, "command not found") == NULL, buf);

        state_free(&s2);
        unlink(path);
    }

    state_free(&st);

    printf("\npassed=%d failed=%d\n", passed, failed);
    if (failed) { printf("PHASE 4+5 GATE: FAILED\n"); return 1; }
    printf("PHASE 4+5 GATE: PASSED\n");
    return 0;
}
