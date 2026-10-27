/**
 * Shared stub-API loader for the permission-gate extension (harness only).
 *
 * Preflight trick (from tests/permission-gate.test.mjs): the gate's bare
 * import '@earendil-works/pi-coding-agent' is not in this repo's node_modules,
 * so symlink it from `npm root -g` into the gitignored root node_modules.
 *
 * extensions/permission-gate/index.ts is a symlink target — the live ~/.pi
 * install is never touched.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pkgLink = join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent');
if (!existsSync(join(pkgLink, 'package.json'))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, '@earendil-works', 'pi-coding-agent'), pkgLink, 'dir');
}

const gate = await import(join(ROOT, 'extensions', 'permission-gate', 'index.ts'));

/** fresh gate instance (all gate state lives inside the factory) */
export function freshGate() {
  // composing stub: pi supports multiple handlers per event in one extension
  // (H1 added a second tool_result handler); later registrations append, and
  // invoke() runs them in order — a non-undefined return composes forward
  const lists = new Map();
  const pi = {
    on: (event, handler) => {
      const l = lists.get(event) ?? [];
      l.push(handler);
      lists.set(event, l);
      return () => lists.set(event, (lists.get(event) ?? []).filter((h) => h !== handler));
    },
    invoke: async (event, ev, ctx) => {
      let result;
      for (const h of lists.get(event) ?? []) {
        const r = await h(ev, ctx);
        if (r !== undefined) result = r;
      }
      return result;
    },
  };
  gate.default(pi);
  return pi;
}

let seq = 0;
const textBlocks = (s) => [{ type: 'text', text: s }];

/** tool_call only — returns { blocked, reason }; ctx: H2 confirm context (default = TUI that auto-approves; pass {hasUI:false} to test headless fail-closed) */
export const AUTO_CTX = { hasUI: true, mode: 'tui', ui: { confirm: async () => true } };
export async function bashProbe(pi, command, ctx = AUTO_CTX) {
  const block = await pi.invoke('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: `tc${++seq}`, input: { command } }, ctx);
  return block ? { blocked: true, reason: block.reason } : { blocked: false };
}

/** tool_call + a successful tool_result (records for R10 re-run tracking) */
export async function runBash(pi, command, { isError = false, content = 'out', ctx = AUTO_CTX } = {}) {
  const toolCallId = `tc${++seq}`;
  const input = { command };
  const block = await pi.invoke('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId, input }, ctx);
  if (block) return { blocked: true, reason: block.reason };
  await pi.invoke('tool_result', { type: 'tool_result', toolName: 'bash', toolCallId, input, content: textBlocks(content), isError });
  return { blocked: false };
}

/** reason-prefix family, e.g. "Token Economy (Reading)" */
export function familyOfReason(reason) {
  return /^(Token Economy \([^)]*\)|Anchor Guard|Commitlint)/.exec(reason ?? '')?.[1] ?? null;
}
