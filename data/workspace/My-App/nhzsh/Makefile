# nhzsh — POSIX-subset shell for nhzterm
#
# Two outputs:
#   nhzsh        a normal executable, for host testing
#   libnhzsh.so  the SAME program named as a .so, which is how it ships inside
#                the APK — Android only permits execution from the native
#                library directory (§12.1), and the installer only extracts
#                files matching lib*.so.

CC      ?= cc
# _POSIX_C_SOURCE 200809: strdup, getline, forkpty et al are POSIX, not ISO C.
# Without it, -std=c11 hides them and the build breaks in confusing ways.
CFLAGS  ?= -std=c11 -D_POSIX_C_SOURCE=200809L -D_DEFAULT_SOURCE -Wall -Wextra -O2
LDFLAGS ?=

SRC     := $(wildcard src/*.c)
OBJ     := $(SRC:.c=.o)
BIN     := nhzsh

# Every source except main.c, so tests can link their own entry point.
LIB_SRC := $(filter-out src/main.c,$(SRC))

TESTS   := test_lexer test_parser test_expander test_executor test_daemon_link test_load
TEST_BIN := $(addprefix tests/,$(TESTS))

.PHONY: all clean test android

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

# --- tests ---------------------------------------------------------------
# Each phase gate is its own binary so a failure names the phase directly.

tests/test_lexer: tests/test_lexer.c src/lexer.c
	$(CC) $(CFLAGS) -o $@ $^

tests/test_parser: tests/test_parser.c src/parser.c src/lexer.c
	$(CC) $(CFLAGS) -o $@ $^

tests/test_expander: tests/test_expander.c src/expander.c src/state.c
	$(CC) $(CFLAGS) -o $@ $^

tests/test_executor: tests/test_executor.c $(LIB_SRC)
	$(CC) $(CFLAGS) -o $@ $^

tests/test_daemon_link: tests/test_daemon_link.c $(LIB_SRC)
	$(CC) $(CFLAGS) -o $@ $^

tests/test_load: tests/test_load.c $(LIB_SRC)
	$(CC) $(CFLAGS) -o $@ $^

test: $(TEST_BIN) $(BIN)
	@echo "=============================================="
	@echo " nhzsh — all phase gates"
	@echo "=============================================="
	@for t in $(TEST_BIN); do \
		echo ""; ./$$t || exit 1; \
	done
	@echo ""
	@sh tests/posix_suite.sh ./$(BIN) || exit 1
	@echo ""
	@echo "ALL nhzsh GATES PASSED"

clean:
	rm -f $(OBJ) $(BIN) $(TEST_BIN) libnhzsh.so

# --- android packaging ---------------------------------------------------
# The Integration Point: nhzsh ships INSIDE the APK as libnhzsh.so.
# Android only permits execution from the app's native library directory, and
# the installer only extracts files matching lib*.so — hence the name. It is a
# normal PIE executable, not a shared library (§12.1).
#
#   make android NDK=$ANDROID_NDK_HOME ABI=arm64-v8a
NDK ?= $(ANDROID_NDK_HOME)
ABI ?= arm64-v8a
API ?= 24

ifeq ($(ABI),arm64-v8a)
  TRIPLE := aarch64-linux-android
else ifeq ($(ABI),armeabi-v7a)
  TRIPLE := armv7a-linux-androideabi
else
  TRIPLE := x86_64-linux-android
endif

android:
	@test -n "$(NDK)" || (echo "set NDK=/path/to/android-ndk"; exit 1)
	$(NDK)/toolchains/llvm/prebuilt/linux-x86_64/bin/$(TRIPLE)$(API)-clang \
		$(CFLAGS) -fPIE -pie -o libnhzsh.so $(SRC)
	@echo "built libnhzsh.so for $(ABI) — copy to app/src/main/jniLibs/$(ABI)/"
