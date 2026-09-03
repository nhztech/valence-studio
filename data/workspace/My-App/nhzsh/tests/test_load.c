/* nhzsh — Part 2 Phase 7 gate: the `load` builtin (§5.2 stage 7).
 *
 * Build plan: "load a trivial test library twice (confirm second load is a
 * no-op), then unload it and confirm it's gone from list-libs."
 */
#include "../src/executor.h"
#include "../src/load.h"
#include "../src/state.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int passed = 0, failed = 0;

static void check(const char *name, int cond, const char *detail) {
    if (cond) { passed++; printf("  PASS  %s\n", name); }
    else { failed++; printf("  FAIL  %s -> %s\n", name, detail ? detail : ""); }
}

static char *run_capture(shell_state *st, const char *line) {
    char tmpl[] = "/tmp/nhzsh_lcap_XXXXXX";
    int fd = mkstemp(tmpl);
    int saved = dup(STDOUT_FILENO);
    fflush(stdout);
    dup2(fd, STDOUT_FILENO);
    executor_run_line(st, line);
    fflush(stdout);
    dup2(saved, STDOUT_FILENO);
    close(saved);
    lseek(fd, 0, SEEK_SET);
    static char buf[16384];
    ssize_t n = read(fd, buf, sizeof buf - 1);
    buf[n > 0 ? n : 0] = '\0';
    close(fd);
    unlink(tmpl);
    return buf;
}

int main(void) {
    printf("=== Part 2 / Phase 7 — load / unload / list-libs (§5.2 stage 7) ===\n");

    char tmpl[] = "/tmp/nhzsh_libtest_XXXXXX";
    char *root = mkdtemp(tmpl);
    if (!root) { printf("mkdtemp failed\n"); return 1; }

    char libdir[512];
    snprintf(libdir, sizeof libdir, "%s/lib", root);
    mkdir(libdir, 0755);

    /* A trivial library. The side effect (LOADCOUNT) is how we detect whether
     * a second `load` actually re-ran it. */
    char libpath[640];
    snprintf(libpath, sizeof libpath, "%s/greet.sh", libdir);
    FILE *f = fopen(libpath, "w");
    fprintf(f,
            "export GREET_LOADED=yes\n"
            "export LOADCOUNT=${LOADCOUNT}x\n");
    fclose(f);

    shell_state st;
    state_init(&st);
    st.interactive = 0;
    lib_table_reset();

    /* Library resolution is relative to cwd, so anchor it. */
    state_set_cwd(&st, root);
    state_set_var(&st, "LOADCOUNT", "", 1);

    printf("first load\n");
    {
        char *out = run_capture(&st, "load greet");
        check("load succeeds silently", strstr(out, "not found") == NULL, out);
        check("library body executed", 
              st.last_status == 0 && state_get_var(&st, "GREET_LOADED") != NULL, "not set");
        check("registered in the table", lib_is_loaded("greet") == 1, "not registered");
        check("exactly one library loaded", lib_count() == 1, "wrong count");
        const char *lc = state_get_var(&st, "LOADCOUNT");
        check("body ran exactly once", lc && strcmp(lc, "x") == 0, lc ? lc : "(null)");
    }

    printf("second load is a NO-OP\n");
    {
        run_capture(&st, "load greet");
        check("still one entry", lib_count() == 1, "duplicated");
        /* The decisive check: if the body re-ran, LOADCOUNT would be "xx". */
        const char *lc = state_get_var(&st, "LOADCOUNT");
        check("body did NOT run a second time", lc && strcmp(lc, "x") == 0, lc ? lc : "(null)");
    }

    printf("list-libs\n");
    {
        char *out = run_capture(&st, "list-libs");
        check("library appears in list-libs", strstr(out, "greet") != NULL, out);
    }

    printf("load ... as <alias>\n");
    {
        char aliaspath[640];
        snprintf(aliaspath, sizeof aliaspath, "%s/math.sh", libdir);
        FILE *m = fopen(aliaspath, "w");
        fprintf(m, "export MATH_LOADED=1\n");
        fclose(m);

        run_capture(&st, "load math as m");
        check("aliased library loaded", lib_is_loaded("math") == 1, "not loaded");
        const char *a = state_get_alias(&st, "m");
        check("alias forwards to <name>_main", a && strcmp(a, "math_main") == 0, a ? a : "(null)");
    }

    printf("unload\n");
    {
        run_capture(&st, "unload greet");
        check("gone from the table", lib_is_loaded("greet") == 0, "still loaded");
        char *out = run_capture(&st, "list-libs");
        check("gone from list-libs", strstr(out, "greet") == NULL, out);
        check("other library untouched", lib_is_loaded("math") == 1, "wrongly removed");
    }

    printf("error handling\n");
    {
        char *out = run_capture(&st, "load nosuchlibrary");
        (void) out;
        check("missing library reports failure", st.last_status != 0, "silently succeeded");
        check("not registered after a failed load", lib_is_loaded("nosuchlibrary") == 0, "registered");

        run_capture(&st, "unload neverloaded");
        check("unloading an unloaded lib fails", st.last_status != 0, "silently succeeded");
    }

    printf("reload after unload works\n");
    {
        run_capture(&st, "load greet");
        check("can be loaded again after unload", lib_is_loaded("greet") == 1, "not reloaded");
    }

    lib_table_reset();
    state_free(&st);

    /* cleanup */
    unlink(libpath);
    char p2[640];
    snprintf(p2, sizeof p2, "%s/math.sh", libdir);
    unlink(p2);
    rmdir(libdir);
    rmdir(root);

    printf("\npassed=%d failed=%d\n", passed, failed);
    if (failed) { printf("PHASE 7 GATE: FAILED\n"); return 1; }
    printf("PHASE 7 GATE: PASSED\n");
    return 0;
}
