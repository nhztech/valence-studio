cmake_minimum_required(VERSION 3.22.1)
project(nhzterm C)

set(CMAKE_C_STANDARD 11)
add_compile_options(-Wall -Wextra -O2)

# libptyhelper.so — §4 method 4. forkpty() + exec, reached via JNI.
# Lands in the APK's native library dir, which is exec-permitted; this is what
# sidesteps the Android 10+ W^X restriction (§12.1).
add_library(ptyhelper SHARED ptyhelper.c)
find_library(log-lib log)
target_link_libraries(ptyhelper ${log-lib})
