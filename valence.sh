source "lib/lib_manager.sh"
load Typewriter as tw
load colors
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

Valence_cli_Banner() {

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


Valence_Banner
Valence_cli_Banner
