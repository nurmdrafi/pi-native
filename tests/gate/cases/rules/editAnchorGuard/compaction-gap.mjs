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
  // ---- C2/C3 (2026-10-27): the compaction dead-zone — a gap-anchored edit
  // blocks with a sanctioned sub-window remedy, never a rule deadlock ----
  [
    "C2/C3: gap-anchored edit blocks with the sanctioned sub-window remedy",
    "blocked",
    async (pi) => {
      const f = join(tmp, "r1c3.ts");
      writeFileSync(f, lineText(300));
      const read1 = await elidedReadC3(pi, f);
      if (read1.blocked) return read1;
      const got = await edit(pi, f, [
        { oldText: "line 255", newText: "line 255 edited" },
      ]);
      if (!got.blocked)
        throw new Error("gap-anchored edit must block (uncertified anchor)");
      if (!/^Anchor Guard \(Unread\)/.test(got.reason))
        throw new Error(`wrong reason class: ${got.reason}`);
      if (!/read lines 255–255 .*permitted/.test(got.reason))
        throw new Error(`remedy must sanction the sub-window read: ${got.reason}`);
      return got;
    },
  ],
  [
    "C2/C3: full cycle — gap block, remedy sub-read (not a re-read), edit passes",
    "pass",
    async (pi) => {
      const f = join(tmp, "r1c3-cycle.ts");
      writeFileSync(f, lineText(300));
      const read1 = await elidedReadC3(pi, f);
      if (read1.blocked) return read1;
      const blocked = await edit(pi, f, [
        { oldText: "line 255", newText: "line 255 edited" },
      ]);
      if (!blocked.blocked)
        throw new Error("gap-anchored edit must block before the remedy read");
      const remedy = await read(pi, f, { offset: 255, limit: 1 }, { outputLines: 1 });
      if (remedy.blocked)
        throw new Error(`remedy sub-read must not be a re-read: ${remedy.reason}`);
      return editsApplied(pi, f, [
        { oldText: "line 255", newText: "line 255 edited" },
      ]);
    },
  ],
  [
    "C2/C3: twin — edit anchored in the rendered head still passes",
    "pass",
    async (pi) => {
      const f = join(tmp, "r1c3-head.ts");
      writeFileSync(f, lineText(300));
      const read1 = await elidedReadC3(pi, f);
      if (read1.blocked) return read1;
      return editsApplied(pi, f, [
        { oldText: "line 230", newText: "line 230 edited" },
      ]);
    },
  ],
  [
    "C2/C3: multi-edit — one block names only the gap anchor; one remedy read unblocks all",
    "pass",
    async (pi) => {
      const f = join(tmp, "r1c3-multi.ts");
      writeFileSync(f, lineText(300));
      const read1 = await elidedReadC3(pi, f);
      if (read1.blocked) return read1;
      const edits = [
        { oldText: "line 230", newText: "line 230 edited" },
        { oldText: "line 255", newText: "line 255 edited" },
      ];
      const got = await edit(pi, f, edits);
      if (!got.blocked) throw new Error("multi-edit with a gap anchor must block");
      if (!/edits\[1\] targets lines 255–255/.test(got.reason))
        throw new Error(`block must name the gap anchor: ${got.reason}`);
      if (/edits\[0\]/.test(got.reason))
        throw new Error(`head anchor must not be flagged: ${got.reason}`);
      const remedy = await read(pi, f, { offset: 255, limit: 1 }, { outputLines: 1 });
      if (remedy.blocked)
        throw new Error(`remedy sub-read must not be a re-read: ${remedy.reason}`);
      return editsApplied(pi, f, edits);
    },
  ],
];
