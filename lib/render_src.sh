#!/bin/bash

# Kukunin nito ang absolute path kung nasaan mismong nakasave ang render_src.sh
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${LIB_DIR}/separator.sh"

render_src() {
    local align_mode=""

    # BAGO: Pagsalo sa alignment flags (-ac, -ar, at sinama na rin ang lumang -c)
    if [[ "$1" == "-ac" || "$1" == "-c" ]]; then
        align_mode="center"
        shift
    elif [[ "$1" == "-ar" ]]; then
        align_mode="right"
        shift
    fi

    local raw_text="$1"
    local duration="${2:-0.025}"
    local global_padding=0

    # Kung may alignment, kalkulahin ang max width ng buong logo muna!
    if [[ -n "$align_mode" ]]; then
        local max_len=0

        # 1. Hanapin ang pinakamahabang linya (Max Length)
        while IFS= read -r line; do
            local clean_line=$(echo -e "$line" | sed "s/$(printf '\033')\[[0-9;]*m//g")
            if [[ ${#clean_line} -gt $max_len ]]; then
                max_len=${#clean_line}
            fi
        done <<< "$raw_text"

        # 2. Kunin ang terminal width
        local term_width=$(stty size < /dev/tty 2>/dev/null | awk '{print $2}')
        if [[ -z "$term_width" ]]; then term_width=80; fi

        # 3. Compute ng iisang padding para sa buong block
        if [[ "$align_mode" == "center" ]]; then
            global_padding=$(( (term_width - max_len) / 2 ))
        elif [[ "$align_mode" == "right" ]]; then
            global_padding=$(( term_width - max_len ))
        fi
    fi

    printf "\e[?25l"

    while IFS= read -r line; do
        if [[ -n "$align_mode" && $global_padding -gt 0 ]]; then
            # Gagamitin natin yung Normal Mode ni separator (e.g., separator 25)
            # Para iisang haba lang ng space ang idadagdag bago ang text!
            separator "$global_padding"
        fi

        # Saka natin i-pi-print yung may kulay na linya nang dahan-dahan!
        echo -e "$line"
        sleep "$duration"
    done <<< "$raw_text"

    printf "\e[?25h"
}
