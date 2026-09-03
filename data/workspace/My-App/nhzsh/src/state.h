/* nhzsh — Stage 5: State (§5.2)
 *
 * Persists cwd, environment variables, aliases and history across the life of
 * the session. The shell process is long-lived inside its PTY, so this is
 * per-session state, not per-line.
 */
#ifndef NHZSH_STATE_H
#define NHZSH_STATE_H

#include <stddef.h>

typedef struct var_entry {
    char             *name;
    char             *value;
    int               exported;   /* passed to children via environ */
    struct var_entry *next;
} var_entry;

typedef struct alias_entry {
    char               *name;
    char               *value;
    struct alias_entry *next;
} alias_entry;

typedef struct {
    var_entry   *vars;
    alias_entry *aliases;

    char       **history;
    size_t       hist_count, hist_cap;

    char        *cwd;
    int          last_status;   /* $? */
    int          should_exit;
    int          exit_code;
    int          interactive;   /* prompt only when attached to a tty */

    /* §9 daemon link: fd of the control side-channel, or -1. */
    int          daemon_fd;
    char        *session_id;
} shell_state;

void  state_init(shell_state *s);
void  state_free(shell_state *s);

const char *state_get_var(shell_state *s, const char *name);
int   state_set_var(shell_state *s, const char *name, const char *value, int exported);
int   state_unset_var(shell_state *s, const char *name);
int   state_export(shell_state *s, const char *name);

const char *state_get_alias(shell_state *s, const char *name);
int   state_set_alias(shell_state *s, const char *name, const char *value);
int   state_unset_alias(shell_state *s, const char *name);

int   state_set_cwd(shell_state *s, const char *path);
void  state_add_history(shell_state *s, const char *line);

/* Builds a NULL-terminated envp[] of exported vars. Caller frees with
 * state_free_envp(). */
char **state_build_envp(shell_state *s);
/* Like state_build_envp but includes NON-exported vars too. Used for command
 * substitution, where a subshell inherits all shell variables (POSIX). */
char **state_build_envp_all(shell_state *s);
void   state_free_envp(char **envp);

#endif
