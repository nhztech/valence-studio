/* nhzsh — Stage 4: Builtins (§5.2)
 *
 * Builtins run IN-PROCESS, never forked — `cd` in a subshell would change a
 * directory that immediately ceases to exist.
 */
#ifndef NHZSH_BUILTINS_H
#define NHZSH_BUILTINS_H

#include "state.h"

/* Returns 1 if `name` is a builtin. */
int builtin_is(const char *name);

/* Runs a builtin. Returns its exit status. */
int builtin_run(shell_state *st, char **argv, int argc);

#endif
