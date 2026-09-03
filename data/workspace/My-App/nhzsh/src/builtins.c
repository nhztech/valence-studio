#include "builtins.h"
#include "load.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *BUILTINS[] = {
    "cd", "export", "unset", "alias", "unalias", "pwd", "exit",
    "echo", "true", "false", "history", "help", "command", "type",
    /* Stage 7 custom builtins (§5.2) */
    "load", "unload", "list-libs",
    NULL
};

int builtin_is(const char *name) {
    if (!name) return 0;
    for (const char **b = BUILTINS; *b; ++b)
        if (strcmp(*b, name) == 0) return 1;
    return 0;
}

static int bi_cd(shell_state *st, char **argv, int argc) {
    const char *target;
    if (argc < 2) {
        target = state_get_var(st, "HOME");
        if (!target || !*target) {
            fprintf(stderr, "cd: HOME not set\n");
            return 1;
        }
    } else if (strcmp(argv[1], "-") == 0) {
        /* `cd -` returns to the previous directory and echoes it, as POSIX. */
        target = state_get_var(st, "OLDPWD");
        if (!target || !*target) {
            fprintf(stderr, "cd: OLDPWD not set\n");
            return 1;
        }
        printf("%s\n", target);
    } else {
        target = argv[1];
    }

    char *old = st->cwd ? strdup(st->cwd) : NULL;
    if (state_set_cwd(st, target) != 0) {
        fprintf(stderr, "cd: %s: No such file or directory\n", target);
        free(old);
        return 1;
    }
    if (old) { state_set_var(st, "OLDPWD", old, 1); free(old); }
    return 0;
}

static int bi_pwd(shell_state *st, char **argv, int argc) {
    (void) argv; (void) argc;
    printf("%s\n", st->cwd ? st->cwd : "/");
    return 0;
}

static int bi_export(shell_state *st, char **argv, int argc) {
    if (argc < 2) {
        for (var_entry *v = st->vars; v; v = v->next)
            if (v->exported) printf("export %s=%s\n", v->name, v->value);
        return 0;
    }
    for (int i = 1; i < argc; ++i) {
        char *eq = strchr(argv[i], '=');
        if (eq) {
            *eq = '\0';
            state_set_var(st, argv[i], eq + 1, 1);
            *eq = '=';
        } else {
            state_export(st, argv[i]);
        }
    }
    return 0;
}

static int bi_unset(shell_state *st, char **argv, int argc) {
    for (int i = 1; i < argc; ++i) state_unset_var(st, argv[i]);
    return 0;
}

static int bi_alias(shell_state *st, char **argv, int argc) {
    if (argc < 2) {
        for (alias_entry *a = st->aliases; a; a = a->next)
            printf("alias %s='%s'\n", a->name, a->value);
        return 0;
    }
    for (int i = 1; i < argc; ++i) {
        char *eq = strchr(argv[i], '=');
        if (!eq) {
            const char *v = state_get_alias(st, argv[i]);
            if (v) printf("alias %s='%s'\n", argv[i], v);
            else { fprintf(stderr, "alias: %s: not found\n", argv[i]); return 1; }
            continue;
        }
        *eq = '\0';
        state_set_alias(st, argv[i], eq + 1);
        *eq = '=';
    }
    return 0;
}

static int bi_unalias(shell_state *st, char **argv, int argc) {
    for (int i = 1; i < argc; ++i) state_unset_alias(st, argv[i]);
    return 0;
}

static int bi_exit(shell_state *st, char **argv, int argc) {
    st->should_exit = 1;
    st->exit_code = argc > 1 ? atoi(argv[1]) : st->last_status;
    return st->exit_code;
}

static int bi_echo(shell_state *st, char **argv, int argc) {
    (void) st;
    int nl = 1, start = 1;
    if (argc > 1 && strcmp(argv[1], "-n") == 0) { nl = 0; start = 2; }
    for (int i = start; i < argc; ++i) {
        if (i > start) putchar(' ');
        fputs(argv[i], stdout);
    }
    if (nl) putchar('\n');
    fflush(stdout);
    return 0;
}

