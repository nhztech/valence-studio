#!/bin/bash

# Kunin ang absolute path ng lib folder
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ang NHZ Custom Load Function
load() {
    local lib_name="$1"     # e.g., "Typewriter"
    local as_keyword="$2"   # e.g., "as"
    local alias_name="$3"   # e.g., "tw"

    local lib_file="${LIB_DIR}/${lib_name}.sh"

    # Check kung nag-e-exist ang script file
    if [[ -f "$lib_file" ]]; then
        # 1. I-load (source) ang file sa background
        source "$lib_file"

        # 2. Check kung gumamit ng "as" na syntax ang user
        if [[ "$as_keyword" == "as" && -n "$alias_name" ]]; then

            # 3. Dynamic Wrapper Logic
            eval "${alias_name}() { ${lib_name} \"\$@\"; }"

        fi
    else
        echo -e "\033[1;31mError: NHZ Library '${lib_name}.sh' not found in ${LIB_DIR}\033[0m"
        exit 1
    fi
}
