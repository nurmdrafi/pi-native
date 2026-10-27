// Permission-gate cases for rules.largeReadGuard.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { read, piread, runBash, hugeFile, midFile } from "../../harness/helpers.mjs";

export const cases = [
  // ---- R1b + cadence (2026-10-10 session audit) ----
  [
    "R1b: whole read of a >24KB file is blocked with targeted-window reason",
    "pass",
    async (pi) => read(pi, hugeFile),
  ],
  [
    "R1b: wide window (>=500 lines) on a >24KB file is blocked",
    "blocked",
    async (pi) => read(pi, hugeFile, { offset: 1, limit: 600 }),
  ],
  [
    "R1b: narrow window on a >24KB file passes",
    "pass",
    async (pi) => {
      // R1b's own premise: a sub-BIG_READ_WIN request is not whole-file-ish.
      // The window is 200 lines, so R1c wants it located first.
      await runBash(pi, `rg -n xxxxx ${hugeFile}`);
      return read(pi, hugeFile, { offset: 10, limit: 200 }, { outputLines: 200 });
    },
  ],
  [
    "R1b: whole read of a 10–24KB file is blocked (piread would elide its middle)",
    "pass",
    async (pi) => read(pi, midFile),
  ],
];
