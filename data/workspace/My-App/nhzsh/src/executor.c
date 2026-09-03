#include "executor.h"
#include "builtins.h"
#include "daemon_link.h"
#include "expander.h"
#include "lexer.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

/* Applies a command's redirections in the CHILD, after fork. Returns 0 ok. */
static int apply_redirects(redirect *r) {
    for (; r; r = r->next) {
        int fd;
        switch (r->type) {
            case REDIR_OUT:
                fd = open(r->target, O_WRONLY | O_CREAT | O_TRUNC, 0644);
                if (fd < 0) { fprintf(stderr, "nhzsh: %s: %s\n", r->target, strerror(errno)); return -1; }
                dup2(fd, STDOUT_FILENO); close(fd);
                break;
            case REDIR_APPEND:
                fd = open(r->target, O_WRONLY | O_CREAT | O_APPEND, 0644);
                if (fd < 0) { fprintf(stderr, "nhzsh: %s: %s\n", r->target, strerror(errno)); return -1; }
                dup2(fd, STDOUT_FILENO); close(fd);
                break;
            case REDIR_IN:
                fd = open(r->target, O_RDONLY);
                if (fd < 0) { fprintf(stderr, "nhzsh: %s: %s\n", r->target, strerror(errno)); return -1; }
                dup2(fd, STDIN_FILENO); close(fd);
                break;
        }
    }
    return 0;
}

/* Expands a redirect target — `> $LOGFILE` must work. */
static int expand_redirects(shell_state *st, redirect *r) {
    for (; r; r = r->next) {
        word_list w; word_list_init(&w);
        if (expander_expand_word(st, r->target, 0, &w) == 0 && w.count > 0) {
            char *n = strdup(w.items[0]);
            if (n) { free(r->target); r->target = n; }
        }
        word_list_free(&w);
    }
    return 0;
}

/* Resolves a bare command name against PATH. Caller frees, or NULL. */
static char *resolve_path(shell_state *st, const char *cmd) {
    if (strchr(cmd, '/')) return strdup(cmd); /* explicit path */

    const char *path = state_get_var(st, "PATH");
    if (!path || !*path) path = "/system/bin:/usr/bin:/bin";

    char *copy = strdup(path);
    if (!copy) return NULL;

    char *saveptr = NULL;
    char buf[4096];
    for (char *dir = strtok_r(copy, ":", &saveptr); dir; dir = strtok_r(NULL, ":", &saveptr)) {
        if (!*dir) continue;
        snprintf(buf, sizeof buf, "%s/%s", dir, cmd);
        if (access(buf, X_OK) == 0) { free(copy); return strdup(buf); }
    }
    free(copy);
    return NULL;
}

/* Substitutes a leading alias. One level only — enough for `ll`, and it
 * cannot infinitely recurse the way full alias chasing can. */
static void apply_alias(shell_state *st, word_list *w) {
    if (w->count == 0) return;
    const char *a = state_get_alias(st, w->items[0]);
    if (!a) return;

    token_list toks;
    const char *err = NULL;
    if (lexer_tokenize(a, &toks, &err) != 0) return;

    word_list out;
    word_list_init(&out);
    for (size_t i = 0; i < toks.count; ++i)
        if (toks.items[i].type == TOK_WORD) word_list_push(&out, toks.items[i].value);
    token_list_free(&toks);

    if (out.count == 0) { word_list_free(&out); return; }

    for (int i = 1; i < w->count; ++i) word_list_push(&out, w->items[i]);
    word_list_free(w);
    *w = out;
}

/* True if `w` is a bare `NAME=value` assignment (a valid POSIX name before
 * the '='), which is a shell operation, not a command to exec. */
static int is_assignment(const char *w) {
    if (!w || !*w) return 0;
    if (!isalpha((unsigned char) *w) && *w != '_') return 0;
    for (const char *p = w; *p; ++p) {
        if (*p == '=') return p > w;
        if (!isalnum((unsigned char) *p) && *p != '_') return 0;
    }
    return 0;
}

/* Consumes leading `NAME=value` words. Returns how many were applied.
 *
 * POSIX distinguishes two cases:
 *   `X=1`         -> sets a shell variable for the rest of the session
 *   `X=1 cmd`     -> sets X in cmd's environment ONLY
 * Both are extremely common in real .sh scripts (§Phase 8). */
static int apply_assignments(shell_state *st, word_list *w, int prefix_only) {
    int applied = 0;
    while (applied < w->count && is_assignment(w->items[applied])) {
        char *eq = strchr(w->items[applied], '=');
        *eq = '\0';
        /* A prefix assignment (X=1 cmd) is exported so the child sees it;
         * a standalone one stays a plain shell variable. */
        state_set_var(st, w->items[applied], eq + 1, prefix_only ? 1 : 0);
        *eq = '=';
        applied++;
    }
    return applied;
}