static int bi_history(shell_state *st, char **argv, int argc) {
    (void) argv; (void) argc;
    for (size_t i = 0; i < st->hist_count; ++i)
        printf("%5zu  %s\n", i + 1, st->history[i]);
    return 0;
}

static int bi_help(shell_state *st, char **argv, int argc) {
    (void) st; (void) argv; (void) argc;
    printf("nhzsh — POSIX-subset shell for nhzterm\n\nBuiltins:\n");
    for (const char **b = BUILTINS; *b; ++b) printf("  %s\n", *b);
    return 0;
}

/* `command -v NAME` — the standard "is this installed?" guard. Boot and
 * setup scripts lean on it constantly (nhzterm's own PTY probe is written
 * this way), so it must be a builtin: resolving PATH is shell knowledge. */
static int bi_command(shell_state *st, char **argv, int argc) {
    int vflag = 0, i = 1;
    for (; i < argc; ++i) {
        if (strcmp(argv[i], "-v") == 0 || strcmp(argv[i], "-V") == 0) vflag = 1;
        else break;
    }
    if (i >= argc) return 1;

    const char *name = argv[i];

    if (!vflag) {
        /* `command cmd args` bypasses functions/aliases; we have no functions
         * yet, so running it directly is the correct behaviour. */
        return -1; /* signals the caller to exec argv+i */
    }

    if (builtin_is(name)) { printf("%s\n", name); return 0; }
    if (state_get_alias(st, name)) {
        printf("alias %s='%s'\n", name, state_get_alias(st, name));
        return 0;
    }

    if (strchr(name, '/')) {
        if (access(name, X_OK) == 0) { printf("%s\n", name); return 0; }
        return 1;
    }

    const char *path = state_get_var(st, "PATH");
    if (!path || !*path) path = "/system/bin:/usr/bin:/bin";
    char *copy = strdup(path);
    if (!copy) return 1;

    char *save = NULL;
    char buf[4096];
    for (char *dir = strtok_r(copy, ":", &save); dir; dir = strtok_r(NULL, ":", &save)) {
        if (!*dir) continue;
        snprintf(buf, sizeof buf, "%s/%s", dir, name);
        if (access(buf, X_OK) == 0) {
            printf("%s\n", buf);
            free(copy);
            return 0;
        }
    }
    free(copy);
    return 1;  /* not found — the || branch of the guard runs */
}

int builtin_run(shell_state *st, char **argv, int argc) {
    if (argc == 0 || !argv[0]) return 0;
    const char *n = argv[0];

    if (strcmp(n, "cd") == 0)        return bi_cd(st, argv, argc);
    if (strcmp(n, "pwd") == 0)       return bi_pwd(st, argv, argc);
    if (strcmp(n, "export") == 0)    return bi_export(st, argv, argc);
    if (strcmp(n, "unset") == 0)     return bi_unset(st, argv, argc);
    if (strcmp(n, "alias") == 0)     return bi_alias(st, argv, argc);
    if (strcmp(n, "unalias") == 0)   return bi_unalias(st, argv, argc);
    if (strcmp(n, "exit") == 0)      return bi_exit(st, argv, argc);
    if (strcmp(n, "echo") == 0)      return bi_echo(st, argv, argc);
    if (strcmp(n, "true") == 0)      return 0;
    if (strcmp(n, "false") == 0)     return 1;
    if (strcmp(n, "history") == 0)   return bi_history(st, argv, argc);
    if (strcmp(n, "help") == 0)      return bi_help(st, argv, argc);
    if (strcmp(n, "command") == 0 || strcmp(n, "type") == 0) {
        int rc = bi_command(st, argv, argc);
        /* -1 means "not a -v query": fall through and run the real command. */
        if (rc >= 0) return rc;
        if (argc > 1) return builtin_run(st, argv + 1, argc - 1);
        return 0;
    }
    if (strcmp(n, "load") == 0)      return load_builtin(st, argv, argc);
    if (strcmp(n, "unload") == 0)    return unload_builtin(st, argv, argc);
    if (strcmp(n, "list-libs") == 0) return list_libs_builtin(st, argv, argc);

    return 127;
}
