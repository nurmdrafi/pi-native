#!/usr/bin/env bash
# scaffold.sh — build one isolated pi-home copy from the repo agent directory.
#
# Usage: scaffold.sh <variant>
#
# Copies the repo working tree (no .git, no caches, no sessions, no bench/) into
# <runtime>/pi-homes/<variant>/, then applies the per-variant policy edits:
#   - settings.json  defaultTools / codemode on-off
#   - AGENTS.md      one policy line (direct vs codemode mandate)
#   - permission-gate config rules (gate-on vs gate-block vs off)
set -euo pipefail

variant="${1:?usage: scaffold.sh <variant>}"
# Harness (tracked) lives in the repo; runtime artifacts live OUTSIDE the repo.
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$HARNESS_DIR/../.." && pwd)"
RUNTIME_DIR="${BENCH_RUNTIME_DIR:-$HOME/.pi/bench}"
home="$RUNTIME_DIR/pi-homes/$variant"

echo "== scaffold pi-home: $variant ==" >&2
rm -rf "$home"
mkdir -p "$home"

rsync -a \
  --exclude='.git' \
  --exclude='/sessions' \
  --exclude='/bench' \
  --exclude='/benchmark' \
  --exclude='/audit-reports' \
  --exclude='/logs' \
  --exclude='/tmp' \
  --exclude='/target' \
  --exclude='/.cache' \
  --exclude='/handoff' \
  --exclude='/.auto' \
  "$REPO_DIR/" "$home/"

# node_modules is required by extensions; rsync included it above.

# Benchmark task authorization — makes the task self-authorizing under every
# variant's tool policy. Without this, the repo's "ask and wait" / "no unprompted
# commits" rules make the headless task look out-of-scope and the agent bails
# (a confound, not gate behavior). Appended uniformly to all variants.
cat >> "$home/AGENTS.md" <<'BENCH_EOF'

## Benchmark Task (applies for this run only)
You are running a headless, non-interactive benchmark. The prompt is the complete
specification of scope; do not ask clarifying questions, do not wait for approval.
You are authorized to: edit src/auth.ts and src/auth.test.ts, run tests, create
REPORT.md, and commit with a valid conventional message. Proceed autonomously to
completion. All other project rules remain in force, including permission-gate.
BENCH_EOF

# Now apply per-variant policy edits.

settings="$home/settings.json"
agents="$home/AGENTS.md"
gatecfg="$home/extensions/permission-gate/config.json"

case "$variant" in
  direct)
    # direct Rust tools only; codemode off; no gate
    node -e '
      const fs=require("fs");
      const p=process.argv[1];
      const s=JSON.parse(fs.readFileSync(p,"utf8"));
      s.defaultTools = ["-read","-bash","-edit","-write"];
      s.codemode = { mode:"off", inlineBudget:0 };
      fs.writeFileSync(p, JSON.stringify(s,null,2)+"\n");
    ' "$settings"
    # disable permission-gate rules (gate effectively off)
    node -e '
      const fs=require("fs");
      const p=process.argv[1];
      const c=JSON.parse(fs.readFileSync(p,"utf8"));
      for (const k in c.rules) c.rules[k]=false;
      fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
    ' "$gatecfg"
    ;;
  codemode)
    # codemode mandated; no gate
    node -e '
      const fs=require("fs");
      const p=process.argv[1];
      const s=JSON.parse(fs.readFileSync(p,"utf8"));
      s.defaultTools = ["-read","-bash","-edit","+codemode"];
      s.codemode = { mode:"on", inlineBudget:0 };
      fs.writeFileSync(p, JSON.stringify(s,null,2)+"\n");
    ' "$settings"
    node -e '
      const fs=require("fs");
      const p=process.argv[1];
      const c=JSON.parse(fs.readFileSync(p,"utf8"));
      for (const k in c.rules) c.rules[k]=false;
      fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
    ' "$gatecfg"
    ;;
  codemode-gate)
    # codemode mandated + gate loaded, compliant run
    node -e '
      const fs=require("fs");
      const p=process.argv[1];
      const s=JSON.parse(fs.readFileSync(p,"utf8"));
      s.defaultTools = ["-read","-bash","-edit","+codemode"];
      s.codemode = { mode:"on", inlineBudget:0 };
      fs.writeFileSync(p, JSON.stringify(s,null,2)+"\n");
    ' "$settings"
    # gate rules already true in source config; leave as-is
    ;;
  gate-on)
    # direct tools, gate loaded, compliant run
    node -e '
      const fs=require("fs");
      const p=process.argv[1];
      const s=JSON.parse(fs.readFileSync(p,"utf8"));
      s.defaultTools = ["-read","-bash","-edit","-write"];
      s.codemode = { mode:"off", inlineBudget:0 };
      fs.writeFileSync(p, JSON.stringify(s,null,2)+"\n");
    ' "$settings"
    # gate rules already true in source config; leave as-is
    ;;
  gate-block)
    # direct tools, gate loaded, commitlint hook fires
    node -e '
      const fs=require("fs");
      const p=process.argv[1];
      const s=JSON.parse(fs.readFileSync(p,"utf8"));
      s.defaultTools = ["-read","-bash","-edit","-write"];
      s.codemode = { mode:"off", inlineBudget:0 };
      fs.writeFileSync(p, JSON.stringify(s,null,2)+"\n");
    ' "$settings"
    # ensure commitMessageLint is ON (already true), and leave the rest default
    node -e '
      const fs=require("fs");
      const p=process.argv[1];
      const c=JSON.parse(fs.readFileSync(p,"utf8"));
      c.rules.commitMessageLint = true;
      fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
    ' "$gatecfg"
    ;;
  *)
    echo "unknown variant: $variant" >&2
    exit 2
    ;;
esac

echo "  pi-home ready: $home" >&2
