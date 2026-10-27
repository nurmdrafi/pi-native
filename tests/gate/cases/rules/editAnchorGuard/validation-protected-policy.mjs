// Permission-gate cases for rules.editAnchorGuard.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, rc, lineText, read, edit, editApplied, editsApplied, bash, runBash, write, approveUi, compact, tmp, fileA, fileB, elidedReadC3, nextId, getHydT, setHydT } from "../../../harness/helpers.mjs";

export const cases = [
  [
    "S5 policy: protected-path edit confirms through H2 before binding blocks",
    "blocked",
    async (pi) => {
      const fakeHome = join(tmp, "fake-home-s5a");
      mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
      writeFileSync(join(fakeHome, ".ssh", "authorized_keys"), "key\n");
      rmSync(join(tmp, "ssh-link-s5a"), { force: true });
      symlinkSync(join(fakeHome, ".ssh"), join(tmp, "ssh-link-s5a"));
      process.env.HOME = fakeHome;
      try {
        // never-read target with a valid anchor: Unread would fire — the H2
        // policy ladder must fire FIRST (headless → destructive block)
        const block = await pi.invoke(
          "tool_call",
          {
            type: "tool_call",
            toolName: "edit",
            toolCallId: `tc${nextId()}`,
            input: {
              path: join(tmp, "ssh-link-s5a", "authorized_keys"),
              edits: [{ oldText: "key", newText: "evil" }],
            },
          },
          { hasUI: false },
        );
        return block && block.reason.startsWith("Permission Gate (Destructive)")
          ? { blocked: true, reason: block.reason }
          : { blocked: false, reason: `order: ${block?.reason ?? "(pass)"}` };
      } finally {
        delete process.env.HOME;
      }
    },
  ],
  [
    "S5 policy: binding block on an approved protected path still fires",
    "blocked",
    async (pi) => {
      const fakeHome = join(tmp, "fake-home-s5b");
      mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
      writeFileSync(join(fakeHome, ".ssh", "authorized_keys"), "key\n");
      rmSync(join(tmp, "ssh-link-s5b"), { force: true });
      symlinkSync(join(fakeHome, ".ssh"), join(tmp, "ssh-link-s5b"));
      process.env.HOME = fakeHome;
      try {
        // user approves H2 — the Unread binding block must still engage
        // (both layers, neither skipped)
        const block = await pi.invoke(
          "tool_call",
          {
            type: "tool_call",
            toolName: "edit",
            toolCallId: `tc${nextId()}`,
            input: {
              path: join(tmp, "ssh-link-s5b", "authorized_keys"),
              edits: [{ oldText: "key", newText: "evil" }],
            },
          },
          approveUi(),
        );
        return block && block.reason.startsWith("Anchor Guard (Unread):")
          ? { blocked: true, reason: block.reason }
          : { blocked: false, reason: `both layers: ${block?.reason ?? "(pass)"}` };
      } finally {
        delete process.env.HOME;
      }
    },
  ],
];
