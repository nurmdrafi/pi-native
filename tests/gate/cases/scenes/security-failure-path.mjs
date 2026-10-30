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
  // ---- S4 (2026-10-15) failure-path family (spec §5.2, fixes 1–3) ----
  [
    "S4 fail-closed: hasUI but no ui.confirm blocks destructive",
    "blocked",
    async (pi) => bash(pi, "rm -rf canary", { hasUI: true, mode: "tui" }),
  ],
  [
    "S4 fail-closed: hanging confirm dialog times out to block",
    "blocked",
    async (pi) => {
      process.env.PGATE_CONFIRM_TIMEOUT_MS = "50";
      try {
        return await bash(pi, "rm -rf canary", {
          hasUI: true,
          mode: "tui",
          ui: { confirm: () => new Promise(() => {}) },
        });
      } finally {
        delete process.env.PGATE_CONFIRM_TIMEOUT_MS;
      }
    },
  ],
  [
    "S4 fail-closed: throwing confirm dialog fails closed, not open",
    "blocked",
    async (pi) => {
      try {
        return await bash(pi, "rm -rf canary", {
          hasUI: true,
          mode: "tui",
          ui: {
            confirm: async () => {
              throw new Error("dialog lost");
            },
          },
        });
      } catch {
        // a rejected handler = the tool call runs anyway (fail-open) — that is the bug
        return { blocked: false, reason: "handler threw; the call would run (fail-open)" };
      }
    },
  ],
  [
    "S4 strictness: confirm resolving non-boolean 'yes' must not approve",
    "blocked",
    async (pi) =>
      bash(pi, "rm -rf canary", {
        hasUI: true,
        mode: "tui",
        ui: { confirm: async () => "yes" },
      }),
  ],
  [
    "S4 strictness: confirm resolving undefined does not approve",
    "blocked",
    async (pi) =>
      bash(pi, "rm -rf canary", {
        hasUI: true,
        mode: "tui",
        ui: { confirm: async () => undefined },
      }),
  ],
  [
    "S4 malformed: bash call with no command blocks, never throws",
    "blocked",
    async (pi) => {
      try {
        const block = await pi.invoke(
          "tool_call",
          { type: "tool_call", toolName: "pibash", toolCallId: `tc${nextId()}`, input: {} },
          approveUi(),
        );
        return block ? { blocked: true, reason: block.reason } : { blocked: false };
      } catch {
        return { blocked: false, reason: "uncaught throw on malformed input" };
      }
    },
  ],
  [
    "S4 malformed: non-string command blocks, never throws",
    "blocked",
    async (pi) => {
      try {
        const block = await pi.invoke(
          "tool_call",
          { type: "tool_call", toolName: "pibash", toolCallId: `tc${nextId()}`, input: { command: 42 } },
          approveUi(),
        );
        return block ? { blocked: true, reason: block.reason } : { blocked: false };
      } catch {
        return { blocked: false, reason: "uncaught throw on malformed input" };
      }
    },
  ],
  [
    "S4 malformed: write without a path gets an explicit block reason",
    "blocked",
    async (pi) => {
      const block = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "write",
        toolCallId: `tc${nextId()}`,
        input: { content: "x" },
      });
      return block ? { blocked: true, reason: block.reason } : { blocked: false };
    },
  ],
  [
    "S4 malformed: edit without a path gets an explicit block reason",
    "blocked",
    async (pi) => {
      const block = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "edit",
        toolCallId: `tc${nextId()}`,
        input: { edits: [{ oldText: "a", newText: "b" }] },
      });
      return block ? { blocked: true, reason: block.reason } : { blocked: false };
    },
  ],
  [
    "S4 wrap: tool_result handler exception passes through",
    "pass",
    async (pi) => {
      const toolCallId = `tc${nextId()}`;
      await pi.invoke(
        "tool_call",
        { type: "tool_call", toolName: "pibash", toolCallId, input: { command: "git status" } },
        approveUi(),
      );
      try {
        await pi.invoke("tool_result", {
          type: "tool_result",
          toolName: "pibash",
          toolCallId,
          input: { command: "git status" },
          content: [{ type: "text", get text() { throw new Error("corrupt content"); } }],
          isError: false,
        });
        return { blocked: false };
      } catch {
        return { blocked: true, reason: "tool_result handler threw — must pass through" };
      }
    },
  ],

];
