/* nhzsh — Stage 3: Expander (§5.2)
 *
 * Resolves, in this order:
 *   1. variable expansion      $VAR, ${VAR}, $?, $$
 *   2. command substitution    $(...)
 *   3. glob expansion          *.txt, ?
 *   4. tilde expansion         ~
 */
#ifndef NHZSH_EXPANDER_H
#define NHZSH_EXPANDER_H

#include "state.h"

typedef struct {
    char **items;
    int    count;
    int    cap;
} word_list;

void word_list_init(word_list *w);
int  word_list_push(word_list *w, const char *s);
void word_list_free(word_list *w);

/* Expands one word into zero or more words (a glob may yield many, an unset
 * variable may yield none). `single_quoted` suppresses all expansion. */
int expander_expand_word(shell_state *st, const char *word, int single_quoted, word_list *out);

/* Convenience: expands a whole argv. */
int expander_expand_argv(shell_state *st, char **argv, int argc,
                         const int *single_quoted, word_list *out);

#endif
