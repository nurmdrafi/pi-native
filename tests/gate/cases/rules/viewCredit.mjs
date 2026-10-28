// Permission-gate cases for rules.bashViewCredit: the printed lines of a
// single-file view command (head/tail/sed -n N,Mp/cat) in a bash result
// count as a read for span certification (Claude Code parity). SE2 still
// warns — piread stays the preferred reader — but the lines the model saw
// are in context, so an edit anchored on them must not pay a forced re-read.
// Unmappable shapes (pipes, redirects, multi-file operands, error results)
// credit nothing: an edit after them stays on the read requirement.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  runSearch,
  runBash,
  runEdit,
  edit,
  read,
  noteOf,
  tmp,
} from "../../harness/helpers.mjs";

const lines = (n) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const slice = (a, b) =>
  Array.from({ length: b - a + 1 }, (_, i) => `line ${a + i}`).join("\n");
/** the credit claim: the edit passes with NO Unread note — a plain edit()
 * would pass vacuously under the warn-tier AG, note invisible */
const credited = async (pi, f, oldText, newText) => {
  const r = await runEdit(pi, f, [{ oldText, newText }]);
  const note = noteOf(r);
  return !r.blocked && !note.includes("Anchor Guard (Unread):")
    ? { blocked: false }
    : { blocked: true, reason: `no credit: ${note || "(none)"}` };
};

export const cases = [
  [
    "VC: head -n K credits its printed lines for a later edit",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-head.ts");
      writeFileSync(f, `${lines(10)}\n`);
      await runSearch(pi, `head -n 4 ${f}`, lines(4));
      return credited(pi, f, "line 3", "L3");
    },
  ],
  [
    "VC: sed -n 'N,Mp' credits the printed window",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-sed.ts");
      writeFileSync(f, `${lines(10)}\n`);
      await runSearch(pi, `sed -n '5,8p' ${f}`, slice(5, 8));
      return credited(pi, f, "line 7", "L7");
    },
  ],
  [
    "VC: cat credits the whole printed file",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-cat.ts");
      writeFileSync(f, `${lines(6)}\n`);
      await runSearch(pi, `cat ${f}`, lines(6));
      return credited(pi, f, "line 6", "L6");
    },
  ],
  [
    "VC: credited cat blocks the full-cover re-read (R1 parity)",
    "blocked",
    async (pi) => {
      const f = join(tmp, "vc-cat-r1.ts");
      writeFileSync(f, `${lines(6)}\n`);
      await runSearch(pi, `cat ${f}`, lines(6));
      return read(pi, f, { offset: 1, limit: 6 }, { outputLines: 6 });
    },
  ],
  [
    "VC: tail -n K credits the last K lines",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-tail.ts");
      writeFileSync(f, `${lines(10)}\n`);
      await runSearch(pi, `tail -n 3 ${f}`, slice(8, 10));
      return credited(pi, f, "line 10", "L10");
    },
  ],
  [
    "VC: tail -n +N credits from line N",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-tail-plus.ts");
      writeFileSync(f, `${lines(10)}\n`);
      await runSearch(pi, `tail -n +5 ${f}`, slice(5, 10));
      return credited(pi, f, "line 9", "L9");
    },
  ],
  [
    "VC: capped output credits only the visible head",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-cap-pass.ts");
      writeFileSync(f, `${lines(100)}\n`);
      await runSearch(pi, `head -n 100 ${f}`, lines(100)); // H1 keeps 40
      return credited(pi, f, "line 40", "L40");
    },
  ],
  [
    "VC: capped output does not credit past the cap",
    "blocked",
    async (pi) => {
      const f = join(tmp, "vc-cap-block.ts");
      writeFileSync(f, `${lines(100)}\n`);
      await runSearch(pi, `head -n 100 ${f}`, lines(100)); // H1 keeps 40
      const r = await edit(pi, f, [{ oldText: "line 50", newText: "L50" }]);
      // partial coverage turns the miss into a hard editRegionGuard block
      // (region-intersect), unlike the never-read warn above
      return r.blocked && r.reason.startsWith("Anchor Guard (Unread):")
        ? r
        : { blocked: false, reason: `family: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "VC: piped cat credits nothing",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-pipe.ts");
      writeFileSync(f, `${lines(10)}\n`);
      await runSearch(pi, `cat ${f} | wc -l`, "10");
      const r = await runEdit(pi, f, [{ oldText: "line 2", newText: "L2" }]);
      const note = noteOf(r);
      return !r.blocked && note.includes("Anchor Guard (Unread):")
        ? { blocked: false }
        : { blocked: true, reason: `family: ${note || "(none)"}` };
    },
  ],
  [
    "VC: multi-operand head credits nothing",
    "pass",
    async (pi) => {
      const f1 = join(tmp, "vc-multi-1.ts");
      const f2 = join(tmp, "vc-multi-2.ts");
      writeFileSync(f1, `${lines(4)}\n`);
      writeFileSync(f2, `${lines(4)}\n`);
      await runSearch(pi, `head -n 2 ${f1} ${f2}`, lines(2));
      const r = await runEdit(pi, f1, [{ oldText: "line 2", newText: "L2" }]);
      const note = noteOf(r);
      return !r.blocked && note.includes("Anchor Guard (Unread):")
        ? { blocked: false }
        : { blocked: true, reason: `family: ${note || "(none)"}` };
    },
  ],
  [
    "VC: errored view result credits nothing",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-error.ts");
      writeFileSync(f, `${lines(10)}\n`);
      await runSearch(pi, `head -n 2 ${f}`, lines(2), { error: true });
      const r = await runEdit(pi, f, [{ oldText: "line 2", newText: "L2" }]);
      const note = noteOf(r);
      return !r.blocked && note.includes("Anchor Guard (Unread):")
        ? { blocked: false }
        : { blocked: true, reason: `family: ${note || "(none)"}` };
    },
  ],
  [
    "VC: empty view output credits nothing",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-empty-out.ts");
      writeFileSync(f, `${lines(10)}\n`);
      // a view that printed nothing (redirected/quiet path) must not credit
      // its requested window — empty text is not one visible line
      await runSearch(pi, `sed -n '5,8p' ${f}`, "");
      const r = await runEdit(pi, f, [{ oldText: "line 5", newText: "L5" }]);
      const note = noteOf(r);
      return !r.blocked && note.includes("Anchor Guard (Unread):")
        ? { blocked: false }
        : { blocked: true, reason: `family: ${note || "(none)"}` };
    },
  ],
  [
    "VC: SE2 note still rides sed -n while spans are credited",
    "pass",
    async (pi) => {
      const f = join(tmp, "vc-se2.ts");
      writeFileSync(f, `${lines(10)}\n`);
      const r = await runBash(pi, `sed -n '2,3p' ${f}`);
      if (r.blocked || !noteOf(r).includes("Reader-bypass"))
        return { blocked: true, reason: `note: ${noteOf(r) || "(none)"}` };
      return credited(pi, f, "line 2", "L2");
    },
  ],
];
