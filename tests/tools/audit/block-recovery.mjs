#!/usr/bin/env node
/**
 * Block-recovery audit — measures what the model does after a permission-gate
 * block and how big the block messages are, across every logged session
 * .jsonl under the sessions tree (per-project directories).
 *
 * For every toolResult whose text starts with a gate prefix (Anchor Guard /,
 * Token Economy (…) / Commitlint:) it records:
 *   - family counts and message sizes (median / mean / p90 / max chars)
 *   - recovery: the next event after the block — an assistant toolCall
 *     (acted, one-shot recovery), another same-family block (weak thrash),
 *     or nothing (session end)
 *
 * Regression gate for the 2026-10-06 block-reason diet: exit 1 when one-shot
 * recovery < 85% on a sample of >= 10 blocks (small samples stay advisory).
 *
 * Run: node tests/block-recovery-audit.mjs [sessionsRoot]   (default: ../sessions)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SESSIONS = resolve(process.argv[2] ?? join(ROOT, 'sessions'));

const PREFIXES = ['Anchor Guard', 'Token Economy', 'Commitlint'];
const familyOf = (txt) => txt.slice(0, txt.indexOf(':'));

let files = [];
try {
	files = readdirSync(SESSIONS, { recursive: true, encoding: 'utf8' })
		.filter((f) => String(f).endsWith('.jsonl'))
		.map((f) => join(SESSIONS, String(f)));
} catch {
	console.error(`no sessions dir at ${SESSIONS}`);
	process.exit(1);
}

const blocks = []; // { family, size, next: 'acted' | 'reblock' | 'end' }
for (const file of files) {
	const events = []; // ['call'] | ['block', family]
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line.includes('"role"')) continue;
		let msg;
		try {
			msg = JSON.parse(line).message;
		} catch {
			continue;
		}
		if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
			if (msg.content.some((c) => c?.type === 'toolCall')) events.push(['call']);
		} else if (msg?.role === 'toolResult') {
			const txt = (msg.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
			if (PREFIXES.some((p) => txt.startsWith(p))) events.push(['block', familyOf(txt), txt.length]);
		}
	}
	for (let i = 0; i < events.length; i++) {
		if (events[i][0] !== 'block') continue;
		const nxt = events[i + 1];
		blocks.push({
			family: events[i][1],
			size: events[i][2],
			next: !nxt ? 'end' : nxt[0] === 'call' ? 'acted' : nxt[1] === events[i][1] ? 'reblock' : 'other-block',
		});
	}
}

if (blocks.length === 0) {
	console.log('no permission-gate blocks found in logged sessions');
	process.exit(0);
}

const sizes = blocks.map((b) => b.size).sort((a, b) => a - b);
const fams = {};
for (const b of blocks) fams[b.family] = (fams[b.family] ?? 0) + 1;
const acted = blocks.filter((b) => b.next === 'acted').length;
const reblock = blocks.filter((b) => b.next === 'reblock').length;
const recovery = acted / blocks.length;

console.log(`blocks=${blocks.length}  one-shot-recovery=${acted} (${Math.round(recovery * 100)}%)  same-family-reblock=${reblock}  other-next=${blocks.length - acted - reblock}`);
console.log('families:', Object.entries(fams).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
console.log(`size chars: median=${sizes[(sizes.length - 1) >> 1]}  mean=${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)}  p90=${sizes[Math.floor(sizes.length * 0.9)]}  max=${sizes[sizes.length - 1]}`);

if (blocks.length >= 10 && recovery < 0.85) {
	console.log(`\nFAIL: one-shot recovery ${(recovery * 100).toFixed(0)}% < 85% on ${blocks.length} blocks — a recent gate change degraded message effectiveness`);
	process.exit(1);
}
console.log(`\nOK: recovery gate ${blocks.length >= 10 ? '' : '(advisory, small sample) '}>= 85%`);
