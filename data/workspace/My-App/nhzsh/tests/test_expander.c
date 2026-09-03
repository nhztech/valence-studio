/* nhzsh — Part 2 Phase 3 gate: expander tests.
 *
 * Build plan: "Each expansion type gets its own test case, run independently
 * of the others first, then one combined test exercising all four in a single
 * command line."
 */
#include "../src/expander.h"
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

static void join(word_list *w, char *out, size_t cap) {
    out[0] = '\0';
    for (int i = 0; i < w->count; ++i) {
        if (i) strncat(out, "|", cap - strlen(out) - 1);
        strncat(out, w->items[i], cap - strlen(out) - 1);
    }
}

static void expect(shell_state *st, const char *word, int sq, const char *want) {
    word_list w; word_list_init(&w);
    char got[4096], name[512];
    snprintf(name, sizeof name, "expand: %s", word);
    expander_expand_word(st, word, sq, &w);
    join(&w, got, sizeof got);
    check(name, strcmp(got, want) == 0, got);
    word_list_free(&w);
}

int main(void) {
    printf("=== Part 2 / Phase 3 — expander (§5.2 stage 3) ===\n");

    shell_state st;
    state_init(&st);
    state_set_var(&st, "NAME", "world", 0);
    state_set_var(&st, "EMPTY", "", 0);
    state_set_var(&st, "PATHISH", "/usr/local", 0);
    state_set_var(&st, "HOME", "/home/testuser", 1);
    st.last_status = 42;

    printf("1. variable expansion (independent)\n");
    expect(&st, "$NAME", 0, "world");
    expect(&st, "${NAME}", 0, "world");
    expect(&st, "hello $NAME", 0, "hello world");
    expect(&st, "${NAME}s", 0, "worlds");
    /* Without braces the parser must stop at the first non-name char. */
    expect(&st, "$NAME-suffix", 0, "world-suffix");
    expect(&st, "$EMPTY", 0, "");
    /* An UNSET variable expands to empty, not to its own name. */
    expect(&st, "$NOSUCHVAR", 0, "");
    expect(&st, "a${NOSUCHVAR}b", 0, "ab");
    expect(&st, "$?", 0, "42");
    expect(&st, "literal", 0, "literal");
    expect(&st, "100$", 0, "100$");
    expect(&st, "$PATHISH/bin", 0, "/usr/local/bin");

    printf("2. command substitution (independent)\n");
    expect(&st, "$(echo hi)", 0, "hi");
    expect(&st, "pre$(echo mid)post", 0, "premidpost");
    /* Trailing newlines MUST be stripped or every path built this way breaks. */
    expect(&st, "$(printf 'x\\n\\n\\n')", 0, "x");
    expect(&st, "$(echo $NAME)", 0, "world");
    expect(&st, "$(true)", 0, "");

    printf("3. glob expansion (independent)\n");
    {
        char tmpl[] = "/tmp/nhzsh_glob_XXXXXX";
        char *dir = mkdtemp(tmpl);
        if (dir) {
            char p[512];
            const char *files[] = { "a.txt", "b.txt", "c.log" };
            for (int i = 0; i < 3; ++i) {
                snprintf(p, sizeof p, "%s/%s", dir, files[i]);
                FILE *f = fopen(p, "w"); if (f) fclose(f);
            }
            char pat[512], want[1024];
            snprintf(pat, sizeof pat, "%s/*.txt", dir);
            snprintf(want, sizeof want, "%s/a.txt|%s/b.txt", dir, dir);
            expect(&st, pat, 0, want);

            snprintf(pat, sizeof pat, "%s/*.log", dir);
            snprintf(want, sizeof want, "%s/c.log", dir);
            expect(&st, pat, 0, want);

            snprintf(pat, sizeof pat, "%s/?.log", dir);
            expect(&st, pat, 0, want);

            /* No match => the pattern stays literal, so `rm *.none` does not
             * silently become `rm`. */
            snprintf(pat, sizeof pat, "%s/*.nomatch", dir);
            expect(&st, pat, 0, pat);

            for (int i = 0; i < 3; ++i) {
                snprintf(p, sizeof p, "%s/%s", dir, files[i]);
                unlink(p);
            }
            rmdir(dir);
        }
    }

    printf("4. tilde expansion (independent)\n");
    expect(&st, "~", 0, "/home/testuser");
    expect(&st, "~/docs", 0, "/home/testuser/docs");
    /* Only a LEADING tilde expands; backup files and mid-word ~ are literal. */
    expect(&st, "file~", 0, "file~");
    expect(&st, "a~b", 0, "a~b");
    expect(&st, "~notauser", 0, "~notauser");

    printf("5. single quotes suppress everything\n");
    expect(&st, "$NAME", 1, "$NAME");
    expect(&st, "~", 1, "~");
    expect(&st, "$(echo hi)", 1, "$(echo hi)");
    expect(&st, "*.txt", 1, "*.txt");

    printf("6. COMBINED — all four in one word\n");
    {
        char tmpl[] = "/tmp/nhzsh_comb_XXXXXX";
        char *dir = mkdtemp(tmpl);
        if (dir) {
            char p[512];
            snprintf(p, sizeof p, "%s/target.txt", dir);
            FILE *f = fopen(p, "w"); if (f) fclose(f);

            state_set_var(&st, "HOME", dir, 1);
            state_set_var(&st, "EXT", "txt", 0);

            /* tilde + variable + command substitution + glob, one word. */
            char want[1024];
            snprintf(want, sizeof want, "%s/target.txt", dir);
            expect(&st, "~/$(echo target).*${EXT}", 0, want);

            state_set_var(&st, "HOME", "/home/testuser", 1);
            unlink(p);
            rmdir(dir);
        }
    }

    printf("7. argv-level expansion\n");
    {
        char *argv[] = { (char *) "echo", (char *) "$NAME", (char *) "$(echo two)" };
        int   sq[]   = { 0, 0, 0 };
        word_list w; word_list_init(&w);
        expander_expand_argv(&st, argv, 3, sq, &w);
        char got[1024]; join(&w, got, sizeof got);
        check("full argv expanded", strcmp(got, "echo|world|two") == 0, got);
        word_list_free(&w);
    }

    state_free(&st);

    printf("\npassed=%d failed=%d\n", passed, failed);
    if (failed) { printf("PHASE 3 GATE: FAILED\n"); return 1; }
    printf("PHASE 3 GATE: PASSED\n");
    return 0;
}
