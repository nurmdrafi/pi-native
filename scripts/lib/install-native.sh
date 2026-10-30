#!/bin/sh
# install-native.sh — copy a built native binary into bin/ and keep it
# executable (shared by bootstrap.sh and after-pull.sh).
#
# Why this exists: on macOS every binary is adhoc-signed at link time, and a
# plain `cp` over an existing copy leaves the *page hashes* pointing at the old
# file. The kernel then refuses to map it — "load code signature error 2",
# "Security policy would not allow process" — and the process is SIGKILLed
# (137) before main() runs. The extension cannot tell that apart from a missing
# binary, so the symptom shows up as native-tool errors on stderr, not as a
# build error. Re-signing after the copy
# (adhoc is sufficient for a local, non-quarantined binary) restores it.
#
# Linux has no codesign and no such check: the guard is a no-op there.
#
# Usage: install_native <src-binary> <dest-path>
# Sourced by the installers; not executable on its own.

install_native() {
  if [ "$#" -ne 2 ]; then
    echo "!! install_native: expected <src> <dest>" >&2
    return 2
  fi
  _native_src=$1
  _native_dest=$2

  if [ ! -f "$_native_src" ]; then
    echo "!! install_native: source missing: $_native_src" >&2
    return 1
  fi

  mkdir -p "$(dirname "$_native_dest")" || return 1
  # Stage + rename, never cp over a live binary: a running daemon keeps
  # bin/<tool> executing, cp fails with "Text file busy", while rename()
  # swaps the directory entry — the old inode keeps serving the daemon,
  # the next start picks up the fresh binary.
  _native_tmp=${_native_dest}.new
  cp "$_native_src" "$_native_tmp" || return 1
  chmod +x "$_native_tmp" || return 1

  # macOS only: re-sign adhoc so the kernel accepts the copied image.
  case $(uname -s 2>/dev/null) in
    Darwin)
      if command -v codesign >/dev/null 2>&1; then
        # --force replaces the invalidated signature; a failure here is not
        # fatal (the binary may still run) but must be visible.
        codesign --force --sign - "$_native_tmp" 2>/dev/null ||
          echo "!! install_native: codesign failed for $_native_dest — the kernel may refuse to exec it" >&2
      else
        echo "!! install_native: codesign not found on macOS — $_native_dest may be unexecutable" >&2
      fi
      ;;
  esac
  mv -f "$_native_tmp" "$_native_dest" || { rm -f "$_native_tmp"; return 1; }
  return 0
}
