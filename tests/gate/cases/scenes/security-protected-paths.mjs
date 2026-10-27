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
  // ---- S4 (2026-10-15) write/edit protected-path confirm (spec §5.5, fix 8) ----
  // fake HOME under tmp + a symlink: the target resolves through the link
  // into <fake-home>/.ssh — must hit the H2 ladder (headless → block)
  [
    "S4 protected path: write via symlink into HOME/.ssh confirms",
    "blocked",
    async (pi) => {
      const fakeHome = join(tmp, "fake-home-w");
      mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
      rmSync(join(tmp, "ssh-link-w"), { force: true });
      symlinkSync(join(fakeHome, ".ssh"), join(tmp, "ssh-link-w"));
      process.env.HOME = fakeHome;
      try {
        const block = await pi.invoke("tool_call", {
          type: "tool_call",
          toolName: "write",
          toolCallId: `tc${nextId()}`,
          input: { path: join(tmp, "ssh-link-w", "authorized_keys"), content: "evil\n" },
        });
        return block ? { blocked: true, reason: block.reason } : { blocked: false };
      } finally {
        delete process.env.HOME;
      }
    },
  ],
  [
    "S4 protected path: edit via symlink into HOME/.ssh confirms",
    "blocked",
    async (pi) => {
      const fakeHome = join(tmp, "fake-home-e");
      mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
      writeFileSync(join(fakeHome, ".ssh", "authorized_keys"), "key\n");
      rmSync(join(tmp, "ssh-link-e"), { force: true });
      symlinkSync(join(fakeHome, ".ssh"), join(tmp, "ssh-link-e"));
      process.env.HOME = fakeHome;
      try {
        const block = await pi.invoke("tool_call", {
          type: "tool_call",
          toolName: "edit",
          toolCallId: `tc${nextId()}`,
          input: {
            path: join(tmp, "ssh-link-e", "authorized_keys"),
            edits: [{ oldText: "key", newText: "evil" }],
          },
        });
        return block ? { blocked: true, reason: block.reason } : { blocked: false };
      } finally {
        delete process.env.HOME;
      }
    },
  ],
  [
    "S4 protected path: plain write to a cwd file passes",
    "pass",
    async (pi) => {
      const block = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "write",
        toolCallId: `tc${nextId()}`,
        input: { path: join(tmp, "plain-w.txt"), content: "ok" },
      });
      return block ? { blocked: true, reason: block.reason } : { blocked: false };
    },
  ],
  [
    "S4 protected path: plain anchor-valid edit passes",
    "pass",
    async (pi) => {
      const f = join(tmp, "plain-e.txt");
      writeFileSync(f, "a\n");
      await read(pi, f, {}, { outputLines: 1, totalLines: 1 }); // S5 M2: certify first
      return edit(pi, f, [{ oldText: "a", newText: "b" }]);
    },
  ],

];
