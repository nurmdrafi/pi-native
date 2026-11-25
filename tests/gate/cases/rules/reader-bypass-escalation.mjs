// Phase 3 (audit A4/A8/A15): block/warn messages teach the compliant route,
// jq single-file reads get a size bound, and a warn family ignored three
// times in one session escalates to a block.
import { writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bash, runBash, noteOf, tmp } from "../../harness/helpers.mjs";

/** passes with the SE2 note carrying `needle`; anything else reports blocked */
const notedBy = (r, ...needles) =>
  !r.blocked && needles.every((n) => noteOf(r).includes(n))
    ? r
    : { blocked: true, reason: `note: ${noteOf(r) || "(none)"}` };

export const cases = [
  [
    "P3: SE2 note carries the pipe/composition recipe (spill + jq)",
    "pass",
    async (pi) => notedBy(await runBash(pi, "cat ~/.pi/agent/package.json"), "spill", "jq"),
  ],
  [
    "P3: jq single small file stays allowed",
    "pass",
    async (pi) => bash(pi, "jq -r '.name' ~/.pi/agent/package.json"),
  ],
  [
    "P3: jq single file over the bound is flagged with the bound named",
    "pass",
    async (pi) => {
      const big = join(tmp, "p3-big.json");
      writeFileSync(big, '{"x":"' + "a".repeat(1_100_000) + '"}');
      const r = await runBash(pi, `jq -r '.x' ${big}`);
      return notedBy(r, "Reader-bypass", "1 MB");
    },
  ],
  [
    "P3: 3rd reader-bypass warn in a session escalates to a block",
    "blocked",
    async (pi) => {
      const r1 = await runBash(pi, "cat ~/.pi/agent/package.json");
      if (r1.blocked) return { blocked: false, reason: "1st read already blocked (precondition)" };
      const r2 = await runBash(pi, "head -3 ~/.pi/agent/README.md");
      if (r2.blocked) return { blocked: false, reason: "2nd read already blocked (precondition)" };
      const r3 = await runBash(pi, "tail -5 ~/.pi/agent/CHANGELOG.md");
      return r3.blocked && /3rd|session/.test(r3.reason)
        ? { blocked: true, reason: r3.reason }
        : { blocked: false, reason: `3rd read not escalated: ${r3.blocked ? r3.reason : "passed"}` };
    },
  ],
  [
    "P3: escalation resets at session_start",
    "pass",
    async (pi) => {
      await runBash(pi, "cat ~/.pi/agent/package.json");
      await runBash(pi, "head -3 ~/.pi/agent/README.md");
      const r3 = await runBash(pi, "tail -5 ~/.pi/agent/CHANGELOG.md");
      if (!r3.blocked) return { blocked: true, reason: "precondition: 3rd read must escalate" };
      await pi.invoke("session_start", { type: "session_start", reason: "new" });
      const r4 = await runBash(pi, "sed -n '1,3p' ~/.pi/agent/AGENTS.md");
      return r4.blocked
        ? { blocked: true, reason: `escalation survived session_start: ${r4.reason.slice(0, 80)}` }
        : r4;
    },
  ],
  [
    "P3: SS2 note carries the dash-path hint",
    "pass",
    async (pi) => notedBy(await runBash(pi, "ls | grep -i json"), "Search (rg-first)", "./"),
  ],
  [
    "P3: SS3 note carries the dash-path hint",
    "pass",
    async (pi) => notedBy(await runBash(pi, "find src -name '*.ts'"), "Search (fd-first)", "./"),
  ],
  // ---- Phase 5 T5.1 (audit AB-4): the heavy-session reader shape is many
  // command-position single-file `cat` views. The A8 counter contract holds
  // for that shape too — warns carry the recipe twice, the 3rd distinct
  // command-position reader blocks — and pipeline trims (| head, | rg) are
  // exempt by design (search-guard.ts headTailReadsFile): they filter output
  // a command already produced, so they stay free AND never count.
  [
    "AB4: 3rd command-position cat file view in one session escalates to a block",
    "blocked",
    async (pi) => {
      // distinct files so R10 (re-run guard) cannot absorb the repeats
      const views = ["a", "b", "c"].map((n) => {
        const f = join(tmp, `ab4-${n}.log`);
        writeFileSync(f, `log line\n`.repeat(20));
        return f;
      });
      const r1 = await runBash(pi, `cat ${views[0]}`);
      if (r1.blocked) return { blocked: false, reason: "1st cat view already blocked (precondition)" };
      if (!noteOf(r1).includes("Reader-bypass"))
        return { blocked: false, reason: "1st cat view carried no Reader-bypass recipe warn" };
      const r2 = await runBash(pi, `cat ${views[1]}`);
      if (r2.blocked) return { blocked: false, reason: "2nd cat view already blocked (precondition)" };
      const r3 = await runBash(pi, `cat ${views[2]}`);
      return r3.blocked && /3rd|session/.test(r3.reason)
        ? { blocked: true, reason: r3.reason }
        : { blocked: false, reason: `3rd cat view not escalated: ${r3.blocked ? r3.reason : "passed"}` };
    },
  ],
  [
    "AB4: pipeline trims (| head, | rg) stay free and never count as reader bypass",
    "pass",
    async (pi) => {
      const trims = [
        "npm test | head -40",
        "node --test tests/gate/runner.test.mjs | tail -20",
        "npm test | rg FAIL",
        "git log --oneline -5 | head -3",
      ];
      const notes = [];
      for (const cmd of trims) {
        const r = await runBash(pi, cmd);
        if (r.blocked)
          return { blocked: true, reason: `trim blocked: ${cmd} -> ${r.reason.slice(0, 80)}` };
        notes.push(noteOf(r));
      }
      return notes.every((n) => !n.includes("Reader-bypass"))
        ? { blocked: false }
        : { blocked: true, reason: `a pipeline trim was flagged as a reader bypass: ${notes.join(" | ").slice(0, 120)}` };
    },
  ],
];
