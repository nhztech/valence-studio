/* nhzsh — Stage 1: Lexer (§5.2)
 *
 * Tokenizes raw input into words, operators, quoted strings and comments.
 * POSIX-compatible: existing .sh scripts must keep working (§2 principle 5),
 * so this invents no new syntax.
 */
#ifndef NHZSH_LEXER_H
#define NHZSH_LEXER_H

#include <stddef.h>

typedef enum {
    TOK_WORD,       /* a bare or quoted word                */
    TOK_PIPE,       /* |                                    */
    TOK_REDIR_OUT,  /* >                                    */
    TOK_REDIR_APP,  /* >>                                   */
    TOK_REDIR_IN,   /* <                                    */
    TOK_AND_IF,     /* &&                                   */
    TOK_OR_IF,      /* ||                                   */
    TOK_SEMI,       /* ;                                    */
    TOK_AMP,        /* &                                    */
    TOK_EOF
} token_type;

typedef struct {
    token_type type;
    char      *value;   /* owned; NULL for pure operators */
    /* Single-quoted text must NOT be expanded later ('$HOME' stays literal),
     * so the lexer records how each word was quoted. Losing this is the
     * classic bug where 'literal $x' wrongly expands. */
    int        single_quoted;
    int        had_quotes;
} token;

typedef struct {
    token  *items;
    size_t  count;
    size_t  cap;
} token_list;

/* Tokenizes `input`. Returns 0 on success, -1 on error (unterminated quote).
 * On error, *err is set to a static description. */
int  lexer_tokenize(const char *input, token_list *out, const char **err);
void token_list_free(token_list *list);
const char *token_type_name(token_type t);

#endif
