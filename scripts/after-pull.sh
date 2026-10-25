#!/bin/sh
# after-pull.sh — keep the machine-local harness setup in sync after a pull.
# Invoked by .husky/post-merge and .husky/post-rewrite on macOS + Linux.
#
# Always runs the pidoc health check. Safe, non-privileged fixes apply
# automatically (npm deps + host links, pidoc shim, pidx rebuild). Missing
# toolchains (cargo/rg/gh/jq/fd) are reported with their fix command — installs
# are never run from here (ask-first rule). Always exits 0.
set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0

echo "== after-pull: syncing setup ($(uname -s))"

# Shared installer: copy + chmod + macOS adhoc re-sign. A bare `cp` leaves the
# signature hashes stale and the kernel SIGKILLs the binary on exec.
. "$ROOT/scripts/lib/install-native.sh"
. "$ROOT/scripts/lib/progress.sh"

# 5 counted steps: deps, piread, piedit, pibash, auto-heal. The pidoc health
# check stays un-wrapped — its FAIL/WARN rows are the deliverable, not noise.
ui_total 5

# 1. Node deps + host pi package links. Fresh install only when the manifest
#    moved in this pull or node_modules is missing; link-pi self-validates.
if command -v npm >/dev/null 2>&1; then
  changed=0
  [ -d node_modules ] || changed=1
  if git rev-parse --verify -q ORIG_HEAD >/dev/null 2>&1 &&
     ! git diff --quiet ORIG_HEAD HEAD -- package.json package-lock.json 2>/dev/null; then
    changed=1
  fi
  if [ "$changed" = 1 ]; then
    ui_run "npm deps (manifest moved or node_modules missing) + host links" \
      npm install --no-audit --no-fund
  else
    ui_run "npm deps up to date + host links" node scripts/link-pi.mjs
  fi
else
  ui_step "npm deps — npm not found (install Node, then: sh scripts/bootstrap.sh)"
fi

# 2. pidoc shim (bin/ is gitignored, so git never delivers it)
mkdir -p bin
cat > bin/pidoc <<EOF
#!/bin/sh
exec node "$ROOT/skills/pidoc/scripts/pidoc.mjs" "\$@"
EOF
chmod +x bin/pidoc

# 2b. Kill daemons started from older binaries BEFORE any install: a live
#     daemon keeps bin/<tool> busy ("Text file busy") and the cp fails.
#     Each session lazily restarts them from the fresh binaries on its
#     next native tool call (one-shot fallback covers the gap).
if command -v pkill >/dev/null 2>&1; then
  pkill -f "$ROOT/bin/(pibash|piread|piedit) --serve" 2>/dev/null || true
fi

# 3. piread (native read tool, default-on — PI_NATIVE_READ=0 opts out;
#    falls back to the built-in read without the binary). Always rebuilt —
#    cargo is incremental, so a no-op rebuild stays cheap; pidx staleness is
#    handled by the pidoc --fix step below. Builds from the custom-tools
#    workspace (-p).
PIREAD_CRATE=custom-tools/piread
PIREAD_TARGET=custom-tools/target/release/piread
if [ -d "$PIREAD_CRATE/src" ] && [ -f "$PIREAD_CRATE/Cargo.toml" ]; then
  CARGO=$(command -v cargo || true)
  [ -z "$CARGO" ] && [ -x "$HOME/.cargo/bin/cargo" ] && CARGO="$HOME/.cargo/bin/cargo"
  if [ -n "$CARGO" ]; then
      ui_run "piread: build + install (cargo --release)" \
        sh -c 'cd custom-tools && exec "$1" build --release -p piread' sh "$CARGO" \
        && install_native "$PIREAD_TARGET" bin/piread \
        || echo "!! piread: falls back to the built-in read" >&2
  else
    ui_step "piread: cargo not found — extension falls back to the built-in read"
  fi
fi

# 4. piedit (native edit tool, default-on — PI_NATIVE_EDIT=0 opts out;
#    falls back to the built-in edit without the binary). Always rebuilt
#    like piread; builds from the custom-tools workspace (-p).
PIEDIT_CRATE=custom-tools/piedit
PIEDIT_TARGET=custom-tools/target/release/piedit
if [ -d "$PIEDIT_CRATE/src" ] && [ -f "$PIEDIT_CRATE/Cargo.toml" ]; then
  CARGO=$(command -v cargo || true)
  [ -z "$CARGO" ] && [ -x "$HOME/.cargo/bin/cargo" ] && CARGO="$HOME/.cargo/bin/cargo"
  if [ -n "$CARGO" ]; then
      ui_run "piedit: build + install (cargo --release)" \
        sh -c 'cd custom-tools && exec "$1" build --release -p piedit' sh "$CARGO" \
        && install_native "$PIEDIT_TARGET" bin/piedit \
        || echo "!! piedit: falls back to the built-in edit" >&2
  else
    ui_step "piedit: cargo not found — extension falls back to the built-in edit"
  fi
fi

# 5. pibash (native shell tool, default-on — PI_NATIVE_BASH=0 opts out;
#    falls back to the built-in bash without the binary). Always rebuilt
#    like piread; builds from the custom-tools workspace (-p).
PIBASH_CRATE=custom-tools/pibash
PIBASH_TARGET=custom-tools/target/release/pibash
if [ -d "$PIBASH_CRATE/src" ] && [ -f "$PIBASH_CRATE/Cargo.toml" ]; then
  CARGO=$(command -v cargo || true)
  [ -z "$CARGO" ] && [ -x "$HOME/.cargo/bin/cargo" ] && CARGO="$HOME/.cargo/bin/cargo"
  if [ -n "$CARGO" ]; then
      ui_run "pibash: build + install (cargo --release)" \
        sh -c 'cd custom-tools && exec "$1" build --release -p pibash' sh "$CARGO" \
        && install_native "$PIBASH_TARGET" bin/pibash \
        || echo "!! pibash: falls back to the built-in bash" >&2
  else
    ui_step "pibash: cargo not found — extension falls back to the built-in bash"
  fi
fi

# 5c. Kill daemons started from older binaries: a pull can replace bin/*
#     while long-lived pi sessions keep serving from pre-pull daemons.
#     Each session lazily restarts them from the fresh binaries on its
#     next native tool call (one-shot fallback covers the gap).
ui_step "auto-heal: stale daemons + PATH pin"
if command -v node >/dev/null 2>&1; then
  node scripts/sync-agent-bin.mjs || true
fi

# 6. Full health check; --fix rebuilds pidx when missing/stale and applies
#    any other safe fix. FAIL/WARN rows print their own fix hints.
if command -v node >/dev/null 2>&1; then
  node skills/pidoc/scripts/pidoc.mjs --fix || true
else
  echo "!! node not found — cannot verify setup" >&2
fi

ui_finish "after-pull"

exit 0
