#!/usr/bin/env node
/**
 * A8 (brief §6): AGENTS.md lint — flags duplicated rules and contradictory
 * directives so shrinks/dedupes are evidence-driven, not vibes.
 * Heuristic, no deps. Output: one JSON line.
 *   { bullets, dup_pairs, contradictions, details: [...] }
 * Contradiction checks (extensible):
 *   - ask-polarity: one bullet pre-approves an action class another demands an ask for
 *   - spawn-rule count: >1 bullet governing subagents
 *   - style-rule count: >1 bullet governing reply style (concise/caveman/etc.)
 * Duplication: word-set Jaccard > 0.55 between bullet pairs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Files are arguments so the same heuristics judge every rule file; default
 * stays AGENTS.md so `npm run lint:agents` is unchanged. Two or more files pool
 * their bullets, which is the only way to catch a rule restated across the
 * always-on pair. Numbered items count too: the read ladder is `1.`/`2.`/`3.`,
 * not `-`, and a bullet-only regex reported "no duplicates" over the densest
 * rules in the file. */
const files = [];
let min = 0.55;
for (const a of process.argv.slice(2)) {
  if (a === '--min') min = Number(process.argv[process.argv.indexOf(a) + 1]);
  else if (!a.startsWith('--') && Number.isNaN(Number(a))) files.push(a);
}
if (!files.length) files.push('AGENTS.md');
const SOURCES = files.map((f) => ({ file: f, md: readFileSync(join(ROOT, f), 'utf8') }));
const md = SOURCES.map((s) => s.md).join('\n');

const bullets = [];
const sectioned = [];
let section = '';
for (const line of md.split('\n')) {
  const head = line.match(/^#{1,6}\s+(.+)$/);
  if (head) { section = head[1].trim(); continue; }
  const item = line.match(/^\s*(?:[-*] |\d+\. )(.+)$/);
  if (item) { bullets.push(item[1].trim()); sectioned.push({ section, text: item[1].trim() }); }
}
const norm = (s) => s.toLowerCase().replace(/[*_`]/g, '').replace(/[^\w\s/]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
const jac = (a, b) => {
  const A = words(a), B = words(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter || 1);
};

const details = [];
let dupPairs = 0;
for (let i = 0; i < bullets.length; i++) {
  for (let j = i + 1; j < bullets.length; j++) {
    const s = jac(bullets[i], bullets[j]);
    if (s > min) {
      dupPairs++;
      details.push({ kind: 'dup', sim: Number(s.toFixed(2)), a: bullets[i].slice(0, 70), b: bullets[j].slice(0, 70) });
    }
  }
}

// contradiction heuristics
const preapproved = bullets.filter((b) => /pre-approved|need no ask|without asking|no ask needed/i.test(b));
const askFirst = bullets.filter((b) => /ask[- ]first|ask (first|before|and wait)|→ ask|→\s*ask/i.test(b));
let contradictions = 0;
for (const pre of preapproved) {
  for (const ask of askFirst) {
    if (pre === ask) continue; // one bullet stating both tiers is the FIX, not a conflict
    // same action domain on both sides?
    const domain = (s) => /\b(read|rg|ls|find|git status|git diff|git log)\b/i.test(s) ? 'read' : /\bcommit|push|install|destructive|mutat/i.test(s) ? 'mutate' : 'other';
    if (domain(pre) === domain(ask) && domain(pre) !== 'other') {
      contradictions++;
      details.push({ kind: 'ask-polarity', a: pre.slice(0, 70), b: ask.slice(0, 70) });
    }
  }
}
const spawnRules = bullets.filter((b) => /subagent/i.test(b));
if (spawnRules.length > 1) { contradictions++; details.push({ kind: 'multi-rule', topic: 'subagents', n: spawnRules.length }); }
const styleRules = sectioned.filter((b) => /concise|caveman|filler|pleasantr|no emojis|fragments/i.test(b.text) && /communication/i.test(b.section));
if (styleRules.length > 1) { contradictions++; details.push({ kind: 'multi-rule', topic: 'style', n: styleRules.length }); }

// Referent checks (2026-11-01): a rule that names a command or a path is only
// as good as the thing it names. A docs row claimed `logs/` held gate telemetry
// long after that store was deleted and nothing noticed, so every `npm run X`
// and every repo-relative path in backticks is resolved against the tree.
// Placeholders (`docs/<area>.md`) and globs (`skills/*/scripts/`) are prose, not
// references, and stay unflagged.
const scriptNames = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}));
const TOP_DIRS = /^(?:extensions|docs|scripts|tests|skills|rust-tools|bin|handoff|prompts|benchmark|audit-reports|sessions|src|lib)\//;
const missing = [];
const seenRefs = new Set();
// A line that reports a removal is describing history, not making a promise:
// `docs/development.md` says the former `scripts/doc-check.mjs` is deleted, and
// that sentence must not read as a broken reference.
const HISTORICAL = /\b(former|formerly|deleted|removed|deprecated|no longer)\b/i;
for (const { file, md: text } of SOURCES) {
  for (const line of text.split('\n')) {
    if (HISTORICAL.test(line)) continue;
    for (const m of line.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      const key = `script:${m[1]}`;
      if (scriptNames.has(m[1]) || seenRefs.has(key)) continue;
      seenRefs.add(key);
      missing.push({ file, kind: 'script', ref: `npm run ${m[1]}` });
    }
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      const p = m[1];
      if (!TOP_DIRS.test(p) || p.includes('<') || p.includes('*')) continue;
      const key = `path:${p}`;
      if (existsSync(join(ROOT, p)) || seenRefs.has(key)) continue;
      seenRefs.add(key);
      missing.push({ file, kind: 'path', ref: p });
    }
  }
}

// Scope leak (2026-11-01): the always-on pair loads for EVERY project, so a line
// naming this repo's scripts or paths teaches a wrong assumption everywhere else.
// A line may mention repo artifacts only when it also marks the scope (harness,
// this repo, current project); otherwise it belongs in a scoped doc.
const SCOPED = /\b(harness|this repo|current project|project's own)\b/i;
const REPO_ONLY = /(^|[\s`([\[])(?:npm run [a-z]|extensions\/|rust-tools\/|skills\/|docs\/|package\.json)/;
const scope_leaks = [];
for (const { file, md: text } of SOURCES) {
  if (!/(?:^|\/)(?:AGENTS|SYSTEM)\.md$/.test(file)) continue;
  for (const [i, line] of text.split('\n').entries())
    if (REPO_ONLY.test(line) && !SCOPED.test(line))
      scope_leaks.push({ file, line: i + 1, text: line.trim().slice(0, 90) });
}

console.log(JSON.stringify({ bullets: bullets.length, dup_pairs: dupPairs, contradictions, missing, scope_leaks, details }));
