# Shared environment bootstrap for Valence Studio launchers.
# Sourced with $DIR set to the repo root. STRICTLY uses apt (never pkg).

TERMUX_BIN=/data/data/com.termux/files/usr/bin

# apt with self-healing package lists: try direct install, and if the
# lists are stale/empty (fresh Termux), run `apt update` and retry.
apt_install() {
  apt install -y "$@" 2>/dev/null || { apt update -y && apt install -y "$@"; }
}

valence_node_works() {
  command -v node >/dev/null 2>&1 && node --version >/dev/null 2>&1
}

# Typical Termux breakage: node was built against a NEWER openssl than the
# installed one (partial upgrade) and dies at load time with e.g.
#   CANNOT LINK EXECUTABLE "node": cannot locate symbol
#   "OSSL_PROVIDER_add_conf_parameter" referenced by ".../bin/node"
# Fix ladder: realign openssl+nodejs → full upgrade (the standard cure for
# "cannot locate symbol" errors) → manual instructions.
valence_repair_node() {
  echo "[valence] Node.js is present but CANNOT RUN (OpenSSL/linker mismatch)."
  echo "[valence] Repairing automatically: apt install --reinstall openssl nodejs ..."
  apt update -y || true
  apt install --reinstall -y openssl nodejs || apt_install openssl nodejs || true
  valence_node_works && return 0
  echo "[valence] Still broken — running a full package upgrade (the standard fix)..."
  apt upgrade -y || true
  valence_node_works
}

valence_require_node() {
  # 1. PATH repair: node exists at the well-known Termux location but PATH
  #    is incomplete (happens in odd shell contexts).
  if ! command -v node >/dev/null 2>&1 && [ -x "$TERMUX_BIN/node" ]; then
    export PATH="$TERMUX_BIN:$PATH"
  fi
  # 2. Missing → auto-install (openssl alongside, so node's crypto symbols
  #    resolve against the matching library from day one).
  if ! command -v node >/dev/null 2>&1; then
    if command -v apt >/dev/null 2>&1; then
      echo "[valence] Node.js missing — installing automatically: apt install openssl nodejs"
      apt_install openssl nodejs || { echo "[valence] Node.js install FAILED — run manually: apt update && apt install openssl nodejs"; return 1; }
      [ -x "$TERMUX_BIN/node" ] && export PATH="$TERMUX_BIN:$PATH"
    fi
    command -v node >/dev/null 2>&1 || { echo "[valence] Node.js is required — install it (on Termux: apt update && apt install openssl nodejs)"; return 1; }
  fi
  # 3. Present → it must actually RUN (catches CANNOT LINK EXECUTABLE /
  #    missing OpenSSL symbols before anything else touches node).
  if ! node --version >/dev/null 2>&1; then
    if command -v apt >/dev/null 2>&1; then
      valence_repair_node || { echo "[valence] Node.js is still unusable. Fix manually: apt update && apt upgrade"; return 1; }
    else
      echo "[valence] Node.js found but cannot run (linker/OpenSSL error). Update your system packages, then retry."
      return 1
    fi
  fi
  return 0
}

valence_warn_storage() {
  case "$DIR" in
    /storage/*|"$HOME/storage/"*)
      echo "[valence] WARNING: running from shared storage — Android mounts it noexec." >&2
      echo "[valence] For reliable builds move the folder home, e.g.: cp -r \"$DIR\" ~/valence-studio" >&2 ;;
  esac
}
