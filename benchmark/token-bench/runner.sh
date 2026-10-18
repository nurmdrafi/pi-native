#!/usr/bin/env bash
# runner.sh — runs one benchmark variant/rep in a fully isolated pi-home + workspace.
#
# Usage: runner.sh <variant> <rep>
#   variant: direct | codemode | gate-on | gate-block
#   rep: run index (1-based)
#
# Layout (all under bench/):
#   pi-homes/<variant>/      cloned agent-home copy (tools/config/AGENTS.md), gitignored
#   runs/<variant>-r<k>/     freshly seeded task workspace
#   sessions/<variant>-r<k>/ isolated session logs for this run
#
# Isolation (verified):
#   - PI_CODING_AGENT_DIR      -> the variant's own agent-home copy
#   - PI_CODING_AGENT_SESSION_DIR -> the run's own sessions dir
#   - cwd                      -> the freshly seeded workspace (agent operates here)
set -euo pipefail

variant="${1:?usage: runner.sh <variant> <rep>}"
rep="${2:?usage: runner.sh <variant> <rep>}"

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$HARNESS_DIR/../.." && pwd)"
RUNTIME_DIR="${BENCH_RUNTIME_DIR:-$HOME/.pi/bench}"
# resolve pi from PATH unless overridden — no absolute user paths (portability rule)
PI_BIN="${PI_BIN:-$(command -v pi 2>/dev/null || true)}"
[ -n "$PI_BIN" ] || { echo "PI_BIN not set and 'pi' not on PATH" >&2; exit 1; }

home="$RUNTIME_DIR/pi-homes/$variant"
work="$RUNTIME_DIR/runs/$variant-r$rep"
sessions="$RUNTIME_DIR/sessions/$variant-r$rep"

# model + thinking fixed across all variants per plan
MODEL="${BENCH_MODEL:-deepseek/deepseek-flash}"
THINKING="${BENCH_THINKING:-off}"

# --- 1. ensure pi-home exists (scaffold on demand) ---
if [ ! -d "$home" ]; then
  echo "scaffolding pi-home: $variant" >&2
  "$HARNESS_DIR/scaffold.sh" "$variant"
fi

# --- 2. seed a fresh workspace ---
rm -rf "$work"
mkdir -p "$work"
rsync -a "$HARNESS_DIR/task-template/" "$work/"
# copy commitlint config for the gate hook (V4)
cp "$REPO_DIR/commitlint.config.js" "$work/commitlint.config.js" 2>/dev/null || true
# init a git repo so the agent can commit
git -C "$work" init -q
git -C "$work" config user.email "bench@example.com"
git -C "$work" config user.name "Bench Runner"
git -C "$work" add -A
git -C "$work" commit -q -m "chore: seed benchmark workspace"

# --- 3. isolate sessions ---
rm -rf "$sessions"
mkdir -p "$sessions"

# --- 4. common step: the shared prompt ---
PROMPT='In this repo, find and fix the failing check in src/auth.ts, add a regression test, run the scoped test, fix the commit message lint failure by committing with a valid message, and write REPORT.md summarizing the root cause.'

# --- 5. per-variant invocation ---
# gate config toggles are applied via PGATE_* env inside scaffolded homes;
# see scaffold.sh for which rules are on/off per variant.

case "$variant" in
  direct)
    # no codemode, no gate; direct Rust tools only
    TOOL_ARGS=("--tools" "+piread,+piedit,+pibash,+pidx" "--exclude-tools" "codemode")
    EXTRA_ENV=()
    ;;
  codemode)
    # codemode available and mandated (AGENTS.md), no gate
    TOOL_ARGS=("--tools" "+codemode")
    EXTRA_ENV=()
    ;;
  codemode-gate)
    # codemode + gate loaded, compliant run
    TOOL_ARGS=("--tools" "+codemode")
    EXTRA_ENV=()
    ;;
  gate-on)
    # direct tools, gate loaded, run stays compliant (all rules respecting)
    TOOL_ARGS=("--tools" "+piread,+piedit,+pibash,+pidx" "--exclude-tools" "codemode")
    EXTRA_ENV=()
    ;;
  gate-block)
    # direct tools, gate loaded, commitlint hook intentionally fires
    TOOL_ARGS=("--tools" "+piread,+piedit,+pibash,+pidx" "--exclude-tools" "codemode")
    EXTRA_ENV=("PGATE_commitMessageLint=1")
    ;;
  *)
    echo "unknown variant: $variant" >&2
    exit 2
    ;;
esac

echo "== run $variant r$rep ==" >&2
echo "  home=$home" >&2
echo "  work=$work" >&2
echo "  sessions=$sessions" >&2

# --- 6. invoke pi headless ---
(
  cd "$work"
  exec env \
    PI_CODING_AGENT_DIR="$home" \
    PI_CODING_AGENT_SESSION_DIR="$sessions" \
    ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
    "$PI_BIN" \
    --provider deepseek \
    --model "$MODEL" \
    --thinking "$THINKING" \
    --mode json \
    "${TOOL_ARGS[@]}" \
    -p "$PROMPT"
)

echo "== done $variant r$rep ==" >&2
