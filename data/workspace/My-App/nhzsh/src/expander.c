#include "expander.h"

#include <ctype.h>
#include <glob.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

/* ---- word list ---------------------------------------------------------- */

void word_list_init(word_list *w) { memset(w, 0, sizeof(*w)); }

int word_list_push(word_list *w, const char *s) {
    if (w->count == w->cap) {
        int cap = w->cap ? w->cap * 2 : 8;
        char **n = realloc(w->items, (size_t) (cap + 1) * sizeof(char *));
        if (!n) return -1;
        w->items = n;
        w->cap = cap;
    }
    w->items[w->count] = strdup(s ? s : "");
    if (!w->items[w->count]) return -1;
    w->count++;
    w->items[w->count] = NULL;
    return 0;
}

void word_list_free(word_list *w) {
    if (!w->items) return;
    for (int i = 0; i < w->count; ++i) free(w->items[i]);
    free(w->items);
    memset(w, 0, sizeof(*w));
}

/* ---- growable string ---------------------------------------------------- */

typedef struct { char *buf; size_t len, cap; } sbuf;

static int sb_push(sbuf *s, char c) {
    if (s->len + 1 >= s->cap) {
        size_t cap = s->cap ? s->cap * 2 : 64;
        char *n = realloc(s->buf, cap);
        if (!n) return -1;
        s->buf = n; s->cap = cap;
    }
    s->buf[s->len++] = c;
    s->buf[s->len] = '\0';
    return 0;
}

static int sb_puts(sbuf *s, const char *str) {
    if (!str) return 0;
    while (*str) if (sb_push(s, *str++)) return -1;
    return 0;
}

/* ---- command substitution ----------------------------------------------- */

/* Runs `cmd` via the shell itself and captures stdout. Trailing newlines are
 * stripped, exactly as POSIX requires — otherwise `x=$(pwd)` would embed a
 * newline and every path comparison would fail. */
static char *capture_command(shell_state *st, const char *cmd) {
    int fds[2];
    if (pipe(fds) != 0) return strdup("");

    pid_t pid = fork();
    if (pid < 0) { close(fds[0]); close(fds[1]); return strdup(""); }

    if (pid == 0) {
        close(fds[0]);
        dup2(fds[1], STDOUT_FILENO);
        close(fds[1]);
        /* Re-enter nhzsh so substitution honours our own grammar and builtins.
         * NHZSH_SELF is set by main(); falling back to sh keeps this working
         * when running the unit tests directly. */
        const char *self = getenv("NHZSH_SELF");
        /* A subshell inherits ALL shell variables, not just exported ones —
         * POSIX. Passing only the exported set would make $(echo $LOCALVAR)
         * silently empty. */
        char **envp = state_build_envp_all(st);
        if (self && *self) {
            char *argv[] = { (char *) "nhzsh", (char *) "-c", (char *) cmd, NULL };
            execve(self, argv, envp ? envp : environ);
        }
        /* execve, NOT execl: execl would inherit the PARENT PROCESS's environ
         * and silently lose every variable set inside this shell. */
        {
            char *argv[] = { (char *) "sh", (char *) "-c", (char *) cmd, NULL };
            execve("/bin/sh", argv, envp ? envp : environ);
            execve("/system/bin/sh", argv, envp ? envp : environ);
        }
        _exit(127);
    }

    close(fds[1]);
    sbuf out = { NULL, 0, 0 };
    char buf[1024];
    ssize_t n;
    while ((n = read(fds[0], buf, sizeof buf)) > 0)
        for (ssize_t i = 0; i < n; ++i)
            if (sb_push(&out, buf[i])) break;
    close(fds[0]);

    int status = 0;
    waitpid(pid, &status, 0);

    if (!out.buf) return strdup("");
    while (out.len && (out.buf[out.len - 1] == '\n' || out.buf[out.len - 1] == '\r'))
        out.buf[--out.len] = '\0';
    return out.buf;
}

/* ---- variable + substitution pass --------------------------------------- */

static int is_name_start(char c) { return isalpha((unsigned char) c) || c == '_'; }
static int is_name_char(char c)  { return isalnum((unsigned char) c) || c == '_'; }

