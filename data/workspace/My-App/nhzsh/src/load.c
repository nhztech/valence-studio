#include "load.h"
#include "executor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* ---- load-tracking table ------------------------------------------------ */

typedef struct lib_entry {
    char             *name;
    char             *path;
    struct lib_entry *next;
} lib_entry;

static lib_entry *g_libs = NULL;

int lib_is_loaded(const char *name) {
    for (lib_entry *l = g_libs; l; l = l->next)
        if (strcmp(l->name, name) == 0) return 1;
    return 0;
}

int lib_mark_loaded(const char *name, const char *path) {
    if (lib_is_loaded(name)) return 0;
    lib_entry *l = calloc(1, sizeof(lib_entry));
    if (!l) return -1;
    l->name = strdup(name);
    l->path = strdup(path ? path : "");
    if (!l->name || !l->path) { free(l->name); free(l->path); free(l); return -1; }
    l->next = g_libs;
    g_libs = l;
    return 0;
}

int lib_unmark(const char *name) {
    lib_entry **pp = &g_libs;
    while (*pp) {
        if (strcmp((*pp)->name, name) == 0) {
            lib_entry *dead = *pp;
            *pp = dead->next;
            free(dead->name); free(dead->path); free(dead);
            return 0;
        }
        pp = &(*pp)->next;
    }
    return -1;
}

void lib_table_reset(void) {
    while (g_libs) {
        lib_entry *n = g_libs->next;
        free(g_libs->name); free(g_libs->path); free(g_libs);
        g_libs = n;
    }
}

int lib_count(void) {
    int n = 0;
    for (lib_entry *l = g_libs; l; l = l->next) n++;
    return n;
}

/* ---- search path -------------------------------------------------------- */

/* Resolves a library name to a readable file, checking, in order:
 *   1. script-local ./lib/
 *   2. user-level   $HOME/.nhzsh/lib/
 *   3. system-level $NHZSH_LIBDIR, then /etc/nhzsh/lib/
 * Caller frees. */
static char *resolve_lib(shell_state *st, const char *name) {
    char buf[4096];
    const char *home = state_get_var(st, "HOME");
    const char *sysdir = state_get_var(st, "NHZSH_LIBDIR");

    const char *bases[4];
    char localbuf[4096], homebuf[4096];
    int n = 0;

    snprintf(localbuf, sizeof localbuf, "%s/lib", st->cwd ? st->cwd : ".");
    bases[n++] = localbuf;
    if (home && *home) {
        snprintf(homebuf, sizeof homebuf, "%s/.nhzsh/lib", home);
        bases[n++] = homebuf;
    }
    if (sysdir && *sysdir) bases[n++] = sysdir;
    bases[n++] = "/etc/nhzsh/lib";

    for (int i = 0; i < n; ++i) {
        /* Accept both `foo` and `foo.sh`, so `load math` finds math.sh. */
        snprintf(buf, sizeof buf, "%s/%s", bases[i], name);
        if (access(buf, R_OK) == 0) return strdup(buf);
        snprintf(buf, sizeof buf, "%s/%s.sh", bases[i], name);
        if (access(buf, R_OK) == 0) return strdup(buf);
    }
    return NULL;
}

/* ---- builtins ----------------------------------------------------------- */

int load_builtin(shell_state *st, char **argv, int argc) {
    if (argc < 2) {
        fprintf(stderr, "load: usage: load <name> [as <alias>]\n");
        return 1;
    }

    const char *name = argv[1];
    const char *alias = NULL;
    if (argc >= 4 && strcmp(argv[2], "as") == 0) alias = argv[3];

    /* Loading twice is an explicit no-op, so a library can safely `load` its
     * own dependencies without callers tracking what is already in. */
    if (lib_is_loaded(name)) return 0;

    char *path = resolve_lib(st, name);
    if (!path) {
        fprintf(stderr, "load: %s: library not found\n", name);
        return 1;
    }

    int rc = executor_run_script(st, path);

    if (rc == 0) {
        lib_mark_loaded(name, path);
        /* `as` generates a wrapper forwarding to the library's main function. */
        if (alias) {
            char target[512];
            snprintf(target, sizeof target, "%s_main", name);
            state_set_alias(st, alias, target);
        }
    }
    free(path);
    return rc;
}

int unload_builtin(shell_state *st, char **argv, int argc) {
    (void) st;
    if (argc < 2) {
        fprintf(stderr, "unload: usage: unload <name>\n");
        return 1;
    }
    if (lib_unmark(argv[1]) != 0) {
        fprintf(stderr, "unload: %s: not loaded\n", argv[1]);
        return 1;
    }
    return 0;
}

int list_libs_builtin(shell_state *st, char **argv, int argc) {
    (void) st; (void) argv; (void) argc;
    for (lib_entry *l = g_libs; l; l = l->next)
        printf("%s\t%s\n", l->name, l->path);
    return 0;
}
