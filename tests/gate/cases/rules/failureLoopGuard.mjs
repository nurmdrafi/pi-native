// Permission-gate cases for rules.failureLoopGuard.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { read, edit, editApplied, bash, runBash } from "../../harness/helpers.mjs";

export const cases = [
  // ---- R11 failure-loop escalation (2026-10-27): consecutive failures with no
  // landed fix are the circling pattern AGENTS.md forbids. Escalation is gated on
  // mutationSeq so red-green-refactor (edit between failures) never arms it. ----
  [
    "R11: 5 consecutive failures with no landed fix block the next shell call",
    "blocked",
    async (pi) => {
      for (let i = 1; i <= 5; i++)
        await runBash(pi, `npx vitest run suite${i}`, { error: true });
      return bash(pi, "npx vitest run suite6");
    },
  ],
  [
    "R11: TDD failures interleaved with landed edits never block",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "r11-tdd-"));
      const f = join(dir, "tdd.md");
      writeFileSync(f, "A1\nA2\nA3\nA4\nA5\n");
      await read(pi, f);
      for (let i = 1; i <= 5; i++) {
        await runBash(pi, `npx vitest run tdd${i}`, { error: true });
        const r = await editApplied(pi, f, `A${i}`, `A${i}x`);
        if (r.blocked)
          return { blocked: true, reason: `edit must pass: ${r.reason.slice(0, 60)}` };
      }
      return bash(pi, "npx vitest run tddfinal");
    },
  ],
  [
    "R11: 4 consecutive failures stay below the threshold",
    "pass",
    async (pi) => {
      for (let i = 1; i <= 4; i++)
        await runBash(pi, `npx vitest run sub${i}`, { error: true });
      return bash(pi, "npx vitest run sub5");
    },
  ],
];
