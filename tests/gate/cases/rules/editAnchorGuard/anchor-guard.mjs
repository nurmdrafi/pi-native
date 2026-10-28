// Permission-gate cases for rules.editAnchorGuard.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, rc, lineText, read, edit, runEdit, noteOf, editApplied, editsApplied, bash, runBash, write, approveUi, compact, tmp, fileA, fileB, elidedReadC3, nextId, getHydT, setHydT } from "../../../harness/helpers.mjs";

export const cases = [
  // ---- Anchor Guard (existence / uniqueness / overlap) — warn since the
  // 2026-10-28 demotion: the edit pipeline enforces oldText correctness, so
  // AG teaches via a note riding the edit's own tool_result. ----
  [
    "anchor not found warns without blocking",
    "pass",
    async (pi) => {
      const r = await runEdit(pi, fileA, [{ oldText: "zzz", newText: "y" }]);
      const note = noteOf(r);
      return !r.blocked && note.includes("Anchor Guard")
        ? { blocked: false }
        : { blocked: true, reason: `note: ${note || r.reason || "(none)"}` };
    },
  ],
  [
    "anchor-not-found note names the line count, not 'head'/'tail'",
    "pass",
    async (pi) => {
      // The hint said "Its head lines occur at line N" — frag.end is the match
      // end ("head"|"tail"), not a count. It must name how many lines matched.
      const r = await runEdit(pi, fileA, [
        { oldText: "a\nb\nZZZ", newText: "y" },
      ]);
      const note = noteOf(r);
      return !r.blocked &&
        note.includes("Anchor Guard") &&
        !/Its (head|tail) lines occur/.test(note)
        ? { blocked: false }
        : { blocked: true, reason: `note: ${note || r.reason || "(none)"}` };
    },
  ],
  [
    "non-unique anchor warns with line numbers",
    "pass",
    async (pi) => {
      const r = await runEdit(pi, fileB, [{ oldText: "x", newText: "y" }]);
      const note = noteOf(r);
      return !r.blocked && /lines \d+(, \d+)+/.test(note)
        ? { blocked: false }
        : { blocked: true, reason: `note: ${note || "(none)"}` };
    },
  ],
  [
    "intra-call overlapping anchors warn without blocking",
    "pass",
    async (pi) => {
      const r = await runEdit(pi, fileA, [
        { oldText: "a\nb", newText: "q" },
        { oldText: "b\nc", newText: "r" },
      ]);
      const note = noteOf(r);
      return !r.blocked && note.includes("overlap")
        ? { blocked: false }
        : { blocked: true, reason: `note: ${note || "(none)"}` };
    },
  ],
];
