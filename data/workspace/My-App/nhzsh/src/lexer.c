#include "lexer.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

/* ---- dynamic token list ------------------------------------------------ */

static int list_push(token_list *l, token t) {
    if (l->count == l->cap) {
        size_t cap = l->cap ? l->cap * 2 : 16;
        token *n = realloc(l->items, cap * sizeof(token));
        if (!n) return -1;
        l->items = n;
        l->cap = cap;
    }
    l->items[l->count++] = t;
    return 0;
}

static int push_op(token_list *l, token_type type) {
    token t = { type, NULL, 0, 0 };
    return list_push(l, t);
}

/* ---- growable string --------------------------------------------------- */

typedef struct { char *buf; size_t len, cap; } sbuf;

static int sbuf_push(sbuf *s, char c) {
    if (s->len + 1 >= s->cap) {
        size_t cap = s->cap ? s->cap * 2 : 32;
        char *n = realloc(s->buf, cap);
        if (!n) return -1;
        s->buf = n;
        s->cap = cap;
    }
    s->buf[s->len++] = c;
    s->buf[s->len] = '\0';
    return 0;
}

void token_list_free(token_list *l) {
    if (!l) return;
    for (size_t i = 0; i < l->count; ++i) free(l->items[i].value);
    free(l->items);
    l->items = NULL;
    l->count = l->cap = 0;
}

const char *token_type_name(token_type t) {
    switch (t) {
        case TOK_WORD:      return "WORD";
        case TOK_PIPE:      return "PIPE";
        case TOK_REDIR_OUT: return "REDIR_OUT";
        case TOK_REDIR_APP: return "REDIR_APP";
        case TOK_REDIR_IN:  return "REDIR_IN";
        case TOK_AND_IF:    return "AND_IF";
        case TOK_OR_IF:     return "OR_IF";
        case TOK_SEMI:      return "SEMI";
        case TOK_AMP:       return "AMP";
        case TOK_EOF:       return "EOF";
    }
    return "?";
}

int lexer_tokenize(const char *input, token_list *out, const char **err) {
    memset(out, 0, sizeof(*out));
    if (err) *err = NULL;
    if (!input) return 0;

    const char *p = input;

    while (*p) {
        /* whitespace */
        if (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') { p++; continue; }

        /* comment: '#' begins one only at the start of a word, so that
         * `curl host/#anchor` and `echo a#b` keep their '#'. */
        if (*p == '#') { while (*p && *p != '\n') p++; continue; }

        /* operators, longest match first so '>' never shadows '>>' */
        if (p[0] == '&' && p[1] == '&') { if (push_op(out, TOK_AND_IF))    goto oom; p += 2; continue; }
        if (p[0] == '|' && p[1] == '|') { if (push_op(out, TOK_OR_IF))     goto oom; p += 2; continue; }
        if (p[0] == '>' && p[1] == '>') { if (push_op(out, TOK_REDIR_APP)) goto oom; p += 2; continue; }
        if (*p == '|')                  { if (push_op(out, TOK_PIPE))      goto oom; p++;    continue; }
        if (*p == '>')                  { if (push_op(out, TOK_REDIR_OUT)) goto oom; p++;    continue; }
        if (*p == '<')                  { if (push_op(out, TOK_REDIR_IN))  goto oom; p++;    continue; }
        if (*p == ';')                  { if (push_op(out, TOK_SEMI))      goto oom; p++;    continue; }
        if (*p == '&')                  { if (push_op(out, TOK_AMP))       goto oom; p++;    continue; }

        /* ---- a word ---- */
        {
            sbuf s = { NULL, 0, 0 };
            int single_q = 0, had_q = 0, only_single = 1, saw_any = 0;

            while (*p && !strchr(" \t\n\r|<>;&#", *p)) {
                if (*p == '\'') {
                    /* Single quotes are literal: NOTHING inside is special. */
                    had_q = 1; saw_any = 1;
                    p++;
                    while (*p && *p != '\'') {
                        if (sbuf_push(&s, *p++)) { free(s.buf); goto oom; }
                    }
                    if (*p != '\'') {
                        free(s.buf);
                        if (err) *err = "unterminated single quote";
                        return -1;
                    }
                    p++;
                } else if (*p == '"') {
                    /* Double quotes group, but $ and \ stay live for the
                     * expander, so we keep those bytes verbatim. */
                    had_q = 1; saw_any = 1; only_single = 0;
                    p++;
                    while (*p && *p != '"') {
                        if (*p == '\\' && p[1] &&
                            (p[1] == '"' || p[1] == '\\' || p[1] == '$' || p[1] == '`')) {
                            p++;
                            if (sbuf_push(&s, *p++)) { free(s.buf); goto oom; }
                        } else {
                            if (sbuf_push(&s, *p++)) { free(s.buf); goto oom; }
                        }
                    }
                    if (*p != '"') {
                        free(s.buf);
                        if (err) *err = "unterminated double quote";
                        return -1;
                    }
                    p++;
                } else if (p[0] == '$' && p[1] == '(') {
                    /* $(...) is ONE word regardless of the spaces inside it.
                     * Without this, `echo $(echo a b)` would be split at the
                     * space and the expander would never see a complete
                     * substitution. Nesting is tracked so $(a $(b)) works. */
                    only_single = 0; saw_any = 1;
                    if (sbuf_push(&s, *p++)) { free(s.buf); goto oom; }  /* $ */
                    if (sbuf_push(&s, *p++)) { free(s.buf); goto oom; }  /* ( */
                    int depth = 1;
                    while (*p && depth > 0) {
                        if (*p == '(') depth++;
                        else if (*p == ')') depth--;
                        if (depth == 0) { if (sbuf_push(&s, *p++)) { free(s.buf); goto oom; } break; }
                        if (sbuf_push(&s, *p++)) { free(s.buf); goto oom; }
                    }
                    if (depth > 0) {
                        free(s.buf);
                        if (err) *err = "unterminated command substitution";
                        return -1;
                    }
                } else if (*p == '\\') {
                    /* Backslash escapes the next char, including a delimiter,
                     * so `echo a\ b` is ONE word. */
                    only_single = 0; saw_any = 1;
                    p++;
                    if (*p) { if (sbuf_push(&s, *p++)) { free(s.buf); goto oom; } }
                } else {
                    only_single = 0; saw_any = 1;
                    if (sbuf_push(&s, *p++)) { free(s.buf); goto oom; }
                }
            }

            if (!saw_any) { free(s.buf); continue; }

            /* '' is a real empty word: `x=''` must not vanish. */
            if (!s.buf) {
                s.buf = calloc(1, 1);
                if (!s.buf) goto oom;
            }

            single_q = (had_q && only_single);
            token t = { TOK_WORD, s.buf, single_q, had_q };
            if (list_push(out, t)) { free(s.buf); goto oom; }
        }
    }

    if (push_op(out, TOK_EOF)) goto oom;
    return 0;

oom:
    token_list_free(out);
    if (err) *err = "out of memory";
    return -1;
}
