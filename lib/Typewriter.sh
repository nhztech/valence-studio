Typewriter() {
    local text=""
    local delay=""
    local color_code=""
    local format_code=""
    local use_shell=false
    local no_newline=false
    local extra_newline=false
    local align_mode="none"
    local read_var=""

    local White="\033[1;37m"
    local Red="\033[1;31m"
    local Blue="\033[38;2;0;180;255m"
    local Green="\033[38;2;50;205;50m"
    local Yellow="\033[38;2;245;185;63m"
    local Orange="\033[1;38;2;244;117;27m"
    local Reset="\033[0m"
    local f_Bold="\033[1m"
    local f_Italic="\033[3m"
    local f_Underline="\033[4m"

    local current_dir=$(pwd | sed "s|^$HOME|~|")

    _strip_len() { local s; s=$(echo -e "$1" | sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g'); echo "${#s}"; }

    while [[ "$#" -gt 0 ]]; do
        case "$1" in
            -h|--help)
                echo -e "${Blue}NHZ Typewriter Engine - Help Menu${Reset}"
                echo -e "${White}Usage:${Reset} Typewriter [flags] \"text\" [speed]"
                echo -e "\n${Green}Text Alignment:${Reset}"
                echo -e "  -al  :  Align Left"
                echo -e "  -ac  :  Align Center"
                echo -e "  -ar  :  Align Right"
                echo -e "\n${Green}Text Formatting:${Reset}"
                echo -e "  -b   :  Bold"
                echo -e "  -i   :  Italic"
                echo -e "  -u   :  Underline"
                echo -e "\n${Green}Colors:${Reset}"
                echo -e "  -cw  :  Color White"
                echo -e "  -cr  :  Color Red"
                echo -e "  -cb  :  Color Blue"
                echo -e "  -cg  :  Color Green"
                echo -e "  -cy  :  Color Yellow"
                echo -e "  -co  :  Color Orange"
                echo -e "\n${Green}Utilities:${Reset}"
                echo -e "  -r [var]  :  Read user input and store into a variable"
                return 0 ;;
            -cw) color_code="$White"          ;;
            -cr) color_code="$Red"            ;;
            -cb) color_code="$Blue"           ;;
            -cg) color_code="$Green"          ;;
            -cy) color_code="$Yellow"         ;;
            -co) color_code="$Orange"         ;;
            -b)  format_code+="$f_Bold"       ;;
            -i)  format_code+="$f_Italic"     ;;
            -u)  format_code+="$f_Underline"  ;;
            -al) align_mode="left"            ;;
            -ac) align_mode="center"          ;;
            -ar) align_mode="right"           ;;
            -s)  use_shell=true               ;;
            -n)  no_newline=true              ;;
            -cn) extra_newline=true           ;;
            -r)
                if [[ -n "$2" && "$2" != -* ]]; then
                    read_var="$2"
                    no_newline=true
                    shift
                fi ;;
            *)
                if   [[ -z "$text"  ]]; then text="$1"
                elif [[ -z "$delay" ]]; then delay="$1"; fi ;;
        esac
        shift
    done

    delay="${delay:-0.05}"

    if [[ "$align_mode" != "none" && "$text" != *$'\n'* ]]; then
        text="${text#"${text%%[![:space:]]*}"}"
        text="${text%"${text##*[![:space:]]}"}"
    fi
    local original_text="$text"

    if [[ "$align_mode" != "none" ]]; then
        local max_width
        max_width=$(tput cols)
        ((max_width -= 2))
        local -a wrapped_lines=()
        local block_max_len=0

        _push_line() {
            local len
            len=$(_strip_len "$1")
            wrapped_lines+=("$1")
            (( len > block_max_len )) && block_max_len=$len
        }

        while IFS= read -r line || [[ -n "$line" ]]; do
            local line_len
            line_len=$(_strip_len "$line")

            if (( line_len <= max_width )); then
                _push_line "$line"; continue
            fi

            local current_len=0
            local output=""
            for word in $line; do
                local word_len
                word_len=$(_strip_len "$word")
                if (( current_len + word_len + 1 > max_width && current_len > 0 )); then
                    _push_line "$output"
                    output="$word"
                    current_len=$word_len
                elif (( current_len == 0 )); then
                    output="$word"
                    current_len=$word_len
                else
                    output+=" $word"
                    ((current_len += word_len + 1))
                fi
            done
            [[ -n "$output" ]] && _push_line "$output"
        done <<< "$text"

        local pad=0
        [[ "$align_mode" == "center" ]] && pad=$(( (max_width - block_max_len) / 2 ))
        [[ "$align_mode" == "right"  ]] && pad=$(( max_width - block_max_len ))
        (( pad < 0 )) && pad=0

        local spacing=""
        (( pad > 0 )) && spacing=$(printf '%*s' "$pad" "")
        local first=true
        local aligned_text=""
        for output in "${wrapped_lines[@]}"; do
            [[ "$first" == true ]] && first=false || aligned_text+=$'\n'
            aligned_text+="${spacing}${output}"
        done
        text="$aligned_text"
    fi

    if [[ "$use_shell" == true ]]; then
        echo -e "${Blue}┌──(${Green}nhztech@${ID}${Blue})${Green}-${Blue}[${Reset}${current_dir}${Blue}]${Reset}"
        echo -ne "${Blue}└─\>${Reset} $ "
        sleep 0.5
    fi

    color_code="${format_code}${color_code}"
    [[ -n "$color_code" ]] && echo -ne "$color_code"

    while [[ -n "$text" ]]; do
        if [[ "$text" =~ ^($'\e'\[[0-9;]*[mK]) ]]; then
            echo -ne "${BASH_REMATCH[1]}"; text="${text#${BASH_REMATCH[1]}}"
        else
            echo -n "${text:0:1}"; sleep "$delay"; text="${text:1}"
        fi
    done

    [[ -n "$color_code"        ]] && echo -ne "$Reset"
    [[ "$no_newline"  == false ]] && echo ""
    [[ "$use_shell"   == true  ]] && { sleep 0.5; eval "$original_text"; }
    [[ -n "$read_var"          ]] && read -r "$read_var"
    [[ "$extra_newline" == true ]] && echo ""
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    Typewriter --help
fi
