/* nhzsh — Phase 7: the `load` builtin (§5.2 stage 7)
 *
 *   load <name> [as <alias>]
 *   unload <name>
 *   list-libs
 *
 * Search path, checked in order: script-local lib/, user-level, system-level.
 * A load-tracking table makes loading the same library twice a no-op.
 */
#ifndef NHZSH_LOAD_H
#define NHZSH_LOAD_H

#include "state.h"

int load_builtin(shell_state *st, char **argv, int argc);
int unload_builtin(shell_state *st, char **argv, int argc);
int list_libs_builtin(shell_state *st, char **argv, int argc);

/* Exposed for tests. */
int  lib_is_loaded(const char *name);
int  lib_mark_loaded(const char *name, const char *path);
int  lib_unmark(const char *name);
void lib_table_reset(void);
int  lib_count(void);

#endif
