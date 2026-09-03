/* nhzsh — Stage 5: the REPL (§5.2)
 *
 * Same loop for interactive and script mode; the only differences are the
 * input source and whether a prompt is printed.
 */
#include "builtins.h"
#include "daemon_link.h"
#include "executor.h"
#include "state.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static shell_state g_state;

static void print_prompt(shell_state *st) {
    if (!st->interactive) return;
    const char *ps1 = state_get_var(st, "PS1");
    fputs(ps1 && *ps1 ? ps1 : "nhz$ ", stdout);
    fflush(stdout);
}

/* Ctrl-C at the prompt must abandon the current line, NOT kill the shell —
 * killing the shell would tear down the whole nhzterm session. */
static void on_sigint(int sig) {
    (void) sig;
    const char msg[] = "\n";
    ssize_t r = write(STDOUT_FILENO, msg, sizeof msg - 1);
    (void) r;
}

static void source_rc(shell_state *st) {
    const char *rc = getenv("NHZSHRC");
    char buf[4096];
    if (!rc || !*rc) {
        const char *home = state_get_var(st, "HOME");
        if (!home) return;
        snprintf(buf, sizeof buf, "%s/.nhzshrc", home);
        rc = buf;
    }
    if (access(rc, R_OK) == 0) executor_run_script(st, rc);
}

static int repl(shell_state *st) {
    char *line = NULL;
    size_t cap = 0;

    for (;;) {
        print_prompt(st);

        ssize_t len = getline(&line, &cap, stdin);
        if (len < 0) {
            /* Ctrl-D / EOF. Newline so the prompt doesn't dangle. */
            if (st->interactive) fputs("\n", stdout);
            break;
        }
        if (len > 0 && line[len - 1] == '\n') line[len - 1] = '\0';

        if (line[0] == '\0') continue;

        state_add_history(st, line);
        executor_run_line(st, line);

        if (st->should_exit) break;
    }

    free(line);
    return st->should_exit ? st->exit_code : st->last_status;
}

int main(int argc, char **argv) {
    state_init(&g_state);
    daemon_link_init(&g_state);

    /* Remember our own path so $(...) can re-enter nhzsh rather than /bin/sh. */
    if (argv[0] && strchr(argv[0], '/')) setenv("NHZSH_SELF", argv[0], 0);

    /* Script mode = not a tty. Suppress the prompt when piped or redirected. */
    g_state.interactive = isatty(STDIN_FILENO) && isatty(STDOUT_FILENO);

    int rc = 0;

    /* -c "command string" */
    if (argc >= 3 && strcmp(argv[1], "-c") == 0) {
        g_state.interactive = 0;
        rc = executor_run_line(&g_state, argv[2]);
        goto done;
    }

    /* nhzsh script.sh */
    if (argc >= 2 && argv[1][0] != '-') {
        g_state.interactive = 0;
        rc = executor_run_script(&g_state, argv[1]);
        goto done;
    }

    if (g_state.interactive) {
        signal(SIGINT, on_sigint);
        /* A shell must ignore these, or a background child's death takes the
         * session down with it. */
        signal(SIGQUIT, SIG_IGN);
        signal(SIGTTOU, SIG_IGN);
        signal(SIGTTIN, SIG_IGN);
        source_rc(&g_state);
    }

    rc = repl(&g_state);

done:
    daemon_link_report_foreground(&g_state, -1);
    daemon_link_close(&g_state);
    state_free(&g_state);
    return rc;
}
