// Permission-gate cases for rules.rerunGuard.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { edit, bash, runBash, approveUi, tmp } from "../../harness/helpers.mjs";

export const cases = [
  // ---- R10: identical re-run guard ----
  [
    "identical bash re-run (no edit since) is blocked",
    "pass",
    async (pi) => bash(pi, "gh run list --limit 3"),
  ],
  [
    "bash re-run after an intervening edit passes",
    "pass",
    async (pi) =>
      bash(pi, 'npx vitest run f.test.tsx 2>&1 | rg "Tests" | head -15'),
  ],
  [
    "re-run with a different pipe cap passes",
    "pass",
    async (pi) =>
      bash(pi, 'npx vitest run f.test.tsx 2>&1 | rg "Tests" | head -12'),
  ], // 2026-10-07: full-command keying — a changed filter is a legitimate re-view, not a dup
  [
    "whitespace-only variation still blocked",
    "pass",
    async (pi) => bash(pi, "gh  run list --limit 3"),
  ],
  [
    "shared nvm preamble does not collide R10 keys",
    "pass",
    async (pi) =>
      bash(
        pi,
        "source ~/.nvm/nvm.sh && nvm use 22.17.0 >/dev/null 2>&1 && pnpm run check-types 2>&1 | tail -5",
      ),
  ],
  [
    "identical compound with watcher word is exempt",
    "pass",
    async (pi) => bash(pi, "sleep 1; rm -f /tmp/x"),
  ],
  // ---- B20/H5 (2026-10-08): mutating bash commands legitimize verify re-runs ----
  [
    "re-run after git pull is legitimate (B20/H5)",
    "pass",
    async (pi) => {
      await runBash(pi, "npm test 2>&1 | tail -5");
      await runBash(pi, "git pull");
      return bash(pi, "npm test 2>&1 | tail -5");
    },
  ],
  [
    "re-run after a non-mutating command still blocks",
    "pass",
    async (pi) => {
      await runBash(pi, "gh run list --limit 3");
      await runBash(pi, "git status");
      return bash(pi, "gh run list --limit 3");
    },
  ],
  [
    "failed mutating command does not legitimize re-run",
    "pass",
    async (pi) => {
      await runBash(pi, "gh run list --limit 3");
      await runBash(pi, "git pull", { error: true });
      return bash(pi, "gh run list --limit 3");
    },
  ],
  // ---- R10 quote-aware base (2026-10-06: a quoted '|' must not truncate the base) ----
  [
    "quoted pattern pipes do not collide R10 bases",
    "pass",
    async (pi) => bash(pi, "rg -o '(Alpha|Gamma)' data.log | head -5"),
  ],
  [
    "identical quoted-pattern command still blocked",
    "pass",
    async (pi) => bash(pi, "rg -o '(Alpha|Beta)' data.log | head -5"),
  ],
  // ---- item 7 — MUTATING_BASH extensions ----
  [
    "B20: re-run after git -C . pull is legitimate (normalized)",
    "pass",
    async (pi) => {
      await runBash(pi, "npm test 2>&1 | tail -5");
      await runBash(pi, "git -C . pull", { ctx: approveUi() });
      return bash(pi, "npm test 2>&1 | tail -5");
    },
  ],
  [
    "B20: re-run after npm ci is legitimate",
    "pass",
    async (pi) => {
      await runBash(pi, "npm test");
      await runBash(pi, "npm ci", { ctx: approveUi() });
      return bash(pi, "npm test");
    },
  ],
  [
    "B20: re-run after touch/mkdir is legitimate",
    "pass",
    async (pi) => {
      await runBash(pi, "npm test");
      await runBash(pi, "touch a.txt; mkdir d");
      return bash(pi, "npm test");
    },
  ],
  [
    "B20: successful mutating push legitimize re-runs",
    "pass",
    async (pi) => {
      await runBash(pi, "npm test");
      await runBash(pi, "git push", { ctx: approveUi() });
      return bash(pi, "npm test");
    },
  ],
];
