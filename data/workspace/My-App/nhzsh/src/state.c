#include "state.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

void state_init(shell_state *s) {
    memset(s, 0, sizeof(*s));
    s->daemon_fd = -1;
    s->last_status = 0;

    /* Inherit the real environment, all of it exported — a child process must
     * see PATH/HOME/TERM exactly as nhztermd handed them to us. */
    for (char **e = environ; e && *e; ++e) {
        const char *eq = strchr(*e, '=');
        if (!eq) continue;
        size_t n = (size_t) (eq - *e);
        char *name = malloc(n + 1);
        if (!name) continue;
        memcpy(name, *e, n);
        name[n] = '\0';
        state_set_var(s, name, eq + 1, 1);
        free(name);
    }

    char buf[4096];
    if (getcwd(buf, sizeof buf)) s->cwd = strdup(buf);
    else s->cwd = strdup("/");

    const char *sid = getenv("NHZTERM_SESSION_ID");
    if (sid) s->session_id = strdup(sid);
}

void state_free(shell_state *s) {
    var_entry *v = s->vars;
    while (v) { var_entry *n = v->next; free(v->name); free(v->value); free(v); v = n; }
    alias_entry *a = s->aliases;
    while (a) { alias_entry *n = a->next; free(a->name); free(a->value); free(a); a = n; }
    for (size_t i = 0; i < s->hist_count; ++i) free(s->history[i]);
    free(s->history);
    free(s->cwd);
    free(s->session_id);
    memset(s, 0, sizeof(*s));
    s->daemon_fd = -1;
}

static var_entry *find_var(shell_state *s, const char *name) {
    for (var_entry *v = s->vars; v; v = v->next)
        if (strcmp(v->name, name) == 0) return v;
    return NULL;
}

const char *state_get_var(shell_state *s, const char *name) {
    var_entry *v = find_var(s, name);
    return v ? v->value : NULL;
}

int state_set_var(shell_state *s, const char *name, const char *value, int exported) {
    if (!name || !*name) return -1;
    var_entry *v = find_var(s, name);
    if (v) {
        char *nv = strdup(value ? value : "");
        if (!nv) return -1;
        free(v->value);
        v->value = nv;
        /* export=0 must NOT silently un-export an already-exported var;
         * only `unset` and an explicit request may do that. */
        if (exported) v->exported = 1;
        return 0;
    }
    v = calloc(1, sizeof(var_entry));
    if (!v) return -1;
    v->name = strdup(name);
    v->value = strdup(value ? value : "");
    if (!v->name || !v->value) { free(v->name); free(v->value); free(v); return -1; }
    v->exported = exported;
    v->next = s->vars;
    s->vars = v;
    return 0;
}

int state_unset_var(shell_state *s, const char *name) {
    var_entry **pp = &s->vars;
    while (*pp) {
        if (strcmp((*pp)->name, name) == 0) {
            var_entry *dead = *pp;
            *pp = dead->next;
            free(dead->name); free(dead->value); free(dead);
            return 0;
        }
        pp = &(*pp)->next;
    }
    return -1;
}

int state_export(shell_state *s, const char *name) {
    var_entry *v = find_var(s, name);
    if (!v) return state_set_var(s, name, "", 1);
    v->exported = 1;
    return 0;
}

static alias_entry *find_alias(shell_state *s, const char *name) {
    for (alias_entry *a = s->aliases; a; a = a->next)
        if (strcmp(a->name, name) == 0) return a;
    return NULL;
}

const char *state_get_alias(shell_state *s, const char *name) {
    alias_entry *a = find_alias(s, name);
    return a ? a->value : NULL;
}

int state_set_alias(shell_state *s, const char *name, const char *value) {
    if (!name || !*name) return -1;
    alias_entry *a = find_alias(s, name);
    if (a) {
        char *nv = strdup(value ? value : "");
        if (!nv) return -1;
        free(a->value);
        a->value = nv;
        return 0;
    }
    a = calloc(1, sizeof(alias_entry));
    if (!a) return -1;
    a->name = strdup(name);
    a->value = strdup(value ? value : "");
    if (!a->name || !a->value) { free(a->name); free(a->value); free(a); return -1; }
    a->next = s->aliases;
    s->aliases = a;
    return 0;
}

int state_unset_alias(shell_state *s, const char *name) {
    alias_entry **pp = &s->aliases;
    while (*pp) {
        if (strcmp((*pp)->name, name) == 0) {
            alias_entry *dead = *pp;
            *pp = dead->next;
            free(dead->name); free(dead->value); free(dead);
            return 0;
        }
        pp = &(*pp)->next;
    }
    return -1;
}

int state_set_cwd(shell_state *s, const char *path) {
    if (chdir(path) != 0) return -1;
    char buf[4096];
    if (!getcwd(buf, sizeof buf)) return -1;
    char *n = strdup(buf);
    if (!n) return -1;
    free(s->cwd);
    s->cwd = n;
    /* PWD must track cwd or `echo $PWD` lies after a cd. */
    state_set_var(s, "PWD", buf, 1);
    return 0;
}

void state_add_history(shell_state *s, const char *line) {
    if (!line || !*line) return;
    /* Skip consecutive duplicates — history full of `ls` is useless. */
    if (s->hist_count && strcmp(s->history[s->hist_count - 1], line) == 0) return;

    if (s->hist_count == s->hist_cap) {
        size_t cap = s->hist_cap ? s->hist_cap * 2 : 64;
        char **n = realloc(s->history, cap * sizeof(char *));
        if (!n) return;
        s->history = n;
        s->hist_cap = cap;
    }
    char *copy = strdup(line);
    if (!copy) return;
    s->history[s->hist_count++] = copy;
}

char **state_build_envp(shell_state *s) {
    size_t n = 0;
    for (var_entry *v = s->vars; v; v = v->next) if (v->exported) n++;

    char **envp = calloc(n + 1, sizeof(char *));
    if (!envp) return NULL;

    size_t i = 0;
    for (var_entry *v = s->vars; v; v = v->next) {
        if (!v->exported) continue;
        size_t len = strlen(v->name) + strlen(v->value) + 2;
        char *entry = malloc(len);
        if (!entry) continue;
        snprintf(entry, len, "%s=%s", v->name, v->value);
        envp[i++] = entry;
    }
    envp[i] = NULL;
    return envp;
}

char **state_build_envp_all(shell_state *s) {
    size_t n = 0;
    for (var_entry *v = s->vars; v; v = v->next) n++;

    char **envp = calloc(n + 1, sizeof(char *));
    if (!envp) return NULL;

    size_t i = 0;
    for (var_entry *v = s->vars; v; v = v->next) {
        size_t len = strlen(v->name) + strlen(v->value) + 2;
        char *entry = malloc(len);
        if (!entry) continue;
        snprintf(entry, len, "%s=%s", v->name, v->value);
        envp[i++] = entry;
    }
    envp[i] = NULL;
    return envp;
}

void state_free_envp(char **envp) {
    if (!envp) return;
    for (char **e = envp; *e; ++e) free(*e);
    free(envp);
}
