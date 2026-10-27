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
  // ---- Anchor Guard (existence / uniqueness / overlap) ----
  [
    "anchor not found is blocked",
    "blocked",
    async (pi) => edit(pi, fileA, [{ oldText: "zzz", newText: "y" }]),
  ],
  [
    "anchor-not-found names the line count, not 'head'/'tail'",
    "blocked",
    async (pi) => {
      // The hint said "Its head lines occur at line N" — frag.end is the match
      // end ("head"|"tail"), not a count. It must name how many lines matched.
      const r = await edit(pi, fileA, [
        { oldText: "a\nb\nZZZ", newText: "y" },
      ]);
      if (!r.blocked) return r;
      const bad = /Its (head|tail) lines occur/.test(r.reason);
      return bad ? { blocked: false, reason: r.reason } : r;
    },
  ],
  [
    "non-unique anchor is blocked with line numbers",
    "blocked",
    async (pi) => edit(pi, fileB, [{ oldText: "x", newText: "y" }]),
  ],
  [
    "intra-call overlapping anchors are blocked",
    "blocked",
    async (pi) =>
      edit(pi, fileA, [
        { oldText: "a\nb", newText: "q" },
        { oldText: "b\nc", newText: "r" },
      ]),
  ],
];
