/* nhzsh — Stage 2: Parser (§5.2)
 *
 * Grammar (simplified EBNF, exactly as specified):
 *   command_list := pipeline (( '&&' | '||' | ';' ) pipeline)*
 *   pipeline     := command ('|' command)*
 *   command      := word+ redirect*
 *   redirect     := ('>' | '>>' | '<') word
 */
#ifndef NHZSH_PARSER_H
#define NHZSH_PARSER_H

#include "lexer.h"

typedef enum { REDIR_OUT, REDIR_APPEND, REDIR_IN } redir_type;

typedef struct redirect {
    redir_type       type;
    char            *target;   /* owned */
    struct redirect *next;
} redirect;

typedef struct command {
    char          **argv;        /* owned, NULL-terminated */
    int             argc;
    /* Parallel to argv: 1 if that word was single-quoted and must not be
     * expanded. The expander needs this; dropping it breaks 'literal $x'. */
    int            *argv_single_quoted;
    redirect       *redirects;   /* owned list */
    struct command *next;        /* next stage in the pipeline */
} command;

typedef enum { LINK_NONE, LINK_AND, LINK_OR, LINK_SEQ } link_type;

typedef struct pipeline {
    command         *commands;   /* owned; linked by ->next */
    int              background; /* trailing '&' */
    link_type        link;       /* how the NEXT pipeline is joined */
    struct pipeline *next;
} pipeline;

typedef struct {
    pipeline *pipelines;
} ast;

/* Parses a token list. Returns 0 on success, -1 on syntax error (*err set). */
int  parser_parse(token_list *tokens, ast *out, const char **err);
void ast_free(ast *a);

/* Renders the AST as a stable one-line string, for tests. */
void ast_render(const ast *a, char *out, size_t cap);

#endif
