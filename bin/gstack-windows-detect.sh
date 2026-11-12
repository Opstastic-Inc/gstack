# shellcheck shell=bash
# gstack-windows-detect.sh — sourced helper: is this shell a Windows shell
# (Git Bash / MSYS2 / Cygwin)? Used by setup, bin/gstack-memorable and
# bin/gstack-gbrain-install so all three read the platform the same way.
#
#   gstack_windows_flag [UNAME]   prints 1 when UNAME (default: `uname -s`)
#                                 starts with MINGW, MSYS or CYGWIN, or is
#                                 Windows_NT; prints 0 otherwise. An empty
#                                 UNAME counts as unset, so a caller can pass
#                                 its own test override straight through.
#
# Callers keep the result in IS_WINDOWS:  IS_WINDOWS="$(gstack_windows_flag)"
# No side effects; safe under set -u.

gstack_windows_flag() {
  case "${1:-$(uname -s)}" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) printf '1\n' ;;
    *) printf '0\n' ;;
  esac
}
