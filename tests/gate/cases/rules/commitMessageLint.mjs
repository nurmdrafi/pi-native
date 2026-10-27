// Permission-gate cases for rules.commitMessageLint.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { bash } from "../../harness/helpers.mjs";

export const cases = [
  // ---- R9 commitlint ----
  [
    "non-conventional commit message is blocked",
    "blocked",
    async (pi) => bash(pi, 'git commit -m "Fix the thing"'),
  ],
  // ---- commitlint B12/B13/B21 fixes (2026-10-08) ----
  [
    "commitlint: -am combined flag is validated",
    "blocked",
    async (pi) => bash(pi, 'git commit -am "Add stuff"'),
  ],
  [
    'commitlint: -m"x" attached form is validated',
    "blocked",
    async (pi) => bash(pi, 'git commit -m"x"'),
  ],
  [
    "commitlint: --message=y form is validated",
    "blocked",
    async (pi) => bash(pi, "git commit --message=y"),
  ],
  [
    "commitlint: global git flags do not hide the subcommand (H4-lite)",
    "blocked",
    async (pi) => bash(pi, 'git -C x commit -m "Bad msg"'),
  ],
  [
    "commitlint: conventional commit under -C passes (H4-lite)",
    "pass",
    async (pi) => bash(pi, 'git -C x commit -m "fix: cap output"'),
  ],
  [
    "commitlint: acronym subject passes (B13)",
    "pass",
    async (pi) => bash(pi, 'git commit -m "fix: API timeout"'),
  ],
  [
    "commitlint: all-caps subject still blocked",
    "blocked",
    async (pi) => bash(pi, 'git commit -m "fix: API TIMEOUT"'),
  ],
  [
    "commitlint: start-case subject still blocked",
    "blocked",
    async (pi) => bash(pi, 'git commit -m "fix: Fix The Timeout"'),
  ],
  [
    "commitlint: \\n in message is a newline, header = first line (B21)",
    "pass",
    async (pi) => bash(pi, 'git commit -m "fix: a\\nb c"'),
  ],
];
