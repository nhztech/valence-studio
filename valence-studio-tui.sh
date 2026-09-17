source "lib/lib_manager.sh"
load Typewriter as tw
load colors
load loading
load align_text as ft

Valence_Banner() {

  tw -ac -cn "${Blue} _    __          __
| |  / / ____ _  / / ___    ____    _____  ___
| | / / / __ \`/ / / / _ \\  / __ \\  / ___/ / _ \\
| |/ / / /_/ / / / /  __/ / / / / / /__  /  __/
|___/  \\__,_/ /_/  \\___/ /_/ /_/  \\___/  \\___/${Reset}" 0.001

    tw -ac  "VALENCE FRAMEWORK" 0.009
    sleep 0.65
    tw -ac "Author: Nick Codings/NHZTech" 0.009
    sleep 0.5
    printf "${Reset}\n"
}


Valence_Banner

loading -al " ${Blue}[Valence]${Reset} Checking SDK  > (DIR)" -chkf "/data/data/com.termux/files/home/.valence/android-sdk" 2
loading -al " ${Blue}[Valence]${Reset} Checking NDK  > (DIR)" -chkf "/data/data/com.termux/files/home/.valence/android-ndk" 2
loading -al " ${Blue}[Valence]${Reset} Checking Graddle  > (DIR)" -chkf "/data/data/com.termux/files/home/.valence/gradle/gradle-8.7/bin/gradle" 2
echo
echo -n "${Blue} [Valence] ${Reset}"
sleep .75
tw -n "Toolchain Checking Complete! " 0.025
sleep 2
loading -al " ${Blue}[Valence]${Reset} Starting Valence Studio" -t "DONE" 4
echo
echo -n "${Blue} [Valence] ${Reset}"
sleep .75
tw "Valence Studio + Builder is running on > # link" 0.025

## Complete the code!
