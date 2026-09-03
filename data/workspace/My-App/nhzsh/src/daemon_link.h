/* nhzsh — Stage 6: Daemon integration hooks (§5.2, §9)
 *
 * Because nhzsh is custom-built, it SELF-REPORTS which pid is in the
 * foreground. That is what makes the UI's "Kill Process" able to kill the
 * running command without killing the session's shell — determining this from
 * outside would otherwise need tcgetpgrp() against the PTY master.
 *
 * Fire-and-forget by design: the shell must never block or fail because the
 * daemon is slow or absent.
 */
#ifndef NHZSH_DAEMON_LINK_H
#define NHZSH_DAEMON_LINK_H

#include "state.h"

/* Opens the control side-channel. Honours NHZTERM_CONTROL_FD (a pre-opened
 * descriptor) first, else NHZTERM_CONTROL_SOCKET (a unix socket path).
 * Silently no-ops when neither is set, so nhzsh runs standalone. */
void daemon_link_init(shell_state *st);

/* Reports the new foreground pid, or pid<=0 for "nothing running". */
void daemon_link_report_foreground(shell_state *st, int pid);

void daemon_link_close(shell_state *st);

#endif
