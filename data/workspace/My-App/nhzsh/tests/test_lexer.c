/* nhzsh — Part 2 Phase 1 gate: lexer tests.
 *
 * The build plan requires: "feed it a handful of hand-written command strings
 * (including quoted args, pipes, multiple operators) and assert the token
 * stream matches expected output."
 */
#include "../src/lexer.h"

#include <stdio.h>
#include <string.h>

static int passed = 0, failed = 0;

static void check(const char *name, int cond, const char *detail) {
    if (cond) { passed++; printf("  PASS  %s\n", name); }
    else { failed++; printf("  FAIL  %s -> %s\n", name, detail ? detail : ""); }
}

/* Renders a token stream as "WORD(ls) PIPE WORD(wc) EOF" for easy asserting. */
static void render(token_list *l, char *out, size_t cap) {
    out[0] = '\0';
    for (size_t i = 0; i < l->count; ++i) {
        char part[512];
        if (l->items[i].type == TOK_WORD)
            snprintf(part, sizeof part, "%sWORD(%s)", i ? " " : "", l->items[i].value);
        else
            snprintf(part, sizeof part, "%s%s", i ? " " : "", token_type_name(l->items[i].type));
        strncat(out, part, cap - strlen(out) - 1);
    }
}

static void expect(const char *input, const char *want) {
    token_list l;
    const char *err = NULL;
    char got[2048];
    char name[512];
    snprintf(name, sizeof name, "lex: %s", input);

    if (lexer_tokenize(input, &l, &err) != 0) {
        check(name, 0, err ? err : "tokenize failed");
        return;
    }
    render(&l, got, sizeof got);
    check(name, strcmp(got, want) == 0, got);
    token_list_free(&l);
}

static void expect_error(const char *input, const char *why) {
    token_list l;
    const char *err = NULL;
    char name[512];
    snprintf(name, sizeof name, "reject: %s", input);
    int r = lexer_tokenize(input, &l, &err);
    check(name, r != 0, why);
    if (r == 0) token_list_free(&l);
}

int main(void) {
    printf("=== Part 2 / Phase 1 — lexer (§5.2 stage 1) ===\n");

    printf("simple words\n");
    expect("ls", "WORD(ls) EOF");
    expect("ls -la /tmp", "WORD(ls) WORD(-la) WORD(/tmp) EOF");
    expect("   ls    -la   ", "WORD(ls) WORD(-la) EOF");
    expect("", "EOF");
    expect("\t\n  ", "EOF");

    printf("operators\n");
    expect("a | b", "WORD(a) PIPE WORD(b) EOF");
    expect("a > b", "WORD(a) REDIR_OUT WORD(b) EOF");
    expect("a >> b", "WORD(a) REDIR_APP WORD(b) EOF");
    expect("a < b", "WORD(a) REDIR_IN WORD(b) EOF");
    expect("a && b", "WORD(a) AND_IF WORD(b) EOF");
    expect("a || b", "WORD(a) OR_IF WORD(b) EOF");
    expect("a ; b", "WORD(a) SEMI WORD(b) EOF");
    expect("a &", "WORD(a) AMP EOF");

    printf("operators without surrounding spaces\n");
    /* Real scripts are written `ls|wc`, not `ls | wc`. */
    expect("ls|wc", "WORD(ls) PIPE WORD(wc) EOF");
    expect("echo hi>out.txt", "WORD(echo) WORD(hi) REDIR_OUT WORD(out.txt) EOF");
    expect("a>>b", "WORD(a) REDIR_APP WORD(b) EOF");
    /* >> must win over >; getting this wrong silently truncates the user's file. */
    expect("a>>b>c", "WORD(a) REDIR_APP WORD(b) REDIR_OUT WORD(c) EOF");
    expect("a&&b||c", "WORD(a) AND_IF WORD(b) OR_IF WORD(c) EOF");

    printf("quoting\n");
    expect("echo 'hello world'", "WORD(echo) WORD(hello world) EOF");
    expect("echo \"hello world\"", "WORD(echo) WORD(hello world) EOF");
    expect("echo 'a|b'", "WORD(echo) WORD(a|b) EOF");
    expect("echo \"a && b\"", "WORD(echo) WORD(a && b) EOF");
    expect("echo ''", "WORD(echo) WORD() EOF");
    /* Adjacent quoting concatenates into one word, as POSIX requires. */
    expect("echo a'b'c", "WORD(echo) WORD(abc) EOF");
    expect("echo \"a\"'b'", "WORD(echo) WORD(ab) EOF");
    /* $ survives quoting so the EXPANDER can decide (stage 3). */
    expect("echo \"$HOME\"", "WORD(echo) WORD($HOME) EOF");
    expect("echo '$HOME'", "WORD(echo) WORD($HOME) EOF");

    printf("escapes\n");
    expect("echo a\\ b", "WORD(echo) WORD(a b) EOF");
    expect("echo \\|", "WORD(echo) WORD(|) EOF");
    expect("echo \"a\\\"b\"", "WORD(echo) WORD(a\"b) EOF");

    printf("comments\n");
    expect("ls # this is a comment", "WORD(ls) EOF");
    expect("# whole line", "EOF");
    expect("ls -la  #trailing", "WORD(ls) WORD(-la) EOF");
    /* A '#' inside quotes is data, not a comment. */
    expect("echo '#notacomment'", "WORD(echo) WORD(#notacomment) EOF");

    printf("realistic pipelines\n");
    expect("cat file.txt | grep -i error | wc -l",
           "WORD(cat) WORD(file.txt) PIPE WORD(grep) WORD(-i) WORD(error) PIPE WORD(wc) WORD(-l) EOF");
    expect("make && ./run || echo 'build failed'",
           "WORD(make) AND_IF WORD(./run) OR_IF WORD(echo) WORD(build failed) EOF");
    expect("sort < in.txt > out.txt",
           "WORD(sort) REDIR_IN WORD(in.txt) REDIR_OUT WORD(out.txt) EOF");
    expect("gradlew assembleDebug > build.log 2>&1 &",
           "WORD(gradlew) WORD(assembleDebug) REDIR_OUT WORD(build.log) WORD(2) REDIR_OUT AMP WORD(1) AMP EOF");

    printf("quote-tracking flags (needed by the expander)\n");
    {
        token_list l; const char *err = NULL;
        lexer_tokenize("echo '$A' \"$B\" $C", &l, &err);
        check("single-quoted word flagged", l.items[1].single_quoted == 1, "not flagged");
        check("double-quoted word not single", l.items[2].single_quoted == 0, "wrongly flagged");
        check("bare word not quoted", l.items[3].had_quotes == 0, "wrongly flagged");
        token_list_free(&l);
    }

    printf("malformed input\n");
    expect_error("echo 'unterminated", "unterminated single quote must fail");
    expect_error("echo \"unterminated", "unterminated double quote must fail");

    printf("\npassed=%d failed=%d\n", passed, failed);
    if (failed) { printf("PHASE 1 GATE: FAILED\n"); return 1; }
    printf("PHASE 1 GATE: PASSED\n");
    return 0;
}
