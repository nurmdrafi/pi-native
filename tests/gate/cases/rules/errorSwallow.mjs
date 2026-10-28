// Permission-gate cases for rules.errorSwallow (SE1).
// Attribution: this module owns the error-swallow warn tripwire assertions.
import { bash, runBash, noteOf } from "../../harness/helpers.mjs";

export const cases = [
  [
    "SE1: '|| true' at warn rides a note without blocking",
    "pass",
    async (pi) => {
      const r = await runBash(pi, "ls ~/.pi/agent/docs || true");
      return !r.blocked && noteOf(r).includes("Error-swallow")
        ? r
        : { blocked: true, reason: `note: ${noteOf(r) || "(none)"}` };
    },
  ],
  [
    "SE1: '|| :' variant does not block at warn",
    "pass",
    async (pi) => bash(pi, "stat ~/.pi/agent/package.json || :"),
  ],
  [
    "SE1: '|| echo fallback' is not flagged",
    "pass",
    async (pi) => {
      const r = await bash(pi, "ls /nonexistent-dir-xyz || echo 'missing'");
      return !r.blocked && !noteOf(r).includes("Swallow")
        ? r
        : { blocked: true, reason: `note: ${noteOf(r) || "(none)"}` };
    },
  ],
];
