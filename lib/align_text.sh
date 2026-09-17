#!/bin/bash
align_text() {
    local max_width=$(tput cols)
    ((max_width -= 2)) # Mag-iwan ng margin na 2 spaces

    # Basahin line-by-line para hindi masira ang manual Enters (1., 2., 3., etc.)
    while IFS= read -r line || [[ -n "$line" ]]; do
        local current_len=0
        local output=""

        # Hati-hatiin per word sa loob ng isang line
        for word in $line; do
            # Kunin ang haba ng word nang WALANG color codes
            local clean_word=$(echo -e "$word" | sed -E 's/\x1b\[[0-9;]*m//g')
            local word_len=${#clean_word}

            # Kung lalagpas na sa screen width, i-print ang naipon at mag-new line
            if (( current_len + word_len + 1 > max_width )) && (( current_len > 0 )); then
                echo -e "$output"
                output=""
                current_len=0
            fi

            # Idagdag ang word kasama ang kulay
            if (( current_len == 0 )); then
                output="$word"
                current_len=$word_len
            else
                output+=" $word"
                ((current_len += word_len + 1))
            fi
        done
        # I-print ang natirang words sa line
        echo -e "$output"
    done <<< "$1"
}

