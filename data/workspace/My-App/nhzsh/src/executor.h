/* nhzsh — Stage 4: Executor (§5.2)
 *
 * Builtins run in-process; everything else is fork() + exec() with
 * stdin/stdout/stderr wired per pipeline stage. Exit code tracked in $?.
 */
#ifndef NHZSH_EXECUTOR_H
#define NHZSH_EXECUTOR_H

#include "parser.h"
#include "state.h"

/* Executes a whole parsed line, honouring && || ; and backgrounding.
 * Returns the status of the last command run. */
int executor_run_ast(shell_state *st, ast *tree);

/* Lex + parse + execute one line. */
int executor_run_line(shell_state *st, const char *line);

/* Runs a script file top to bottom. */
int executor_run_script(shell_state *st, const char *path);

#endif