static int expand_dollars(shell_state *st, const char *in, sbuf *out) {
    const char *p = in;

    while (*p) {
        if (*p != '$') { if (sb_push(out, *p++)) return -1; continue; }

        p++; /* consume '$' */

        if (*p == '\0') { if (sb_push(out, '$')) return -1; break; }

        /* $(...) command substitution — track nesting so $(echo $(date)) works */
        if (*p == '(') {
            p++;
            int depth = 1;
            sbuf inner = { NULL, 0, 0 };
            while (*p && depth > 0) {
                if (*p == '(') depth++;
                else if (*p == ')') { if (--depth == 0) break; }
                if (sb_push(&inner, *p++)) { free(inner.buf); return -1; }
            }
            if (*p == ')') p++;
            char *result = capture_command(st, inner.buf ? inner.buf : "");
            free(inner.buf);
            int rc = sb_puts(out, result);
            free(result);
            if (rc) return -1;
            continue;
        }

        /* ${VAR} */
        if (*p == '{') {
            p++;
            sbuf name = { NULL, 0, 0 };
            while (*p && *p != '}') if (sb_push(&name, *p++)) { free(name.buf); return -1; }
            if (*p == '}') p++;
            const char *val = name.buf ? state_get_var(st, name.buf) : NULL;
            free(name.buf);
            /* An unset variable expands to empty, never to a literal — that is
             * what every POSIX shell does. */
            if (val && sb_puts(out, val)) return -1;
            continue;
        }

        /* $? — last exit status */
        if (*p == '?') {
            char tmp[16];
            snprintf(tmp, sizeof tmp, "%d", st->last_status);
            p++;
            if (sb_puts(out, tmp)) return -1;
            continue;
        }

        /* $$ — shell pid */
        if (*p == '$') {
            char tmp[16];
            snprintf(tmp, sizeof tmp, "%d", (int) getpid());
            p++;
            if (sb_puts(out, tmp)) return -1;
            continue;
        }

        /* $NAME */
        if (is_name_start(*p)) {
            sbuf name = { NULL, 0, 0 };
            while (*p && is_name_char(*p)) if (sb_push(&name, *p++)) { free(name.buf); return -1; }
            const char *val = name.buf ? state_get_var(st, name.buf) : NULL;
            free(name.buf);
            if (val && sb_puts(out, val)) return -1;
            continue;
        }

        /* A '$' followed by something unexpandable stays literal. */
        if (sb_push(out, '$')) return -1;
    }
    return 0;
}

/* ---- tilde -------------------------------------------------------------- */

static char *expand_tilde(shell_state *st, const char *in) {
    /* Only a LEADING ~ expands, and only alone or before '/'. `a~b` and
     * `file~` (a backup file) must be left alone. */
    if (in[0] != '~' || (in[1] != '\0' && in[1] != '/')) return strdup(in);

    const char *home = state_get_var(st, "HOME");
    if (!home || !*home) return strdup(in);

    size_t len = strlen(home) + strlen(in);
    char *out = malloc(len + 1);
    if (!out) return strdup(in);
    snprintf(out, len + 1, "%s%s", home, in + 1);
    return out;
}

/* ---- glob --------------------------------------------------------------- */

static int has_glob_char(const char *s) {
    return strpbrk(s, "*?[") != NULL;
}

static int expand_glob(const char *pattern, word_list *out) {
    glob_t g;
    memset(&g, 0, sizeof g);
    int r = glob(pattern, 0, NULL, &g);
    if (r != 0 || g.gl_pathc == 0) {
        globfree(&g);
        /* No match: POSIX says the pattern is used literally. Expanding to
         * nothing would silently turn `rm *.tmp` into `rm`. */
        return word_list_push(out, pattern);
    }
    for (size_t i = 0; i < g.gl_pathc; ++i)
        if (word_list_push(out, g.gl_pathv[i])) { globfree(&g); return -1; }
    globfree(&g);
    return 0;
}

/* ---- driver ------------------------------------------------------------- */

int expander_expand_word(shell_state *st, const char *word, int single_quoted, word_list *out) {
    if (!word) return 0;

    /* Single quotes suppress EVERYTHING. */
    if (single_quoted) return word_list_push(out, word);

    sbuf dollars = { NULL, 0, 0 };
    if (expand_dollars(st, word, &dollars)) { free(dollars.buf); return -1; }
    const char *after_dollars = dollars.buf ? dollars.buf : "";

    char *tilded = expand_tilde(st, after_dollars);
    free(dollars.buf);
    if (!tilded) return -1;

    int rc;
    if (has_glob_char(tilded)) rc = expand_glob(tilded, out);
    else rc = word_list_push(out, tilded);

    free(tilded);
    return rc;
}

int expander_expand_argv(shell_state *st, char **argv, int argc,
                         const int *single_quoted, word_list *out) {
    for (int i = 0; i < argc; ++i) {
        int sq = single_quoted ? single_quoted[i] : 0;
        if (expander_expand_word(st, argv[i], sq, out)) return -1;
    }
    return 0;
}
