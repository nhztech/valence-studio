#include "parser.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    token_list  *toks;
    size_t       pos;
    const char **err;
} pstate;

static token *peek(pstate *s) {
    if (s->pos >= s->toks->count) return NULL;
    return &s->toks->items[s->pos];
}

static token *advance(pstate *s) {
    token *t = peek(s);
    if (t) s->pos++;
    return t;
}

static int at(pstate *s, token_type type) {
    token *t = peek(s);
    return t && t->type == type;
}

static void redirect_free(redirect *r) {
    while (r) {
        redirect *n = r->next;
        free(r->target);
        free(r);
        r = n;
    }
}

static void command_free(command *c) {
    while (c) {
        command *n = c->next;
        if (c->argv) {
            for (int i = 0; i < c->argc; ++i) free(c->argv[i]);
            free(c->argv);
        }
        free(c->argv_single_quoted);
        redirect_free(c->redirects);
        free(c);
        c = n;
    }
}

void ast_free(ast *a) {
    if (!a) return;
    pipeline *p = a->pipelines;
    while (p) {
        pipeline *n = p->next;
        command_free(p->commands);
        free(p);
        p = n;
    }
    a->pipelines = NULL;
}

/* command := word+ redirect* — note redirects may also be interleaved,
 * because `>out echo hi` is legal POSIX and real scripts do use it. */
static command *parse_command(pstate *s) {
    command *c = calloc(1, sizeof(command));
    if (!c) return NULL;

    int cap = 8;
    c->argv = calloc(cap + 1, sizeof(char *));
    c->argv_single_quoted = calloc(cap + 1, sizeof(int));
    if (!c->argv || !c->argv_single_quoted) { command_free(c); return NULL; }

    redirect **rtail = &c->redirects;

    for (;;) {
        token *t = peek(s);
        if (!t) break;

        if (t->type == TOK_WORD) {
            if (c->argc == cap) {
                cap *= 2;
                char **na = realloc(c->argv, (cap + 1) * sizeof(char *));
                int   *nq = realloc(c->argv_single_quoted, (cap + 1) * sizeof(int));
                if (!na || !nq) { free(na ? na : c->argv); command_free(c); return NULL; }
                c->argv = na;
                c->argv_single_quoted = nq;
            }
            c->argv[c->argc] = strdup(t->value ? t->value : "");
            if (!c->argv[c->argc]) { command_free(c); return NULL; }
            c->argv_single_quoted[c->argc] = t->single_quoted;
            c->argc++;
            c->argv[c->argc] = NULL;
            advance(s);
            continue;
        }

        if (t->type == TOK_REDIR_OUT || t->type == TOK_REDIR_APP || t->type == TOK_REDIR_IN) {
            redir_type rt = t->type == TOK_REDIR_OUT ? REDIR_OUT
                          : t->type == TOK_REDIR_APP ? REDIR_APPEND
                          : REDIR_IN;
            advance(s);
            token *target = peek(s);
            /* A redirect with no filename is a syntax error, not a silent
             * no-op — bash says "syntax error near unexpected token". */
            if (!target || target->type != TOK_WORD) {
                if (s->err) *s->err = "syntax error: expected filename after redirection";
                command_free(c);
                return NULL;
            }
            advance(s);
            redirect *r = calloc(1, sizeof(redirect));
            if (!r) { command_free(c); return NULL; }
            r->type = rt;
            r->target = strdup(target->value ? target->value : "");
            if (!r->target) { free(r); command_free(c); return NULL; }
            *rtail = r;
            rtail = &r->next;
            continue;
        }

        break; /* operator terminates this command */
    }

    if (c->argc == 0 && c->redirects == NULL) {
        command_free(c);
        return NULL;
    }
    return c;
}

/* pipeline := command ('|' command)* */
static pipeline *parse_pipeline(pstate *s) {
    command *head = parse_command(s);
    if (!head) return NULL;

    command *tail = head;
    while (at(s, TOK_PIPE)) {
        advance(s);
        command *next = parse_command(s);
        if (!next) {
            if (s->err && !*s->err) *s->err = "syntax error: expected command after '|'";
            command_free(head);
            return NULL;
        }
        tail->next = next;
        tail = next;
    }

    pipeline *p = calloc(1, sizeof(pipeline));
    if (!p) { command_free(head); return NULL; }
    p->commands = head;
    p->link = LINK_NONE;
    return p;
}

int parser_parse(token_list *tokens, ast *out, const char **err) {
    memset(out, 0, sizeof(*out));
    if (err) *err = NULL;

    pstate s = { tokens, 0, err };
    pipeline **tail = &out->pipelines;

    /* An empty line is valid and produces an empty AST. */
    if (at(&s, TOK_EOF) || !peek(&s)) return 0;

    for (;;) {
        if (at(&s, TOK_EOF)) break;

        pipeline *p = parse_pipeline(&s);
        if (!p) {
            if (err && !*err) *err = "syntax error: expected command";
            ast_free(out);
            return -1;
        }

        /* '&' backgrounds the pipeline just parsed. */
        if (at(&s, TOK_AMP)) {
            advance(&s);
            p->background = 1;
            p->link = LINK_SEQ;
        }

        if (at(&s, TOK_AND_IF))      { advance(&s); p->link = LINK_AND; }
        else if (at(&s, TOK_OR_IF))  { advance(&s); p->link = LINK_OR;  }
        else if (at(&s, TOK_SEMI))   { advance(&s); p->link = LINK_SEQ; }

        *tail = p;
        tail = &p->next;

        if (at(&s, TOK_EOF) || !peek(&s)) break;
    }

    return 0;
}

/* ---- rendering (tests) -------------------------------------------------- */

static void appendf(char *out, size_t cap, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    size_t len = strlen(out);
    if (len < cap) vsnprintf(out + len, cap - len, fmt, ap);
    va_end(ap);
}

void ast_render(const ast *a, char *out, size_t cap) {
    out[0] = '\0';
    int first_p = 1;
    for (pipeline *p = a->pipelines; p; p = p->next) {
        if (!first_p) appendf(out, cap, " ");
        first_p = 0;
        appendf(out, cap, "PIPELINE[");
        int first_c = 1;
        for (command *c = p->commands; c; c = c->next) {
            if (!first_c) appendf(out, cap, "|");
            first_c = 0;
            appendf(out, cap, "CMD(");
            for (int i = 0; i < c->argc; ++i)
                appendf(out, cap, "%s%s", i ? "," : "", c->argv[i]);
            for (redirect *r = c->redirects; r; r = r->next) {
                const char *sym = r->type == REDIR_OUT ? ">" : r->type == REDIR_APPEND ? ">>" : "<";
                appendf(out, cap, " %s%s", sym, r->target);
            }
            appendf(out, cap, ")");
        }
        appendf(out, cap, "]");
        if (p->background) appendf(out, cap, "&");
        if (p->link == LINK_AND)      appendf(out, cap, "&&");
        else if (p->link == LINK_OR)  appendf(out, cap, "||");
        else if (p->link == LINK_SEQ) appendf(out, cap, ";");
    }
}
