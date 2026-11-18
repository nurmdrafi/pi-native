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
];
