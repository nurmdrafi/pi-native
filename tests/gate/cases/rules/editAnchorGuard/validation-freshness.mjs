// Permission-gate cases for rules.editAnchorGuard.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, rc, lineText, read, edit, editApplied, editsApplied, bash, runBash, write, approveUi, compact, tmp, fileA, fileB, elidedReadC3, nextId, getHydT, setHydT } from "../../../harness/helpers.mjs";

export const cases = [
  [
    "S5 W: external write since last read blocks the write (Stale)",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-w-stale.ts");
      writeFileSync(f, "a\nb\n");
      await read(pi, f);
      writeFileSync(f, "a\nb\nc\n"); // external change (stat)
      const r = await write(pi, f, "overwritten\n");
      return r.blocked && r.reason.startsWith("Anchor Guard (Stale):")
        ? r
        : { blocked: false, reason: `family: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 W: re-read clears the stale block for write",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-w-reread.ts");
      writeFileSync(f, "a\nb\n");
      await read(pi, f);
      writeFileSync(f, "a\nb\nc\n");
      const b1 = await write(pi, f, "overwritten\n");
      if (!b1.blocked) return { blocked: false, reason: "precondition: stale block missing" };
      await read(pi, f);
      return write(pi, f, "overwritten\n", { apply: true });
    },
  ],
  [
    "S5 W: never-read existing file blocks the write (Unread)",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-w-unread.ts");
      writeFileSync(f, "existing content\n");
      const r = await write(pi, f, "blind overwrite\n");
      return r.blocked && r.reason.startsWith("Anchor Guard (Unread):") && r.reason.includes("never read")
        ? r
        : { blocked: false, reason: `family: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 W: new file (ENOENT) passes",
    "pass",
    async (pi) => write(pi, join(tmp, "s5-w-new.ts"), "fresh\n"),
  ],
  [
    "S5 W: externally deleted file passes (create-new)",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-w-deleted.ts");
      writeFileSync(f, "a\n");
      await read(pi, f);
      rmSync(f);
      return write(pi, f, "recreated\n", { apply: true });
    },
  ],
  [
    "S5 W: plain read stays stat-only for write too (R2)",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-w-r2.ts");
      const T = new Date(Math.floor(Date.now() / 1000) * 1000);
      writeFileSync(f, "a\nb\n");
      utimesSync(f, T, T);
      await read(pi, f);
      writeFileSync(f, "x\nb\n"); // same-size silent change, stat restored
      utimesSync(f, T, T);
      return write(pi, f, "overwritten\n", { apply: true });
    },
  ],
  [
    "S5 W: own prior write chains the hash — same-stat drift blocks (M3)",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-w-hash.ts");
      writeFileSync(f, "a\nb\n");
      await read(pi, f);
      const T = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);
      const w1 = await write(pi, f, "n1\nn2\n", { apply: true, T }); // stores post-op stat+hash
      if (w1.blocked) return w1;
      writeFileSync(f, "n1\nn3\n"); // same-size silent change
      utimesSync(f, T, T); // stat identical to the post-write snapshot
      const r = await write(pi, f, "overwritten\n");
      return r.blocked && r.reason.includes("without mtime/size change")
        ? r
        : { blocked: false, reason: `family: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 W: own prior write — a later write with no drift passes",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-w-own.ts");
      writeFileSync(f, "a\nb\n");
      await read(pi, f);
      const w1 = await write(pi, f, "n1\nn2\n", { apply: true });
      if (w1.blocked) return w1;
      return write(pi, f, "final\n", { apply: true });
    },
  ],

  // Step 6 (families 6–7): D4 multi-match lock-ins + policy-order
  // regressions (spec §5.4, §9.6–7) — lock-ins only, no rule change
];
