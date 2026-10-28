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
  [
    "S5 D4: mixed exact+fuzzy call drops coverage (binding side lock-in)",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-d4-mixed.ts");
      writeFileSync(f, "aaa\nbbb \nccc\n"); // trailing space on line 2
      await read(pi, f, {}, { outputLines: 3, totalLines: 3 });
      // edit[0] exact "aaa" (region covered); edit[1] exact-miss → fuzzy hit
      const e = await edit(pi, f, [
        { oldText: "aaa", newText: "A" },
        { oldText: "bbb\nccc", newText: "B" },
      ]);
      if (e.blocked) return e;
      // any fuzzy anchor in the call → tool_result drops the path's coverage
      // (existing behavior): the re-read of any window must be allowed
      return read(pi, f, { offset: 1, limit: 3 }, { outputLines: 3 });
    },
  ],
  [
    "S5 D4: exact anchor with a fuzzy-only twin elsewhere is allowed",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-d4-twin.ts");
      // exact "dup\nmid" once; near-twin differs only by trailing ws —
      // blocking exact matches that merely have fuzzy twins adds friction
      // for no demonstrated failure (spec §5.4 YAGNI decision)
      writeFileSync(f, "dup\nmid\ndup \n");
      await read(pi, f, {}, { outputLines: 3, totalLines: 3 });
      return edit(pi, f, [{ oldText: "dup\nmid", newText: "D\nmid" }]);
    },
  ],
  [
    "S5 D4: exact multi-match still warns with line numbers",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-d4-multi.ts");
      writeFileSync(f, "same\nx\nsame\n");
      await read(pi, f);
      const r = await runEdit(pi, f, [{ oldText: "same", newText: "S" }]);
      const note = noteOf(r);
      return !r.blocked && note.includes("lines 1, 3")
        ? { blocked: false }
        : { blocked: true, reason: `lines: ${note || "(none)"}` };
    },
  ],
];
