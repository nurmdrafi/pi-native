#!/usr/bin/env node
/**
 * Split CHANGELOG.md into per-version release notes under docs/releases/.
 *
 * Each Keep-a-Changelog "## [x.y.z] - date" section becomes
 * docs/releases/vX.Y.Z.md: a one-line back-link header followed by the
 * section verbatim (its heading line included). A "## [Unreleased]"
 * section, when present, becomes docs/releases/unreleased.md.
 *
 * Deterministic: sections are emitted newest-first (Unreleased first, then
 * semver descending) and a file is rewritten only when its content changes,
 * so a re-run over unchanged input leaves the tree untouched.
 *
 * Reported on stdout: CHANGELOG versions with no matching git tag (still
 * emitted), git tags with no CHANGELOG section (never fabricated), and
 * non-semver tags. With --json, prints one {"version","file"} NDJSON row per
 * emitted file in emission order instead of the human report.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = join(root, 'CHANGELOG.md');
const outDir = join(root, 'docs', 'releases');
const BACK_LINK = '[Back to CHANGELOG](../../CHANGELOG.md)';

const SECTION_RE = /^## \[([^\]]+)\]/;
const LINK_DEF_RE = /^\[[^\]]*\]:/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(value) {
  const m = String(value).match(SEMVER_RE);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** Descending semver order (1.0.0-rc.1 < 1.0.0); non-semver titles sort last. */
function compareDesc(a, b) {
  const ka = parseSemver(a);
  const kb = parseSemver(b);
  if (!ka || !kb) return String(b).localeCompare(String(a));
  for (const k of ['major', 'minor', 'patch']) {
    if (ka[k] !== kb[k]) return kb[k] - ka[k];
  }
  const pa = ka.pre;
  const pb = kb.pre;
  if (!pa.length || !pb.length) return pb.length - pa.length;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (xn && x !== y) return y - x;
    if (x !== y) return y.localeCompare(x);
  }
  return 0;
}

/** Split the changelog into "## [title] ..." sections, heading line included. */
function parseSections(lines) {
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SECTION_RE);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && !SECTION_RE.test(lines[end])) end++;
    sections.push({ title: m[1].trim(), lines: lines.slice(i, end) });
    i = end - 1;
  }
  // A changelog may end with Keep-a-Changelog link definitions ("[x.y.z]: url")
  // that belong to no section; trim them (and trailing blanks) off the tail.
  const last = sections[sections.length - 1];
  if (last) {
    const body = last.lines.slice(1);
    while (body.length) {
      const tail = body[body.length - 1].trim();
      if (tail === '' || LINK_DEF_RE.test(tail)) body.pop();
      else break;
    }
    last.lines = [last.lines[0], ...body];
  }
  return sections;
}

function fileNameFor(title) {
  if (/^unreleased$/i.test(title)) return 'unreleased.md';
  if (parseSemver(title)) return `v${String(title).replace(/^v/, '')}.md`;
  return null;
}

function gitTags() {
  try {
    return execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function render(section) {
  return `${BACK_LINK}\n\n${section.lines.join('\n').replace(/\s+$/, '')}\n`;
}

function main() {
  const asJson = process.argv.includes('--json');
  const sections = parseSections(readFileSync(changelogPath, 'utf8').split('\n'));
  if (!sections.length) {
    console.error(`error: no "## [x.y.z]" sections found in ${changelogPath}`);
    process.exit(1);
  }

  const emitted = [];
  const skipped = [];
  for (const section of sections) {
    const file = fileNameFor(section.title);
    if (file) emitted.push({ title: section.title, file, section });
    else skipped.push(section.title);
  }
  emitted.sort((a, b) => {
    const ua = a.file === 'unreleased.md';
    const ub = b.file === 'unreleased.md';
    if (ua || ub) return (ua ? 0 : 1) - (ub ? 0 : 1);
    return compareDesc(a.title, b.title);
  });

  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const e of emitted) {
    const abs = join(outDir, e.file);
    const content = render(e.section);
    if (!existsSync(abs) || readFileSync(abs, 'utf8') !== content) {
      writeFileSync(abs, content);
      written.push(`docs/releases/${e.file}`);
    }
  }

  const tags = gitTags();
  const strip = (v) => String(v).replace(/^v/, '');
  const tagged = new Set(tags.filter((t) => parseSemver(t)).map(strip));
  const inChangelog = new Set(
    emitted.filter((e) => e.file !== 'unreleased.md').map((e) => strip(e.title))
  );
  const noTag = emitted.filter((e) => e.file !== 'unreleased.md' && !tagged.has(strip(e.title)));
  const noSection = tags.filter((t) => parseSemver(t) && !inChangelog.has(strip(t)));
  const nonSemverTags = tags.filter((t) => !parseSemver(t));

  if (asJson) {
    for (const e of emitted) {
      console.log(JSON.stringify({ version: e.title, file: `docs/releases/${e.file}` }));
    }
    return;
  }

  if (written.length) for (const f of written) console.log(`wrote ${f}`);
  else console.log(`all ${emitted.length} release notes up to date`);
  for (const e of noTag) console.log(`note: CHANGELOG version ${e.title} has no git tag (emitted anyway)`);
  for (const t of noSection) console.log(`note: git tag ${t} has no CHANGELOG section (nothing emitted)`);
  for (const t of nonSemverTags) console.log(`note: non-semver tag ${t} ignored for section matching`);
  for (const t of skipped) console.log(`note: heading [${t}] is not a version or Unreleased (skipped)`);
  console.log(
    `summary: ${emitted.length} notes (${written.length} written), ${tags.length} tags`
  );
}

main();