/* Undoes temporary `X=1 cmd` assignments after an in-process builtin. */
static void restore_assignments(shell_state *st, char **names, char **values, int count) {
    for (int i = 0; i < count; ++i) {
        if (!names || !names[i]) continue;
        if (values && values[i]) state_set_var(st, names[i], values[i], 1);
        else state_unset_var(st, names[i]);
        free(names[i]);
        if (values) free(values[i]);
    }
    free(names);
    free(values);
}

/* Executes one pipeline. Returns its exit status. */
static int run_pipeline(shell_state *st, pipeline *p) {
    /* Count stages. */
    int n = 0;
    for (command *c = p->commands; c; c = c->next) n++;
    if (n == 0) return 0;

    /* --- single builtin: run IN-PROCESS so cd/export actually persist --- */
    if (n == 1) {
        command *c = p->commands;
        word_list w; word_list_init(&w);
        char **saved_names = NULL, **saved_values = NULL;
        int saved_count = 0;
        if (expander_expand_argv(st, c->argv, c->argc, c->argv_single_quoted, &w) != 0) {
            word_list_free(&w);
            return 1;
        }
        if (w.count > 0 && is_assignment(w.items[0])) {
            /* Count the leading assignments WITHOUT applying them yet — the
             * prior values must be snapshotted before anything is overwritten. */
            int used = 0;
            while (used < w.count && is_assignment(w.items[used])) used++;

            if (used == w.count) {
                /* Bare `X=1` with no command: a plain session variable. */
                apply_assignments(st, &w, 0);
                word_list_free(&w);
                st->last_status = 0;
                return 0;
            }

            /* `X=1 cmd`. If cmd turns out to be a BUILTIN it runs in-process,
             * so the assignment must be undone afterwards — it applies to the
             * command only, never to the session. */
            saved_names = calloc((size_t) used, sizeof(char *));
            saved_values = calloc((size_t) used, sizeof(char *));
            saved_count = used;
            for (int i = 0; i < used; ++i) {
                char *eq = strchr(w.items[i], '=');
                *eq = '\0';
                if (saved_names && saved_values) {
                    saved_names[i] = strdup(w.items[i]);
                    const char *prev = state_get_var(st, w.items[i]);
                    saved_values[i] = prev ? strdup(prev) : NULL;
                }
                state_set_var(st, w.items[i], eq + 1, 1);
                *eq = '=';
            }
            word_list rest; word_list_init(&rest);
            for (int i = used; i < w.count; ++i) word_list_push(&rest, w.items[i]);
            word_list_free(&w);
            w = rest;
        }

        apply_alias(st, &w);

        if (w.count > 0 && builtin_is(w.items[0]) && !p->background) {
            expand_redirects(st, c->redirects);

            /* Honour redirects for builtins too (`echo hi > f`) by swapping
             * the real fds around the call and restoring them after. */
            int saved_out = -1, saved_in = -1;
            if (c->redirects) {
                saved_out = dup(STDOUT_FILENO);
                saved_in  = dup(STDIN_FILENO);
                if (apply_redirects(c->redirects) != 0) {
                    if (saved_out >= 0) { dup2(saved_out, STDOUT_FILENO); close(saved_out); }
                    if (saved_in  >= 0) { dup2(saved_in,  STDIN_FILENO);  close(saved_in);  }
                    word_list_free(&w);
                    return 1;
                }
            }

            int rc = builtin_run(st, w.items, w.count);
            fflush(stdout);

            if (saved_out >= 0) { dup2(saved_out, STDOUT_FILENO); close(saved_out); }
            if (saved_in  >= 0) { dup2(saved_in,  STDIN_FILENO);  close(saved_in);  }

            restore_assignments(st, saved_names, saved_values, saved_count);
            word_list_free(&w);
            st->last_status = rc;
            return rc;
        }
        restore_assignments(st, saved_names, saved_values, saved_count);
        word_list_free(&w);
    }

    /* --- general case: fork a child per stage, pipes between them --- */
    int prev_read = -1;
    pid_t *pids = calloc((size_t) n, sizeof(pid_t));
    if (!pids) return 1;

    int idx = 0;
    for (command *c = p->commands; c; c = c->next, ++idx) {
        int fds[2] = { -1, -1 };
        if (c->next && pipe(fds) != 0) {
            fprintf(stderr, "nhzsh: pipe: %s\n", strerror(errno));
            free(pids);
            return 1;
        }

        word_list w; word_list_init(&w);
        expander_expand_argv(st, c->argv, c->argc, c->argv_single_quoted, &w);
        apply_alias(st, &w);
        expand_redirects(st, c->redirects);

        pid_t pid = fork();
        if (pid < 0) {
            fprintf(stderr, "nhzsh: fork: %s\n", strerror(errno));
            word_list_free(&w);
            free(pids);
            return 1;
        }

        if (pid == 0) {
            /* ---- child ---- */
            /* Own process group for the whole pipeline, so Ctrl-C reaches
             * every stage rather than only the first. */
            setpgid(0, idx == 0 ? 0 : pids[0]);

            for (int s = 1; s < NSIG; ++s) signal(s, SIG_DFL);

            if (prev_read >= 0) { dup2(prev_read, STDIN_FILENO); close(prev_read); }
            if (fds[1] >= 0)    { close(fds[0]); dup2(fds[1], STDOUT_FILENO); close(fds[1]); }

            if (apply_redirects(c->redirects) != 0) _exit(1);

            /* `X=1 cmd` — apply in the CHILD only. Because this is a separate
             * process, the assignment correctly affects just this command and
             * cannot leak into the session, exactly as POSIX requires. */
            if (w.count > 0 && is_assignment(w.items[0])) {
                int used = apply_assignments(st, &w, 1);
                word_list rest; word_list_init(&rest);
                for (int i = used; i < w.count; ++i) word_list_push(&rest, w.items[i]);
                word_list_free(&w);
                w = rest;
                /* Bare assignments with no command: nothing left to exec. */
                if (w.count == 0) _exit(0);
            }

            if (w.count == 0) _exit(0);

            /* A builtin inside a pipeline runs in the child; its side effects
             * are correctly discarded when the stage exits. */
            if (builtin_is(w.items[0])) {
                int rc = builtin_run(st, w.items, w.count);
                fflush(stdout);
                _exit(rc);
            }

            char *prog = resolve_path(st, w.items[0]);
            if (!prog) {
                fprintf(stderr, "nhzsh: %s: command not found\n", w.items[0]);
                _exit(127);
            }
            char **envp = state_build_envp(st);
            execve(prog, w.items, envp ? envp : environ);
            fprintf(stderr, "nhzsh: %s: %s\n", w.items[0], strerror(errno));
            _exit(126);
        }

        /* ---- parent ---- */
        pids[idx] = pid;
        setpgid(pid, idx == 0 ? pid : pids[0]); /* race-free: both sides set it */

        if (prev_read >= 0) close(prev_read);
        if (fds[1] >= 0) close(fds[1]);
        prev_read = fds[0];

        word_list_free(&w);
    }

    if (prev_read >= 0) close(prev_read);

    if (p->background) {
        /* Report the job and DON'T wait — that is what & means. */
        printf("[%d]\n", (int) pids[0]);
        fflush(stdout);
        free(pids);
        st->last_status = 0;
        return 0;
    }

    /* §9: tell nhztermd which pid is in the foreground, so the UI's
     * "Kill Process" hits the command and not the shell. */
    daemon_link_report_foreground(st, (int) pids[0]);

    int status = 0;
    for (int i = 0; i < n; ++i) {
        int st_i = 0;
        if (waitpid(pids[i], &st_i, 0) < 0) continue;
        /* The pipeline's status is its LAST stage's, as POSIX specifies. */
        if (i == n - 1) {
            if (WIFEXITED(st_i)) status = WEXITSTATUS(st_i);
            else if (WIFSIGNALED(st_i)) status = 128 + WTERMSIG(st_i);
        }
    }

    /* pid:null — nothing in the foreground now, so a later process.kill is a
     * no-op rather than killing the shell (§9). */
    daemon_link_report_foreground(st, -1);

    free(pids);
    st->last_status = status;
    return status;
}

