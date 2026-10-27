// Permission-gate cases for rules.reblockEscalation.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, textBlocks, read, edit, bash, runBash, tmp, fileA, nextId } from "../../harness/helpers.mjs";

export const cases = [
  // ---- 2026-10-08 extensions audit: Re-block escalation (RETRY-SAME case) ----
  // bash() alone doesn't replay the synthesized block tool_result pi emits —
  // do it by hand so pendingBashFull -> lastBlockedBash arms, like the real loop
  [
    "verbatim re-send of a just-blocked command escalates to Re-block",
    "blocked",
    async (pi) => {
      const bad = 'git commit -m "Fix the thing" && echo committed'; // Commitlint blocks it (R5 retired by H1 step 5)
      const id1 = `rb${nextId()}`;
      const b1 = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id1,
        input: { command: bad },
      });
      if (!b1) return { blocked: false }; // precondition: commitlint blocks the bad message
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id1,
        input: { command: bad },
        content: textBlocks(b1.reason),
        isError: true,
      });
      const b2 = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: `rb${nextId()}`,
        input: { command: bad },
      });
      return b2 && b2.reason.includes("Re-block")
        ? { blocked: true, reason: b2.reason }
        : { blocked: false };
    },
  ],
  // ---- B1/B2 fixes (2026-10-08): Re-block yields to mutations, family preserved ----
  [
    "re-block yields after an intervening edit (B1)",
    "pass",
    async (pi) => {
      const cmd = "npm test 2>&1 | tail -5";
      await runBash(pi, cmd);
      const id = `b1${nextId()}`;
      const blk = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: cmd },
      });
      if (!blk) return { blocked: false }; // precondition: R10 blocks the identical re-run
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: cmd },
        content: textBlocks(blk.reason),
        isError: true,
      });
      await read(pi, fileA); // S5 M2: certify before the edit
      const e = await edit(pi, fileA, [{ oldText: "b", newText: "x" }]);
      if (e.blocked) return { blocked: true, reason: "edit blocked" };
      return bash(pi, cmd); // R10 allows (mut changed) and Re-block must yield
    },
  ],
  [
    "third consecutive block still names the original family (B2)",
    "blocked",
    async (pi) => {
      const cmd = 'git commit -m "Bad message here"'; // commitlint blocks
      for (let k = 0; k < 2; k++) {
        const id = `b2${nextId()}`;
        const blk = await pi.invoke("tool_call", {
          type: "tool_call",
          toolName: "bash",
          toolCallId: id,
          input: { command: cmd },
        });
        if (!blk) return { blocked: false }; // precondition
        await pi.invoke("tool_result", {
          type: "tool_result",
          toolName: "bash",
          toolCallId: id,
          input: { command: cmd },
          content: textBlocks(blk.reason),
          isError: true,
        });
      }
      const r = await bash(pi, cmd);
      return r.blocked && r.reason.includes("Commitlint")
        ? r
        : { blocked: false };
    },
  ],
  [
    "compliant variant after a block does not escalate",
    "pass",
    async (pi) => {
      const bad = 'git commit -m "Fix the thing" && echo committed';
      const id1 = `rb${nextId()}`;
      const b1 = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id1,
        input: { command: bad },
      });
      if (!b1) return { blocked: false }; // precondition: blocked first
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id1,
        input: { command: bad },
        content: textBlocks(b1.reason),
        isError: true,
      });
      return bash(
        pi,
        "git clone -q https://example.com/r /tmp/r2 && cd /tmp/r2 && git log --oneline | head -5",
      );
    },
  ],
  [
    "real command failure does not arm the escalation",
    "pass",
    async (pi) => {
      const cmd = 'timeout 120 pi -p "ok"';
      const id1 = `rb${nextId()}`;
      const b1 = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id1,
        input: { command: cmd },
      });
      if (!b1) return { blocked: false }; // precondition: passes the gate
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id1,
        input: { command: cmd },
        content: textBlocks("/bin/bash: timeout: command not found"),
        isError: true,
      });
      const b2 = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: `rb${nextId()}`,
        input: { command: cmd },
      });
      if (b2)
        console.log(
          `      must not re-block after a real (non-gate) failure: ${b2.reason.slice(0, 90)}`,
        );
      return b2 ? { blocked: true, reason: b2.reason } : { blocked: false }; // blocked here = test failure
    },
  ],
  [
    "loop-body sed viewing is not split out",
    "pass",
    async (pi) =>
      bash(
        pi,
        'for s in research domain; do echo "== $s"; sed -n \'1,6p\' "$s.md"; done',
      ),
  ],
];
