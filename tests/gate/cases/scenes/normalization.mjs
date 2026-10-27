// Permission-gate cases for rules.cross-rule (multi-rule scenes).
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, textBlocks, read, edit, bash, runBash, runSearch, nestedBash, write, approveUi, denyUi, compact, tmp, fileA, fileInj, spanFile, hitRoot, hitApi, hugeFile, canary, stopCanary, canaryIntact, HARD_NET, gatedExec, canaryBlocked, nextId } from "../../harness/helpers.mjs";

export const cases = [
  // ---- unquoted backslash escapes (2026-10-07: 'foo\|bar' / '1p\;5p' split the same as the quoted bugs) ----
  [
    "escaped-pipe bases do not collide R10",
    "pass",
    async (pi) => bash(pi, "rg -o foo\\|bar data.log | head -5"),
  ],
  [
    "identical escaped-pipe command still blocked",
    "pass",
    async (pi) => bash(pi, "rg -o foo\\|bar data.log | head -5"),
  ],
  [
    "escaped semicolon keeps sed batch intact",
    "pass",
    async (pi) => bash(pi, "sed -n 1p\\;5p notes.md"),
  ],
  // ---- 2026-10-11 review: item 1 — shared env/git-flag normalization ----
  // 2026-10-11: git commit/push removed from the destructive set (user
  // direction — commitlint R9 + hooks still guard commits), so reset --hard
  // stands in for the normalization cases
  [
    "destructive: git -C . reset --hard confirms (normalized)",
    "blocked",
    async (pi) => bash(pi, "git -C . reset --hard HEAD~1", denyUi()),
  ],
  [
    "destructive: env-prefixed git --no-pager reset --hard confirms",
    "blocked",
    async (pi) =>
      bash(pi, "GIT_PAGER=0 git --no-pager reset --hard", denyUi()),
  ],
  [
    "non-destructive: git -C . log passes",
    "pass",
    async (pi) => bash(pi, "git -C . log --oneline"),
  ],
  [
    "non-destructive: git push passes without confirm (removed 2026-10-11)",
    "pass",
    async (pi) => bash(pi, "git push", denyUi()),
  ],
  [
    "non-destructive: conventional git commit passes without confirm",
    "pass",
    async (pi) => bash(pi, 'git commit -m "fix: no confirm"', denyUi()),
  ],
  // ---- item 13 — normPath parity with pi ----
  [
    "normPath: @-prefixed path keys like the absolute path",
    "blocked",
    async (pi) => {
      await read(pi, fileA, { offset: 1, limit: 3 }, { outputLines: 3 });
      return read(pi, `@${fileA}`, { offset: 1, limit: 2 }, { outputLines: 2 });
    },
  ],
  [
    "normPath: ~ path expands to the same coverage key",
    "blocked",
    async (pi) => {
      const f = join(tmp, "tilde.ts");
      writeFileSync(f, "t1\nt2\n");
      await read(pi, f, { offset: 1, limit: 2 }, { outputLines: 2 });
      const prev = process.env.HOME;
      process.env.HOME = tmp;
      try {
        return await read(
          pi,
          "~/tilde.ts",
          { offset: 1, limit: 1 },
          { outputLines: 1 },
        );
      } finally {
        process.env.HOME = prev;
      }
    },
  ],
  [
    "normPath: relative path resolves against ctx.cwd",
    "blocked",
    async (pi) => {
      await read(pi, fileA, { offset: 1, limit: 3 }, { outputLines: 3 });
      const block = await pi.invoke(
        "tool_call",
        {
          type: "tool_call",
          toolName: "read",
          toolCallId: `cw${nextId()}`,
          input: { path: "a.ts", offset: 1, limit: 2 },
        },
        { cwd: tmp },
      );
      return block
        ? { blocked: true, reason: block.reason }
        : { blocked: false };
    },
  ],
];
