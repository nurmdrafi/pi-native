// Permission-gate cases for rules.nativeBashFirst.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, textBlocks, lineText, bash, pibash } from "../../harness/helpers.mjs";

export const cases = [
  // ---- pibash (2026-10-18): the native bash tool must be bash-kind ----
  // Each rule that fires on `bash` must fire identically on `pibash`.
  [
    'pibash: commitlint blocks a bad commit message',
    'blocked',
    async (pi) => pibash(pi, "git commit -m 'bad message'"),
  ],
  [
    'pibash: re-run guard blocks an identical re-run',
    'pass',
    async (pi) => {
      await pibash(pi, 'fd -e ts . rust-tools');
      return pibash(pi, 'fd -e ts . rust-tools');
    },
  ],
  [
    'pibash: malformed call (blank command) is blocked',
    'blocked',
    async (pi) => pibash(pi, '   '),
  ],
  [
    'pibash: benign command passes the gate',
    'pass',
    async (pi) => pibash(pi, 'fd -e ts . rust-tools/pibash'),
  ],
  [
    'pibash: H1 output cap applies to pibash results',
    'pass',
    async (pi) => {
      const toolCallId = 'tc-cap-probe';
      await pi.invoke('tool_call', {
        type: 'tool_call',
        toolName: 'pibash',
        toolCallId,
        input: { command: 'seq 1 200' },
      });
      const out = await pi.invoke('tool_result', {
        type: 'tool_result',
        toolName: 'pibash',
        toolCallId,
        input: { command: 'seq 1 200' },
        content: textBlocks(lineText(200)),
      });
      const text = JSON.stringify(out ?? {});
      // cap note proves the H1 handler treated pibash as bash-kind
      if (!text.includes('output capped')) {
        throw new Error('H1 cap did not apply to pibash output');
      }
      return { blocked: false };
    },
  ],
  // ---- P2 (2026-10-18): pibash-first — built-in bash is blocked ----
  [
    'P2: built-in bash is blocked (pibash-first)',
    'blocked',
    async (pi) => {
      const r = await bash(pi, 'fd -e ts . rust-tools', undefined, { tool: 'bash' });
      return r.blocked && r.reason.startsWith('Token Economy (Pibash-first)')
        ? r
        : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
    },
  ],
  [
    'P2: built-in bash is blocked regardless of the retired PI_NATIVE_BASH switch',
    'blocked',
    async (pi) => {
      const prev = process.env.PI_NATIVE_BASH;
      process.env.PI_NATIVE_BASH = '0';
      try {
        const r = await bash(pi, 'fd -e ts . rust-tools', undefined, { tool: 'bash' });
        return r.blocked && r.reason.startsWith('Token Economy (Pibash-first)')
          ? r
          : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
      } finally {
        if (prev === undefined) delete process.env.PI_NATIVE_BASH;
        else process.env.PI_NATIVE_BASH = prev;
      }
    },
  ],
];