int executor_run_ast(shell_state *st, ast *tree) {
    int status = st->last_status;

    for (pipeline *p = tree->pipelines; p; p = p->next) {
        status = run_pipeline(st, p);
        st->last_status = status;

        if (st->should_exit) break;

        /* Short-circuit && and ||. */
        if (p->link == LINK_AND && status != 0) {
            /* Skip until a pipeline that is not AND-linked from a failure. */
            while (p->next && p->link == LINK_AND) p = p->next;
            if (!p->next) break;
        } else if (p->link == LINK_OR && status == 0) {
            while (p->next && p->link == LINK_OR) p = p->next;
            if (!p->next) break;
        }
    }
    return status;
}

int executor_run_line(shell_state *st, const char *line) {
    if (!line) return st->last_status;

    token_list toks;
    const char *err = NULL;
    if (lexer_tokenize(line, &toks, &err) != 0) {
        fprintf(stderr, "nhzsh: %s\n", err ? err : "lex error");
        st->last_status = 2;
        return 2;
    }

    ast tree;
    if (parser_parse(&toks, &tree, &err) != 0) {
        fprintf(stderr, "nhzsh: %s\n", err ? err : "parse error");
        token_list_free(&toks);
        st->last_status = 2;
        return 2;
    }

    int rc = executor_run_ast(st, &tree);
    ast_free(&tree);
    token_list_free(&toks);
    return rc;
}

int executor_run_script(shell_state *st, const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) {
        fprintf(stderr, "nhzsh: %s: %s\n", path, strerror(errno));
        return 1;
    }

    char *line = NULL;
    size_t cap = 0;
    ssize_t len;
    int rc = 0;

    while ((len = getline(&line, &cap, f)) > 0) {
        if (len > 0 && line[len - 1] == '\n') line[len - 1] = '\0';
        /* Skip the shebang so `load`ing a real script does not try to run it. */
        if (line[0] == '#' && line[1] == '!') continue;
        rc = executor_run_line(st, line);
        if (st->should_exit) break;
    }

    free(line);
    fclose(f);
    return rc;
}
