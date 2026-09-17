#!/bin/bash
# lib/separator.sh

# Private math helper para sa alignment
_calc_padding() {
    local mode="$1"
    local raw_text="$2"
    # Linisin ang mga ANSI colors para accurate ang bilang ng characters
    local clean_line=$(echo -e "$raw_text" | sed "s/$(printf '\033')\[[0-9;]*m//g")
    
    # Kunin ang terminal width nang ligtas sa "ioctl" error
    local term_width=$(stty size < /dev/tty 2>/dev/null | awk '{print $2}')
    if [[ -z "$term_width" ]]; then term_width=80; fi # Fallback kung sakali
    
    local text_len=${#clean_line}
    local padding=0
    
    # Heto na yung logic mo!
    if [[ "$mode" == "center" ]]; then
        padding=$(( (term_width - text_len) / 2 ))
    elif [[ "$mode" == "right" ]]; then
        padding=$(( term_width - text_len ))
    fi
    
    echo "$padding"
}

# Ang mismong pampublikong function
separator() {
    # -- NORMAL ALIGNMENT MODES (Print Space + Print Text) --
    if [[ "$1" == "-ac" ]]; then
        local padding=$(_calc_padding "center" "$2")
        if [[ $padding -gt 0 ]]; then printf "%${padding}s" ""; fi
        echo -e "$2"
        
    elif [[ "$1" == "-ar" ]]; then
        local padding=$(_calc_padding "right" "$2")
        if [[ $padding -gt 0 ]]; then printf "%${padding}s" ""; fi
        echo -e "$2"

    # -- PADDING ONLY MODES (Print Space Lang! Para kay Typewriter/Render_src) --
    elif [[ "$1" == "-pac" ]]; then
        local padding=$(_calc_padding "center" "$2")
        if [[ $padding -gt 0 ]]; then printf "%${padding}s" ""; fi
        
    elif [[ "$1" == "-par" ]]; then
        local padding=$(_calc_padding "right" "$2")
        if [[ $padding -gt 0 ]]; then printf "%${padding}s" ""; fi

    # -- MANUAL SPACE MODE (e.g. separator 15) --
    elif [[ "$1" =~ ^[0-9]+$ ]]; then
        local num_space="$1"
        if [[ $num_space -gt 0 ]]; then printf "%${num_space}s" ""; fi
        
    else
        echo "$@"
    fi
}
