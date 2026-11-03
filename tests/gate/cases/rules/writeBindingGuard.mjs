// Permission-gate cases for rules.writeBindingGuard (WB): a write to an
// EXISTING file binds like an edit — never-read, stat drift, or hash drift
// since the certified read blocks with a re-read fix. The off/warn rungs
// live in tests/gate/write-binding-off.test.mjs (severity-specific process).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piread, write } from "../../harness/helpers.mjs";

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
];
