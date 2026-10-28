// Permission-gate cases for rules.readerBypass (SE2).
// Warn-level tripwire: read windows belong to piread; sed is a pipeline
// stage, never a reader. The printed lines of a mappable single-file view
// still certify spans (VC / bashViewCredit) — the note teaches the
// preference, the credit matches what the model saw.
import { bash, runBash, noteOf } from "../../harness/helpers.mjs";

export const cases = [
  [
    "SE2: 'sed -n' as reader rides a note without blocking",
    "pass",
    async (pi) => {
      const r = await runBash(pi, "sed -n '52,58p' ~/.pi/agent/AGENTS.md");
      return !r.blocked && noteOf(r).includes("Reader-bypass")
        ? r
        : { blocked: true, reason: `note: ${noteOf(r) || "(none)"}` };
    },
  ],
  [
    "SE2: 'cat file' rides a note without blocking",
    "pass",
    async (pi) => {
      const r = await runBash(pi, "cat ~/.pi/agent/package.json");
      return !r.blocked && noteOf(r).includes("Reader-bypass")
        ? r
        : { blocked: true, reason: `note: ${noteOf(r) || "(none)"}` };
    },
  ],
  [
    "SE2: pipeline-stage sed (substitution, no -n) is not flagged",
    "pass",
    async (pi) => bash(pi, "rg -n foo src/ | sed 's/foo/bar/' | head -5"),
  ],
  [
    "SE2: jq reading a file is not flagged",
    "pass",
    async (pi) => bash(pi, "jq -r '.name' ~/.pi/agent/package.json"),
  ],
];
