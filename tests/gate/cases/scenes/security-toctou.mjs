// Permission-gate cases for rules.cross-rule (multi-rule scenes).
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, textBlocks, read, edit, bash, runBash, runSearch, nestedBash, write, approveUi, denyUi, compact, tmp, fileA, fileInj, spanFile, hitRoot, hitApi, hugeFile, canary, stopCanary, canaryIntact, HARD_NET, gatedExec, canaryBlocked, nextId } from "../../harness/helpers.mjs";

export const cases = [
  // ---- S4 (2026-10-15) TOCTOU + symlink/spill lock-ins (spec §5.4–5.5) ----
  [
    "S4 TOCTOU: R1 re-read re-stats — mtime-only touch defeats the block",
    "pass",
    async (pi) => {
      const f = join(tmp, "touch-mtime.ts");
      writeFileSync(f, "m1\nm2\n");
      await read(pi, f, {}, { outputLines: 2, totalLines: 2 });
      await new Promise((r) => setTimeout(r, 10)); // distinct mtime
      writeFileSync(f, "m1\nm2\n"); // same bytes, new mtime — decision-time stat wins
      return read(pi, f, {}, { outputLines: 2, totalLines: 2 });
    },
  ],
  [
    "S4 TOCTOU: approve window is keyed verbatim (rm a ≠ rm b)",
    "blocked",
    async (pi) => {
      const deny = {
        hasUI: true,
        mode: "tui",
        ui: { confirm: async () => false },
      };
      await bash(pi, "rm -f a.txt", approveUi());
      return bash(pi, "rm -f b.txt", deny); // approving `a` must not bless `b`
    },
  ],
  [
    "S4 symlink: ln -s canary link && rm link is blocked",
    "blocked",
    async (pi) =>
      runBash(pi, "ln -s canary.txt link.txt && rm link.txt", {
        ctx: { hasUI: false },
      }),
  ],
  [
    "S4 spill: hostile toolCallId stays inside pgate-spill (sanitized)",
    "pass",
    async (pi) => {
      const toolCallId = "../../evil";
      const block = await pi.invoke(
        "tool_call",
        { type: "tool_call", toolName: "bash", toolCallId, input: { command: "seq 1 500" } },
        approveUi(),
      );
      if (block) return { blocked: true, reason: "unexpected block" };
      const huge = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId,
        input: { command: "seq 1 500" },
        content: textBlocks(huge),
        isError: false,
      });
      const spillDir = join(tmpdir(), "pgate-spill");
      const inside = existsSync(join(spillDir, ".._.._evil.txt"));
      const escaped = existsSync(join(tmpdir(), "evil.txt"));
      return inside && !escaped
        ? { blocked: false }
        : { blocked: true, reason: `inside=${inside} escaped=${escaped}` };
    },
  ],

];
