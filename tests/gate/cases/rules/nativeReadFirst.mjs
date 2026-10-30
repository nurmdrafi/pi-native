// Permission-gate cases for rules.nativeReadFirst.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { read, piread, tmp, fileA } from "../../harness/helpers.mjs";

export const cases = [
  // ---- P1 (2026-10-15 audit): piread-first for text files ----
  [
    "P1: built-in read of a text file is blocked (piread-first)",
    "blocked",
    async (pi) => {
      const r = await read(
        pi,
        fileA,
        { offset: 1, limit: 5 },
        { outputLines: 5, tool: "read" },
      );
      return r.blocked && r.reason.startsWith("Token Economy (Piread-first)")
        ? r
        : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
    },
  ],
  [
    "P1: built-in read of an image passes",
    "pass",
    async (pi) =>
      read(pi, join(tmp, "shot.png"), {}, { image: true, tool: "read" }),
  ],
  [
    "P1: piread of a text file passes",
    "pass",
    async (pi) => piread(pi, fileA, { offset: 1, limit: 5 }, { outputLines: 5 }),
  ],
  [
    "P1: piread of an image path passes (delegates internally)",
    "pass",
    async (pi) => piread(pi, join(tmp, "shot.png"), {}, { outputLines: 3, totalLines: 3 }),
  ],
  [
    "P1: built-in read is blocked regardless of the retired PI_NATIVE_READ switch",
    "blocked",
    async (pi) => {
      const prev = process.env.PI_NATIVE_READ;
      process.env.PI_NATIVE_READ = "0";
      try {
        const r = await read(pi, fileA, { offset: 1, limit: 5 }, { outputLines: 5, tool: "read" });
        return r.blocked && r.reason.startsWith("Token Economy (Piread-first)")
          ? r
          : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
      } finally {
        if (prev === undefined) delete process.env.PI_NATIVE_READ;
        else process.env.PI_NATIVE_READ = prev;
      }
    },
  ],

];
