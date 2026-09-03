/* nhzsh — Part 2 Phase 2 gate: parser tests.
 *
 * Build plan: "feed known token streams, assert the resulting AST shape is
 * correct — including at least one pipeline, one conditional chain, and one
 * redirect."
 */
#include "../src/lexer.h"
#include "../src/parser.h"

#include <stdio.h>
#include <string.h>

static int passed = 0, failed = 0;

static void check(const char *name, int cond, const char *detail) {
    if (cond) { passed++; printf("  PASS  %s\n", name); }
    else { failed++; printf("  FAIL  %s -> %s\n", name, detail ? detail : ""); }
}

static void expect(const char *input, const char *want) {
    token_list toks;
    ast tree;
    const char *err = NULL;
    char got[4096], name[512];
    snprintf(name, sizeof name, "parse: %s", input);

    if (lexer_tokenize(input, &toks, &err) != 0) { check(name, 0, "lex failed"); return; }
    if (parser_parse(&toks, &tree, &err) != 0) {
        check(name, 0, err ? err : "parse failed");
        token_list_free(&toks);
        return;
    }
    ast_render(&tree, got, sizeof got);
    check(name, strcmp(got, want) == 0, got);
    ast_free(&tree);
    token_list_free(&toks);
}

static void expect_error(const char *input, const char *why) {
    token_list toks; ast tree; const char *err = NULL;
    char name[512];
    snprintf(name, sizeof name, "reject: %s", input);
    if (lexer_tokenize(input, &toks, &err) != 0) { check(name, 1, "rejected at lex"); return; }
    int r = parser_parse(&toks, &tree, &err);
    check(name, r != 0, why);
    if (r == 0) ast_free(&tree);
    token_list_free(&toks);
}

int main(void) {
    printf("=== Part 2 / Phase 2 — parser (§5.2 stage 2) ===\n");

    printf("simple commands\n");
    expect("ls", "PIPELINE[CMD(ls)]");
    expect("ls -la /tmp", "PIPELINE[CMD(ls,-la,/tmp)]");
    expect("", "");
    expect("# just a comment", "");

    printf("pipelines\n");
    expect("a | b", "PIPELINE[CMD(a)|CMD(b)]");
    expect("cat f | grep x | wc -l", "PIPELINE[CMD(cat,f)|CMD(grep,x)|CMD(wc,-l)]");

    printf("redirects\n");
    expect("echo hi > out.txt", "PIPELINE[CMD(echo,hi >out.txt)]");
    expect("echo hi >> log", "PIPELINE[CMD(echo,hi >>log)]");
    expect("sort < in.txt", "PIPELINE[CMD(sort <in.txt)]");
    expect("sort < in.txt > out.txt", "PIPELINE[CMD(sort <in.txt >out.txt)]");
    /* Redirects bind to their own pipeline stage, not the whole pipeline. */
    expect("a > x | b > y", "PIPELINE[CMD(a >x)|CMD(b >y)]");

    printf("conditional chains\n");
    expect("a && b", "PIPELINE[CMD(a)]&& PIPELINE[CMD(b)]");
    expect("a || b", "PIPELINE[CMD(a)]|| PIPELINE[CMD(b)]");
    expect("a ; b", "PIPELINE[CMD(a)]; PIPELINE[CMD(b)]");
    expect("make && ./run || echo fail",
           "PIPELINE[CMD(make)]&& PIPELINE[CMD(./run)]|| PIPELINE[CMD(echo,fail)]");

    printf("background\n");
    expect("sleep 10 &", "PIPELINE[CMD(sleep,10)]&;");
    expect("a & b", "PIPELINE[CMD(a)]&; PIPELINE[CMD(b)]");

    printf("combined / realistic\n");
    expect("cat a | grep b > out && echo done",
           "PIPELINE[CMD(cat,a)|CMD(grep,b >out)]&& PIPELINE[CMD(echo,done)]");
    expect("cd /tmp && ls -la | head -5 ; echo end",
           "PIPELINE[CMD(cd,/tmp)]&& PIPELINE[CMD(ls,-la)|CMD(head,-5)]; PIPELINE[CMD(echo,end)]");

    printf("trailing separators are tolerated\n");
    expect("ls ;", "PIPELINE[CMD(ls)];");

    printf("quote flags survive into the AST\n");
    {
        token_list toks; ast tree; const char *err = NULL;
        lexer_tokenize("echo '$A' $B", &toks, &err);
        parser_parse(&toks, &tree, &err);
        command *c = tree.pipelines->commands;
        check("single-quote flag preserved for arg 1", c->argv_single_quoted[1] == 1, "lost");
        check("bare arg not flagged", c->argv_single_quoted[2] == 0, "wrong");
        ast_free(&tree); token_list_free(&toks);
    }

    printf("syntax errors\n");
    expect_error("echo >", "redirect without a target must fail");
    expect_error("|", "pipe with no command must fail");
    expect_error("a |", "trailing pipe must fail");
    expect_error("< ", "redirect with no target must fail");

    printf("\npassed=%d failed=%d\n", passed, failed);
    if (failed) { printf("PHASE 2 GATE: FAILED\n"); return 1; }
    printf("PHASE 2 GATE: PASSED\n");
    return 0;
}
