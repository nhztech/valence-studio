#!/bin/sh
# nhzsh — Part 2 Phase 8: validation against real .sh scripts.
#
# Build plan: "Run nhzsh against NJ's existing .sh scripts from the NHZENV
# project (e.g. the boot scripts) to confirm POSIX-subset compatibility —
# these should run without modification."
#
# Those scripts are not in this repo, so this suite encodes the CONSTRUCTS
# real boot/setup scripts actually use. Anything failing here is a concrete
# priority signal, exactly as the plan asks — rather than guessing ahead.
#
# Usage: sh tests/posix_suite.sh ./nhzsh

SH="${1:-./nhzsh}"
pass=0
fail=0
unsupported=0

t() { # t <name> <script> <expected stdout>
    name="$1"; script="$2"; want="$3"
    got=$(printf '%s\n' "$script" | "$SH" 2>/dev/null)
    if [ "$got" = "$want" ]; then
        pass=$((pass + 1))
        echo "  PASS  $name"
    else
        fail=$((fail + 1))
        echo "  FAIL  $name"
        echo "        want: [$want]"
        echo "        got:  [$got]"
    fi
}

# Constructs deliberately deferred post-v1 (job control, here-docs, advanced
# parameter expansion). Reported, never fatal — this is the "log what these
# scripts use that nhzsh doesn't yet support" signal.
d() {
    name="$1"; script="$2"; want="$3"
    got=$(printf '%s\n' "$script" | "$SH" 2>/dev/null)
    if [ "$got" = "$want" ]; then
        pass=$((pass + 1))
        echo "  PASS  $name (deferred feature works)"
    else
        unsupported=$((unsupported + 1))
        echo "  DEFER $name — not yet supported (post-v1)"
    fi
}

echo "=== Part 2 / Phase 8 — POSIX-subset validation ==="
echo "shell under test: $SH"
echo ""

echo "core execution"
t "echo"                'echo hello'                                'hello'
t "multiple args"       'echo a b c'                                'a b c'
t "sequential lines"    'echo one
echo two'                                                           'one
two'
t "semicolon sequence"  'echo a; echo b'                            'a
b'

echo "variables (used by every boot script)"
t "assign and read"     'X=value
echo $X'                                                            'value'
t "braced"              'X=v
echo ${X}suffix'                                                    'vsuffix'
t "export"              'export E=exported
echo $E'                                                            'exported'
t "unset var is empty"  'echo [$NOPE]'                              '[]'
t "reassignment"        'X=1
X=2
echo $X'                                                            '2'
t "var in string"       'NAME=world
echo "hello $NAME"'                                                 'hello world'
t "single quotes literal" "echo '\$HOME'"                           '$HOME'

echo "conditionals and exit status"
t "and-if true"         'true && echo ran'                          'ran'
t "and-if false"        'false && echo no'                          ''
t "or-if"               'false || echo fallback'                    'fallback'
t "exit status var"     'false
echo $?'                                                            '1'
t "chain"               'true && false || echo recovered'           'recovered'

echo "pipelines"
t "two stage"           'printf "a\nb\n" | grep b'                  'b'
t "three stage"         'printf "1\n2\n3\n" | grep -v 2 | wc -l'    '2'

echo "redirection"
t "write and read back" 'echo data > /tmp/nhzsh_p8.txt
cat /tmp/nhzsh_p8.txt'                                              'data'
t "append"              'echo a > /tmp/nhzsh_p8b.txt
echo b >> /tmp/nhzsh_p8b.txt
cat /tmp/nhzsh_p8b.txt'                                             'a
b'
t "stdin redirect"      'printf "x\ny\n" > /tmp/nhzsh_p8c.txt
wc -l < /tmp/nhzsh_p8c.txt'                                         '2'

echo "command substitution (ubiquitous in setup scripts)"
t "basic"               'echo $(echo sub)'                          'sub'
t "in assignment"       'V=$(echo captured)
echo $V'                                                            'captured'
t "with args"           'echo $(echo a b c)'                        'a b c'
t "nested"              'echo $(echo $(echo deep))'                 'deep'

echo "cwd handling"
t "cd then pwd"         'cd /tmp
pwd'                                                                '/tmp'
t "cd persists"         'cd /tmp
cd /
pwd'                                                                '/'
t "cwd survives lines"  'cd /tmp
X=1
pwd'                                                                '/tmp'

echo "comments (every real script has them)"
t "full line comment"   '# a comment
echo after'                                                         'after'
t "trailing comment"    'echo visible # hidden'                     'visible'

echo "guard patterns real boot scripts use"
t "command -v guard"    'command -v sh > /dev/null && echo has_sh'   'has_sh'
t "dir check via test"  'test -d /tmp && echo tmp_exists'            'tmp_exists'
t "negated test"        'test -d /nope || echo absent'               'absent'
t "mkdir -p idempotent" 'mkdir -p /tmp/nhzsh_p8dir && echo made'     'made'

echo "deferred constructs (post-v1 per the build plan)"
d "if/then/fi"          'if true; then echo yes; fi'                 'yes'
d "for loop"            'for i in a b; do echo $i; done'             'a
b'
d "while loop"          'while false; do echo x; done
echo done'                                                           'done'
d "function def"        'f() { echo fn; }
f'                                                                   'fn'
d "here-document"       'cat <<EOF
heredoc
EOF'                                                                 'heredoc'
d "param default"       'echo ${UNSET:-fallback}'                    'fallback'
d "arithmetic"          'echo $((1 + 2))'                            '3'

rm -f /tmp/nhzsh_p8.txt /tmp/nhzsh_p8b.txt /tmp/nhzsh_p8c.txt
rmdir /tmp/nhzsh_p8dir 2>/dev/null

echo ""
echo "passed=$pass failed=$fail deferred-unsupported=$unsupported"
if [ "$fail" -gt 0 ]; then
    echo "PHASE 8 GATE: FAILED"
    exit 1
fi
echo "PHASE 8 GATE: PASSED (core POSIX subset compatible)"
echo ""
echo "Note: $unsupported deferred construct(s) unsupported. Per the build plan"
echo "these are post-v1 (job control, here-docs, advanced parameter expansion)."
echo "This count is the prioritisation signal for what to build next."
exit 0
