#!/usr/bin/env node
/**
 * Pre-edit-read canary — measures whether edit/write tool calls are preceded
 * by a read of the target path in the same session: the behavior Anchor
 * Guard and the write-binding guard enforce at the gate. High rate = the
 * model internalizes read-before-edit; a falling rate predicts AG/WB block
 * recurrence before it floods the ledger.
 *
 * Per session (pure measureSession):
 *   editWriteCalls  piedit/edit/piwrite/write calls with a path argument
 *   preRead         of those, targets read earlier in the session
 *   newFileWrites   piwrite to a path never read nor touched earlier —
 *                   creation-shaped; cannot be pre-read, excluded from the
 *                   rate denominator (a blind overwrite of an existing file
 *                   still surfaces as an Unread block, counted separately)
 *   unreadBlocks    Anchor Guard (Unread) block results
 *   recoveredByRead blocks whose next tool call reads the blocked path
 *
 * Prints METRIC pre_edit_read_rate=<pct> and one JSON summary line.
 * Run: node tests/gate/eval/pre-edit-read.mjs [sessionsRoot]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const READ_TOOLS = new Set(['piread', 'read']);
const EDIT_TOOLS = new Set(['piedit', 'edit']);
const WRITE_TOOLS = new Set(['piwrite', 'write']);

/** One session's pre-edit-read measurement (pure). */
export function measureSession(text) {
  const calls = []; // { name, path } in call order
  for (const line of text.split('\n')) {
    if (!line.includes('"role"')) continue;
    let msg;
    try {
      msg = JSON.parse(line).message;
    } catch {
      continue;
    }
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b?.type === 'toolCall' && b.arguments?.path != null)
        calls.push({ name: b.name, path: String(b.arguments.path) });
    }
  }
  // blocks in result order, aligned to the call that preceded them
  const blocks = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"role"')) continue;
    let msg;
    try {
      msg = JSON.parse(line).message;
    } catch {
      continue;
    }
    if (msg?.role !== 'toolResult' && msg?.role !== 'assistant') continue;
    if (msg.role === 'toolResult' && msg.isError === true) {
      const txt = (msg.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
      if (txt.startsWith('Anchor Guard (Unread)')) blocks.push(String(/'([^']+)'/.exec(txt)?.[1] ?? ''));
    }
  }

  const reads = new Set();
  const touched = new Set();
  let editWriteCalls = 0;
  let preRead = 0;
  let newFileWrites = 0;
  for (const c of calls) {
    if (READ_TOOLS.has(c.name)) {
      reads.add(c.path);
    } else if (EDIT_TOOLS.has(c.name) || WRITE_TOOLS.has(c.name)) {
      editWriteCalls++;
      if (reads.has(c.path)) preRead++;
      else if (WRITE_TOOLS.has(c.name) && !touched.has(c.path)) newFileWrites++;
      touched.add(c.path);
    }
  }

  // recovery: a blocked path that was read at some point after its first
  // unread edit — one-shot precision lives in block-recovery.mjs
  const recoveredByRead = blocks.filter((p) => reads.has(p)).length;

  return { editWriteCalls, preRead, newFileWrites, unreadBlocks: blocks.length, recoveredByRead };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const SESSIONS = resolve(process.argv[2] ?? join(ROOT, 'sessions'));
  let files = [];
  try {
    files = readdirSync(SESSIONS, { recursive: true, encoding: 'utf8' })
      .filter((f) => String(f).endsWith('.jsonl'))
      .map((f) => join(SESSIONS, String(f)));
  } catch {
    console.error(`no sessions dir at ${SESSIONS}`);
    process.exit(1);
  }
  const total = { editWriteCalls: 0, preRead: 0, newFileWrites: 0, unreadBlocks: 0, recoveredByRead: 0, sessions: 0 };
  for (const f of files) {
    const m = measureSession(readFileSync(f, 'utf8'));
    if (m.editWriteCalls || m.unreadBlocks) total.sessions++;
    for (const k of ['editWriteCalls', 'preRead', 'newFileWrites', 'unreadBlocks', 'recoveredByRead']) total[k] += m[k];
  }
  const denom = total.editWriteCalls - total.newFileWrites;
  const rate = denom > 0 ? total.preRead / denom : null;
  if (rate !== null) console.log(`METRIC pre_edit_read_rate=${(rate * 100).toFixed(1)}%`);
  console.log(JSON.stringify({ ...total, pre_edit_read_rate: rate }));
}
