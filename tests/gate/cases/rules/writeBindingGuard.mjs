// Permission-gate cases for rules.writeBindingGuard (WB): a write to an
// EXISTING file binds like an edit — never-read, stat drift, or hash drift
// since the certified read blocks with a re-read fix. The off/warn rungs
// live in tests/gate/write-binding-off.test.mjs (severity-specific process).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piread, write, bash, runBash, ROOT } from "../../harness/helpers.mjs";

const lineText = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const tmpFile = (name) => {
  const f = join(mkdtempSync(join(tmpdir(), "pgate-wb-")), name);
  writeFileSync(f, lineText(60));
  return f;
};

export const cases = [
  [
    'WB: overwrite of a never-read existing file is blocked',
    'blocked',
    async (pi) => write(pi, tmpFile("never-read.ts"), lineText(30)),
  ],
  [
    'WB: overwrite after a read of the file passes',
    'pass',
    async (pi) => {
      const f = tmpFile("read-then-write.ts");
      await piread(pi, f, { offset: 1, limit: 5 });
      return write(pi, f, lineText(30));
    },
  ],
  [
    'WB: external drift between read and write blocks the overwrite (Stale)',
    'blocked',
    async (pi) => {
      const f = tmpFile("drift.ts");
      await piread(pi, f, { offset: 1, limit: 5 });
      writeFileSync(f, lineText(70)); // external edit: size + mtime drift
      const r = await write(pi, f, lineText(30));
      return r.blocked && r.reason.startsWith('Anchor Guard (Stale)')
        ? r
        : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
    },
  ],
  // ---- Phase 6 (audit A9): write-binding parity for the bash lane —
  // REDIRECT/TEE targets that are VCS-tracked or session-covered bind like
  // write-tool targets: never-read tracked files block Unread, covered files
  // with drifted stats block Stale. Untracked scratch stays free.
  [
    'WB: bash redirect overwrite of a never-read tracked file is blocked (Unread)',
    'blocked',
    async (pi) => {
      const r = await bash(pi, `echo hi > ${join(ROOT, "package.json")}`);
      return r.blocked && r.reason.startsWith('Anchor Guard (Unread)')
        ? r
        : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
    },
  ],
  [
    'WB: bash redirect into a tracked file passes after a read',
    'pass',
    async (pi) => {
      await piread(pi, join(ROOT, "package.json"), { offset: 1, limit: 5 });
      return bash(pi, `echo hi > ${join(ROOT, "package.json")}`);
    },
  ],
  [
    'WB: bash tee overwrite of a covered file after external drift blocks (Stale)',
    'blocked',
    async (pi) => {
      const f = tmpFile("tee-drift.ts");
      await piread(pi, f, { offset: 1, limit: 5 });
      writeFileSync(f, lineText(90)); // external edit: size + mtime drift
      const r = await bash(pi, `echo x | tee ${f}`);
      return r.blocked && r.reason.startsWith('Anchor Guard (Stale)')
        ? r
        : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
    },
  ],
  [
    'WB: bash redirect into an untracked scratch file passes (no binding)',
    'pass',
    async (pi) => bash(pi, `echo x > ${tmpFile("scratch-free.ts")}`),
  ],
];
