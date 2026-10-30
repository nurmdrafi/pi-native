#!/bin/sh
# pi harness bootstrap — fresh clone → working setup (macOS + Linux).
#
# Usage: sh scripts/bootstrap.sh          (from repo root or anywhere)
#
# Does:  npm deps + pi package links, pidoc shim into bin/, pidx + piread
#        builds when cargo exists. Never installs anything itself — prints the exact
#        commands and exits when a toolchain is missing (ask-first rule).
# After this, `git pull` re-syncs via .husky/post-merge → scripts/after-pull.sh.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

echo "== bootstrap: $ROOT"

# Shared installer: copy + chmod + macOS adhoc re-sign (see the helper header).
. "$ROOT/scripts/lib/install-native.sh"

# 1. node deps + pi package links (extensions resolve the host install)
if command -v npm >/dev/null 2>&1; then
  npm install --no-audit --no-fund
  node scripts/link-pi.mjs
else
  echo "!! npm not found — install Node (nvm recommended), then re-run" >&2
  exit 1
fi

# 2. bin/ is machine-local (gitignored): create it + the pidoc shim
mkdir -p bin
cat > bin/pidoc <<EOF
#!/bin/sh
exec node "$ROOT/skills/pidoc/scripts/pidoc.mjs" "\$@"
EOF
chmod +x bin/pidoc
echo "== pidoc shim: bin/pidoc"

# 3. pidx (optional — session-audit fast path; Node fallback without it)
CARGO=$(command -v cargo || true)
[ -z "$CARGO" ] && [ -x "$HOME/.cargo/bin/cargo" ] && CARGO="$HOME/.cargo/bin/cargo"
if [ -n "$CARGO" ]; then
  (cd rust-tools && "$CARGO" build --release -p pidx)
  install_native rust-tools/target/release/pidx bin/pidx
  echo "== pidx: built + installed to bin/pidx"
else
  echo "== pidx: cargo not found — session-audit uses the Node parser (slower)." \
       "To enable: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal && re-run"
fi

# 4. piread (native read tool — registers unconditionally; Rust is the only
#    executor, so an unbuilt binary makes the tool reject, not fall back)
if [ -n "$CARGO" ]; then
  (cd rust-tools && "$CARGO" build --release -p piread)
  install_native rust-tools/target/release/piread bin/piread
  echo "== piread: built + installed to bin/piread"
else
  echo "== piread: cargo not found — the piread tool rejects until Rust is installed." \
       "To enable: install Rust (rustup command above) and re-run"
fi

# 5. piedit (native edit tool — registers unconditionally; Rust is the only
#    executor, so an unbuilt binary makes the tool reject, not fall back)
if [ -n "$CARGO" ]; then
  (cd rust-tools && "$CARGO" build --release -p piedit)
  install_native rust-tools/target/release/piedit bin/piedit
  echo "== piedit: built + installed to bin/piedit"
else
  echo "== piedit: cargo not found — the piedit tool rejects until Rust is installed." \
       "To enable: install Rust (rustup command above) and re-run"
fi

# 6. pibash (native shell tool — registers unconditionally; Rust is the only
#    executor, so an unbuilt binary makes the tool reject, not fall back)
if [ -n "$CARGO" ]; then
  (cd rust-tools && "$CARGO" build --release -p pibash)
  install_native rust-tools/target/release/pibash bin/pibash
  echo "== pibash: built + installed to bin/pibash"
else
  echo "== pibash: cargo not found — the pibash tool rejects until Rust is installed." \
       "To enable: install Rust (rustup command above) and re-run"
fi

# 6b. outline (definition index: `outline <file>` prints `start end kind name`
#    rows used to aim read windows without re-walking a file; plain CLI, not an extension)
if [ -n "$CARGO" ]; then
  (cd rust-tools && "$CARGO" build --release -p outline)
  install_native rust-tools/target/release/outline bin/outline
  echo "== outline: built + installed to bin/outline"
fi

# 7. health check
node skills/pidoc/scripts/pidoc.mjs || true
echo "== done. Put $ROOT/bin on PATH for pidoc/pidx."
