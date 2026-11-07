#!/usr/bin/env node
/**
 * A8 (brief §6): AGENTS.md lint — flags duplicated rules and contradictory
 * directives so shrinks/dedupes are evidence-driven, not vibes.
 * Also regenerates the roster tables (Agents table in docs/subagent-
 * orchestration.md, Skills table in docs/skills.md) from agents/<name>.md and
 * skills/<dir>/SKILL.md frontmatter so the docs cannot drift from source: only
 * the rows between the header separator and the next non-table line are
 * rewritten, sorted by name; everything else stays byte-identical and a
 * table already in sync produces no write.
 * Heuristic, no deps. Output: one JSON line.
 *   { bullets, dup_pairs, contradictions, details: [...] }
 * Contradiction checks (extensible):
 *   - ask-polarity: one bullet pre-approves an action class another demands an ask for
 *   - spawn-rule count: >1 bullet governing subagents
 *   - style-rule count: >1 bullet governing reply style (concise/caveman/etc.)
 * Duplication: word-set Jaccard > 0.55 between bullet pairs.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

// Roster generation (2026-11-07): the Agents and Skills tables were
// hand-maintained copies of agents/*.md and skills/*/SKILL.md frontmatter,
// and drift was silent. Both table bodies are now rebuilt from source on
// every run: only the rows between the header separator and the first
// non-table line are replaced; prose, headers and separators stay
// byte-identical, rows are sorted by name, a table already in sync produces
// no write, and a cell containing a pipe fails the run instead of silently
// breaking the table.
const frontmatter = (md) => {
  const lines = md.split('\n');
  const fm = {};
  if (lines[0] !== '---') return fm;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    // top-level keys only; nested YAML is indented and skipped
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
};
const unquote = (s) => (/^".*"$/s.test(s ?? '') ? s.slice(1, -1) : s ?? '');
const cellText = (s) => {
  if ((s ?? '').includes('|')) throw new Error(`roster cell contains a pipe, refusing to break the table: ${s.slice(0, 60)}`);
  return s ?? '';
};
const regenTable = (md, headerTest, renderRows) => {
  const lines = md.split('\n');
  const h = lines.findIndex((l) => headerTest.test(l));
  if (h < 0 || !/^\|[\s-|]+\|$/.test(lines[h + 1] ?? '')) throw new Error(`roster table header not found for ${headerTest}`);
  let end = h + 2;
  while (end < lines.length && lines[end].startsWith('|')) end++;
  const rows = renderRows(lines[h]);
  return { md: [...lines.slice(0, h + 2), ...rows, ...lines.slice(end)].join('\n'), rowsBefore: end - h - 2, rowsAfter: rows.length };
};

// Agents table: one row per agents/*.md — name, tools (plus the established
// `skills`/`subagent_agents` parenthetical), description as the role.
const agentRows = readdirSync(join(ROOT, 'agents'))
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => {
    const fm = frontmatter(readFileSync(join(ROOT, 'agents', f), 'utf8'));
    const name = cellText(unquote(fm.name ?? f.replace(/\.md$/, '')));
    let tools = cellText(unquote(fm.tools));
    if (fm.skills) {
      const sk = unquote(fm.skills).split(',').map((s) => `\`${s.trim()}\``).join(', ');
      const sub = fm.subagent_agents ? `; \`subagent_agents: ${unquote(fm.subagent_agents)}\`` : '';
      tools = cellText(`${tools} (${sk}${sub})`);
    }
    return `| ${name} | ${tools} | ${cellText(unquote(fm.description))} |`;
  });

// Skills table: one row per skills/<dir>/ — name, description verbatim,
// invocation is always /skill:<name>. Padded to the widest cell per column
// (header included) to keep the aligned look of the hand-written table.
const skillCells = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((dir) => {
    const p = join(ROOT, 'skills', dir, 'SKILL.md');
    const fm = frontmatter(existsSync(p) ? readFileSync(p, 'utf8') : '');
    const name = cellText(unquote(fm.name ?? dir));
    return [name, cellText(unquote(fm.description)), `\`/skill:${name}\``];
  });
const padRows = (cells, headerLine) => {
  const widths = headerLine.split('|').slice(1, -1).map((c, i) => Math.max(c.trim().length, ...cells.map((r) => r[i].length)));
  return cells.map((r) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`);
};

const tables = [];
for (const spec of [
  { doc: 'docs/subagent-orchestration.md', header: /^\| Agent\b/, rows: () => agentRows },
  { doc: 'docs/skills.md', header: /^\| Skill\b/, rows: (h) => padRows(skillCells, h) },
]) {
  const path = join(ROOT, spec.doc);
  const before = readFileSync(path, 'utf8');
  const { md: after, rowsBefore, rowsAfter } = regenTable(before, spec.header, spec.rows);
  if (after !== before) writeFileSync(path, after);
  tables.push({ doc: spec.doc, rows_before: rowsBefore, rows_after: rowsAfter, changed: after !== before });
}

console.log(JSON.stringify({ bullets: bullets.length, dup_pairs: dupPairs, contradictions, missing, scope_leaks, tables, details }));
