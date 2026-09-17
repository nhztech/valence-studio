loading() {
    # 1. Color Definitions
    local C_WHITE=$'\033[1;37m'
    local C_RED=$'\033[1;31m'
    local C_BLUE=$'\033[38;2;0;180;255m'
    local C_GREEN=$'\033[38;2;50;205;50m'
    local C_YELLOW=$'\033[38;2;245;185;63m'
    local C_ORANGE=$'\033[1;38;2;244;117;27m'
    local C_RESET=$'\033[0m'

    # 2. Default Values
    local ALIGN_MODE="normal"
    local TEXT_ALIGN="r"
    local duration=3
    local MSG_TEXT=""
    local MSG_COLOR=""                  
    
    # Defaults para sa Event Watcher
    local WATCH_MODE=false
    local WATCH_FILE=""
    local SUCCESS_STRING=""
    local ERROR_STRING=""
    
    # Defaults para sa File/Folder Checker
    local CHK_MODE=false
    local CHK_FILE=""

    # Defaults para sa Brackets
    local SUCCESS_BRACKET_TEXT="OK"
    local ERROR_BRACKET_TEXT="FAILED"
    local SUCCESS_BRACKET_COLOR="$C_GREEN"
    local ERROR_BRACKET_COLOR="$C_RED"

    # State trackers
    local TARGET_CONTEXT="msg" 
    local LAST_EVENT_TYPE="success"

    # 3. Super Argument Parser
    while [[ "$#" -gt 0 ]]; do
        case "$1" in
            -h|--help)
                echo -e "${C_BLUE}NHZ Loader Effect - Help Menu${C_RESET}"
                echo -e "${C_WHITE}Usage:${C_RESET} loading [flags] \"text\" [duration]"
                echo -e "\n${C_GREEN}Formatting:${C_RESET}"
                echo -e "  -al               :  Align Left"
                echo -e "  -ar               :  Align Right"
                echo -e "  -cnt-ldng-efct    :  Align Center"
                echo -e "  -cw               :  Color White"
                echo -e "  -cr               :  Color Red"
                echo -e "  -cb               :  Color Blue"
                echo -e "  -cg               :  Color Green"
                echo -e "  -cy               :  Color Yellow"
                echo -e "  -co               :  Color Orange"
                echo -e "\n${C_GREEN}Event Watcher:${C_RESET}"
                echo -e "  -w  [log file]    :  Watch a log file"
                echo -e "  -s  [string]      :  Success string — triggers [ OK ]"
                echo -e "  -e  [string]      :  Error string  — triggers [ FAILED ]"
                echo -e "\n${C_GREEN}File Checker:${C_RESET}"
                echo -e "  -chkf [file]      :  Check if file/folder exists"
                echo -e "  -fnd  [string]    :  Output text if found"
                echo -e "  -!fnd [string]    :  Output text if not found"
                echo -e "\n${C_GREEN}Bracket:${C_RESET}"
                echo -e "  -t                :  Target bracket for next color/text flag"
                echo -e "\n${C_GREEN}Duration:${C_RESET}"
                echo -e "  [number]          :  Seconds to spin (default: 3)"
                echo -e "\n${C_GREEN}Examples:${C_RESET}"
                echo -e "  loading -al -cw \"Booting System\" 3"
                echo -e "  loading -al -cg \"Checking file\" -chkf \"\$file\" -fnd \"OK\" -!fnd \"FAILED\""
                echo -e "  loading -al \"Init GNOME\" -w \"\$LOG\" -s \"GNOME started\" -t -cg \"OK\" -e \"Fault\" -t -cr \"FAILED\""
                return 0 ;;
            -rgt-ldng-efct) ALIGN_MODE="right"; shift ;;
            -lft-ldng-efct) ALIGN_MODE="left"; shift ;;
            -a)  TEXT_ALIGN="${2:-r}"; shift 2 ;;
            -al) TEXT_ALIGN="l"; shift ;;
            -ar) TEXT_ALIGN="r"; shift ;;
            
            # --- EVENT WATCHER FLAGS ---
            -w)
                WATCH_MODE=true
                WATCH_FILE="$2"
                shift 2
                ;;
            -s)
                SUCCESS_STRING="$2"
                LAST_EVENT_TYPE="success"
                shift 2
                ;;
            -e)
                ERROR_STRING="$2"
                LAST_EVENT_TYPE="error"
                shift 2
                ;;

            # --- FILE/FOLDER CHECKER FLAGS ---
            -chkf)
                CHK_MODE=true
                CHK_FILE="$2"
                shift 2
                ;;
            -fnd)
                SUCCESS_BRACKET_TEXT="$2"
                LAST_EVENT_TYPE="success"
                TARGET_CONTEXT="bracket" # Auto-target sa bracket para sa mga susunod na color flags
                shift 2
                ;;
            -\!fnd|-!fnd)
                ERROR_BRACKET_TEXT="$2"
                LAST_EVENT_TYPE="error"
                TARGET_CONTEXT="bracket"
                shift 2
                ;;

            -t) 
                TARGET_CONTEXT="bracket"
                shift 
                ;;
                
            # Kulay Flags! Dynamic kung saan ia-apply
            -cw|-cr|-cb|-cg|-cy|-co)
                local SELECTED_COLOR=""
                case "$1" in
                    -cw) SELECTED_COLOR="$C_WHITE" ;;
                    -cr) SELECTED_COLOR="$C_RED" ;;
                    -cb) SELECTED_COLOR="$C_BLUE" ;;
                    -cg) SELECTED_COLOR="$C_GREEN" ;;
                    -cy) SELECTED_COLOR="$C_YELLOW" ;;
                    -co) SELECTED_COLOR="$C_ORANGE" ;;
                esac
                
                if [[ "$TARGET_CONTEXT" == "msg" ]]; then
                    MSG_COLOR="$SELECTED_COLOR"
                else
                    if [[ "$LAST_EVENT_TYPE" == "error" ]]; then
                        ERROR_BRACKET_COLOR="$SELECTED_COLOR"
                    else
                        SUCCESS_BRACKET_COLOR="$SELECTED_COLOR"
                    fi
                fi
                shift
                ;;
                
            *)
                if [[ "$1" =~ ^[0-9]+$ ]]; then
                    duration="$1"
                else
                    if [[ "$TARGET_CONTEXT" == "msg" ]]; then
                        MSG_TEXT="$1"
                    elif [[ "$TARGET_CONTEXT" == "bracket" ]]; then
                        if [[ "$LAST_EVENT_TYPE" == "error" ]]; then
                            ERROR_BRACKET_TEXT="$1"
                        else
                            SUCCESS_BRACKET_TEXT="$1"
                        fi
                        TARGET_CONTEXT="msg" 
                    fi
                fi
                shift
                ;;
        esac
    done

    # 4. Preparation ng Formats
    local spinstr=( '⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏' )
    local end=$((SECONDS + duration))
    local i=0
    local IS_ERROR_TRIGGERED=false
    local KEEP_RUNNING=true

    local FMT_MSG=""
    if [[ -n "$MSG_TEXT" ]]; then
        FMT_MSG="${MSG_COLOR}${MSG_TEXT}${C_RESET}"
    fi

    # Paunang kalkula ng space gamit ang SUCCESS text para malinis ang pag-spin
    local PAD_SPACE=""
    if [[ "$ALIGN_MODE" == "center" ]]; then
        PAD_SPACE=$(separator -pac "[ ${SUCCESS_BRACKET_TEXT} ]") 
    elif [[ "$ALIGN_MODE" == "right" ]]; then
        PAD_SPACE=$(separator -par "${MSG_TEXT}[ ${SUCCESS_BRACKET_TEXT} ]")
    fi

    printf "\e[?25l"

    # 5. Ang Loop (Event Watcher & Spinning)
    while [[ "$KEEP_RUNNING" == true ]]; do
        
        if [[ "$WATCH_MODE" == true ]]; then
            if [[ -f "$WATCH_FILE" ]]; then
                if [[ -n "$SUCCESS_STRING" ]] && grep -q -a "$SUCCESS_STRING" "$WATCH_FILE"; then
                    KEEP_RUNNING=false
                elif [[ -n "$ERROR_STRING" ]] && grep -q -a "$ERROR_STRING" "$WATCH_FILE"; then
                    KEEP_RUNNING=false
                    IS_ERROR_TRIGGERED=true
                fi
            fi
        else
            if [ $SECONDS -ge $end ]; then
                KEEP_RUNNING=false
            fi
        fi

        if [[ "$KEEP_RUNNING" == false ]]; then
            break
        fi

        # SPINNER RENDER
        if [[ "$ALIGN_MODE" == "center" ]]; then
            printf "\r\e[K%s[ %s%s%s ]" "$PAD_SPACE" "$SUCCESS_BRACKET_COLOR" "${spinstr[i]}" "$C_RESET"
            
        elif [[ "$ALIGN_MODE" == "right" ]]; then
            printf "\r\e[K%s%s[ %s%s%s ]" "$FMT_MSG" "$PAD_SPACE" "$SUCCESS_BRACKET_COLOR" "${spinstr[i]}" "$C_RESET"
            
        elif [[ "$ALIGN_MODE" == "left" ]]; then
            if [[ -n "$MSG_TEXT" ]]; then
                printf "\r\e[K[ %s%s%s ] %s" "$SUCCESS_BRACKET_COLOR" "${spinstr[i]}" "$C_RESET" "$FMT_MSG"
            else
                printf "\r\e[K[ %s%s%s ]" "$SUCCESS_BRACKET_COLOR" "${spinstr[i]}" "$C_RESET"
            fi
            
        elif [[ "$ALIGN_MODE" == "normal" ]]; then
            if [[ "$TEXT_ALIGN" == "l" ]]; then
                if [[ -n "$MSG_TEXT" ]]; then
                    printf "\r\e[K%s [ %s%s%s ]" "$FMT_MSG" "$SUCCESS_BRACKET_COLOR" "${spinstr[i]}" "$C_RESET"
                else
                    printf "\r\e[K[ %s%s%s ]" "$SUCCESS_BRACKET_COLOR" "${spinstr[i]}" "$C_RESET"
                fi
            else
                if [[ -n "$MSG_TEXT" ]]; then
                    printf "\r\e[K[ %s%s%s ] %s" "$SUCCESS_BRACKET_COLOR" "${spinstr[i]}" "$C_RESET" "$FMT_MSG"
                else
                    printf "\r\e[K[ %s%s%s ]" "$SUCCESS_BRACKET_COLOR" "${spinstr[i]}" "$C_RESET"
                fi
            fi
        fi

        i=$(( (i + 1) % 10 ))
        
        if [[ "$ALIGN_MODE" == "center" ]]; then
            local dynamic_speeds=(0.05 0.08 0.1 0.1 0.1 0.15 0.2 0.3)
            local current_speed="${dynamic_speeds[$((RANDOM % ${#dynamic_speeds[@]}))]}"
            sleep "$current_speed"
        else
            sleep 0.1
        fi
    done

    # 5.5 LOGIC EVALUATOR PARA SA FILE/FOLDER CHECKER
    # Kapag tapos na umikot, i-check kung nag-eexist ba yung file/folder
    if [[ "$CHK_MODE" == true ]]; then
        if [[ -e "$CHK_FILE" ]]; then
            IS_ERROR_TRIGGERED=false
        else
            IS_ERROR_TRIGGERED=true
        fi
    fi

    # 6. Output Finalization
    local FINAL_BRACKET_TEXT="$SUCCESS_BRACKET_TEXT"
    local FINAL_BRACKET_COLOR="$SUCCESS_BRACKET_COLOR"
    
    if [[ "$IS_ERROR_TRIGGERED" == true ]]; then
        FINAL_BRACKET_TEXT="$ERROR_BRACKET_TEXT"
        FINAL_BRACKET_COLOR="$ERROR_BRACKET_COLOR"
    fi

    # MAGIC ALIGNMENT FIX
    if [[ "$ALIGN_MODE" == "center" ]]; then
        PAD_SPACE=$(separator -pac "[ ${FINAL_BRACKET_TEXT} ]") 
    elif [[ "$ALIGN_MODE" == "right" ]]; then
        PAD_SPACE=$(separator -par "${MSG_TEXT}[ ${FINAL_BRACKET_TEXT} ]")
    fi

    if [[ "$ALIGN_MODE" == "center" ]]; then
        printf "\r\e[K" 
        
    elif [[ "$ALIGN_MODE" == "right" ]]; then
        printf "\r\e[K%s%s[ %s%s%s ]\n" "$FMT_MSG" "$PAD_SPACE" "$FINAL_BRACKET_COLOR" "$FINAL_BRACKET_TEXT" "$C_RESET"
        
    elif [[ "$ALIGN_MODE" == "left" ]]; then
        if [[ -n "$MSG_TEXT" ]]; then
            printf "\r\e[K[ %s%s%s ] %s\n" "$FINAL_BRACKET_COLOR" "$FINAL_BRACKET_TEXT" "$C_RESET" "$FMT_MSG"
        else
            printf "\r\e[K[ %s%s%s ]\n" "$FINAL_BRACKET_COLOR" "$FINAL_BRACKET_TEXT" "$C_RESET"
        fi
        
    elif [[ "$ALIGN_MODE" == "normal" ]]; then
        if [[ "$TEXT_ALIGN" == "l" ]]; then
            if [[ -n "$MSG_TEXT" ]]; then
                printf "\r\e[K%s [ %s%s%s ]\n" "$FMT_MSG" "$FINAL_BRACKET_COLOR" "$FINAL_BRACKET_TEXT" "$C_RESET"
            else
                printf "\r\e[K[ %s%s%s ]\n" "$FINAL_BRACKET_COLOR" "$FINAL_BRACKET_TEXT" "$C_RESET"
            fi
        else
            if [[ -n "$MSG_TEXT" ]]; then
                printf "\r\e[K[ %s%s%s ] %s\n" "$FINAL_BRACKET_COLOR" "$FINAL_BRACKET_TEXT" "$C_RESET" "$FMT_MSG"
            else
                printf "\r\e[K[ %s%s%s ]\n" "$FINAL_BRACKET_COLOR" "$FINAL_BRACKET_TEXT" "$C_RESET"
            fi
        fi
    fi
    
    printf "\e[?25h"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    loading --help
fi
