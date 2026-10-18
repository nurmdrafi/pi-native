#!/usr/bin/env bash
# grade.sh — plain-script grader for the token-benchmark task (no LLM).
#
# Usage: grade.sh <run-dir>
#   run-dir is a seeded workspace (<runtime>/runs/<variant>-r<k>/).
#
# Checks, in order:
#   1. scoped test `npm test` passes (both planted bugs fixed),
#   2. REPORT.md exists and names the root cause,
#   3. commitlint passes on HEAD (V4 gate hook parity).
#
# Prints one line per failure; exits 0 only if all checks pass.
set -uo pipefail

run_dir="${1:?usage: grade.sh <run-dir>}"

fail() { echo "FAIL: $1"; }

# 1. tests
if [ ! -f "$run_dir/package.json" ]; then
  fail "package.json missing (not a seeded workspace?)"
  exit 1
fi

cd "$run_dir" || { fail "cannot cd into $run_dir"; exit 1; }

if ! npm test >/tmp/grade-test.log 2>&1; then
  fail "npm test does not pass"
  tail -20 /tmp/grade-test.log
  exit 1
fi

# 2. REPORT.md
if [ ! -f "$run_dir/REPORT.md" ]; then
  fail "REPORT.md missing"
  exit 1
fi

if ! rg -qi "off.by.one|indexOf|lastIndexOf|root cause|generateToken" "$run_dir/REPORT.md"; then
  fail "REPORT.md does not name the root cause"
  exit 1
fi

# 3. commit present with a conventional message (fix|feat|...) scope
#    The gate itself (V4) enforces commitMessageLint during the run; here we only
#    confirm a commit exists and is conventional-form, using the repo's commitlint
#    binary (not the workdir's, which has no node_modules).
if [ -d "$run_dir/.git" ]; then
  msg="$(git -C "$run_dir" log -1 --pretty=%B 2>/dev/null || true)"
  if [ -z "$msg" ]; then
    fail "no commit found"
    exit 1
  fi
  # conventional-commit shape: <type>(<scope>): <subject> or <type>: <subject>
  if ! printf '%s' "$msg" | rg -q '^(build|chore|ci|docs|feat|fix|harness|perf|refactor|release|revert|style|test)(\([^)]*\))?: .+'; then
    fail "commit message is not conventional: $(printf '%s' "$msg" | head -1)"
    exit 1
  fi
fi

echo "PASS"
exit 0
