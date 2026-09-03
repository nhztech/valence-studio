#include "daemon_link.h"

#include <errno.h>
#include <stddef.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

void daemon_link_init(shell_state *st) {
    st->daemon_fd = -1;

    /* Preferred: nhztermd hands us an already-open fd. No connect, no race. */
    const char *fd_env = getenv("NHZTERM_CONTROL_FD");
    if (fd_env && *fd_env) {
        int fd = atoi(fd_env);
        if (fd > 2 && fcntl(fd, F_GETFD) != -1) {
            st->daemon_fd = fd;
            return;
        }
    }

    /* Fallback: connect to a unix socket path. */
    const char *path = getenv("NHZTERM_CONTROL_SOCKET");
    if (!path || !*path) return;

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;

    size_t len = strlen(path);
    if (len >= sizeof addr.sun_path) { close(fd); return; }

    if (path[0] == '@') {
        /* Abstract namespace: leading NUL, and the name is NOT NUL-terminated. */
        addr.sun_path[0] = '\0';
        memcpy(addr.sun_path + 1, path + 1, len - 1);
        socklen_t alen = (socklen_t) (offsetof(struct sockaddr_un, sun_path) + len);
        if (connect(fd, (struct sockaddr *) &addr, alen) != 0) { close(fd); return; }
    } else {
        memcpy(addr.sun_path, path, len);
        if (connect(fd, (struct sockaddr *) &addr, sizeof addr) != 0) { close(fd); return; }
    }

    /* Never let an inherited control fd leak into a child command. */
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    st->daemon_fd = fd;
}

/* Length-prefixed JSON, matching nhzterm-api §6.1:
 * 4-byte big-endian length + UTF-8 body. */
static void send_frame(int fd, const char *json) {
    size_t len = strlen(json);
    unsigned char hdr[4];
    hdr[0] = (unsigned char) ((len >> 24) & 0xFF);
    hdr[1] = (unsigned char) ((len >> 16) & 0xFF);
    hdr[2] = (unsigned char) ((len >> 8) & 0xFF);
    hdr[3] = (unsigned char) (len & 0xFF);

    /* Best effort only. A dead daemon must never take the shell down, and
     * MSG_NOSIGNAL/ignoring EPIPE is what stops a closed socket from killing
     * us with SIGPIPE mid-command. */
    ssize_t w = write(fd, hdr, 4);
    if (w != 4) return;
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, json + off, len - off);
        if (n <= 0) { if (errno == EINTR) continue; return; }
        off += (size_t) n;
    }
}

void daemon_link_report_foreground(shell_state *st, int pid) {
    if (st->daemon_fd < 0) return;

    char buf[256];
    const char *sid = st->session_id ? st->session_id : "";
    if (pid > 0) {
        snprintf(buf, sizeof buf,
                 "{\"type\":\"foreground_pid\",\"session_id\":\"%s\",\"pid\":%d}", sid, pid);
    } else {
        /* null, not 0 — the daemon treats null as "nothing in the foreground"
         * so a later process.kill returns PROCESS_NOT_FOUND instead of
         * killing the shell itself (§9). */
        snprintf(buf, sizeof buf,
                 "{\"type\":\"foreground_pid\",\"session_id\":\"%s\",\"pid\":null}", sid);
    }
    send_frame(st->daemon_fd, buf);
}

void daemon_link_close(shell_state *st) {
    if (st->daemon_fd >= 0) {
        close(st->daemon_fd);
        st->daemon_fd = -1;
    }
}
