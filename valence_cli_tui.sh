so[Aurce "lib/lib_manager.sh"
load Typewriter as tw
load render_src as rs
load colors
load align_text
load loading

Valence_cli_Banner_tw() {
  tw -ac -cn "${Blue} _    __          __
| |  / / ____ _  / / ___    ____    _____  ___                __  _
| | / / / __ \`/ / / / _ \\  / __ \\  / ___/ / _ \\  ___   ____  / / (_)
| |/ / / /_/ / / / /  __/ / / / / / /__  /  __/ |___| / __/ / / / /
|___/  \\__,_/ /_/  \\___/ /_/ /_/  \\___/  \\___/        \\__/ /_/ /_/${Reset}" 0.001

    tw -ac  "VALENCE FRAMEWORK" 0.009
    sleep 0.65
    tw -ac "Author: Nick Codings/NHZTech" 0.009
    sleep 0.5
    printf "${Reset}\n"
}

Valence_cli_Banner_rs() {
  rs -ac "${Blue} _    __          __
| |  / / ____ _  / / ___    ____    _____  ___                __  _
| | / / / __ \`/ / / / _ \\  / __ \\  / ___/ / _ \\  ___   ____  / / (_)
| |/ / / /_/ / / / /  __/ / / / / / /__  /  __/ |___| / __/ / / / /
|___/  \\__,_/ /_/  \\___/ /_/ /_/  \\___/  \\___/        \\__/ /_/ /_/${Reset}" 0.009
    echo
    rs -ac "VALENCE FRAMEWORK" 0.009
    sleep 0.65
    rs -ac "Author: Nick Codings/NHZTech" 0.009
    sleep 0.5
    printf "${Reset}\n"
}

valence() {
Valence_cli_Banner_rs
rs "
${Blue} Choose Upload Method: ${Reset}
  1. Zip
  2. Directory
  3. Single File
  4. Link

tw -r user_input "${Blue}Select: "${Reset}

Valence_cli_Banner_rs
if user_input == "1"; then
    tw "Get your ZIP file path by running [ pwd ] into the project folder."
    tw "PATH: /path/to/project/directory/project_name.zip"
    tw -r user_path "Enter Zip File Path: "
elif user_input == "2"; then
    tw "Get your project path by running [ pwd ] into the project folder."
    tw -r user_path "Enter Directory"
elif user_input == "3"; then
    tw -r user_path "Enter link: "
fi
}

clear
Valence_cli_Banner_tw

loading -al " ${Blue}[Valence]${Reset} Checking SDK  > (DIR)" -chkf "/data/data/com.termux/files/home/.valence/android-sdk" 3
loading -al " ${Blue}[Valence]${Reset} Checking NDK  > (DIR)" -chkf "/data/data/com.termux/files/home/.valence/android-ndk" 3
loading -al " ${Blue}[Valence]${Reset} Checking Graddle  > (DIR)" -chkf "/data/data/com.termux/files/home/.valence/gradle/gradle-8.7/bin/gradle" 3

clear
Valence_cli_Banner_rs

rs "
 1. Valence
 2. Install
 3. Update
 4. Re-install
 5. Delete
 6. Exit
" 0.009

tw -r user_input "${Blue}Select: "${Reset}

if user_input == "1"; then
    valence
elif user_input == "6"; then
    exit 0
else;
    echo "Choice not found.  Try Again!"
    valence
fi


