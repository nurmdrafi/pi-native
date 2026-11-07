#!/usr/bin/env node
/**
 * bench-charts.mjs — dependency-free benchmark chart generator.
 *
 * Parses the hand-written markdown benchmark summaries under benchmark/ and
 * docs/native-tools.md, then renders ONE consolidated dark-mode SVG
 * (docs/assets/benchmarks/all-tools.svg) with two stacked panels:
 *   A — LATENCY: grouped bars, native tool vs baseline, p50 ms, per-row
 *       linear scale (exact proportions within a row), one representative
 *       case per tool (piread, pibash, piedit, piwrite, pidx).
 *   B — THROUGHPUT: all five native tools, one 32 MiB case each, native vs
 *       baseline, MB/s, linear (sources: benchmark/runs/throughput-*.md).
 * Every bar's value label is the verbatim number from its source table; the
 * xN.n sublabels are computed baseline/native ratios (stated in the desc).
 * The SVG <desc> cites every source file plus the honest caveat (piwrite
 * serve medians at 1-100 MB; kernel dirty-page throttling); the visible
 * footer is one short line.
 *
 * Deterministic: fixed sources, fixed ordering, no timestamps, no randomness
 * — rerunning writes a byte-identical file.
 *
 * Usage: node scripts/bench-charts.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = resolve(ROOT, process.env.PI_BENCH_CHART_OUT ?? 'docs/assets/benchmarks/all-tools.svg');

// ---- read-only sources --------------------------------------------------------
const SRC_PIWRITE = 'benchmark/piwrite/results/summary-2026-11-05-rawframe3.md';
const SRC_PIREAD = 'benchmark/runs/piread-microbench-2026-10-27.md';
const SRC_PIBASH = 'benchmark/runs/pibash-microbench-2026-10-27.md';
const SRC_PIEDIT = 'benchmark/runs/piedit-microbench-2026-10-27.md';
const SRC_TP_PIREAD = 'benchmark/runs/throughput-piread-2026-11-07.md';
const SRC_TP_PIBASH = 'benchmark/runs/throughput-pibash-2026-11-07.md';
const SRC_TP_PIEDIT = 'benchmark/runs/throughput-piedit-2026-11-07.md';
const SRC_TP_PIWRITE = 'benchmark/runs/throughput-piwrite-2026-11-07.md';
const SRC_TP_PIDX = 'benchmark/runs/throughput-pidx-2026-11-07.md';
const SRC_NATIVE_TOOLS = 'docs/native-tools.md';
const SRC_RUST_OPT = 'docs/rust-tools-optimization.md';

// dark-mode palette (GitHub dark)
const C = {
  bg: '#0d1117',
  text: '#e6edf3',
  sub: '#8b949e',
  grid: '#21262d',
  axis: '#30363d',
  native: '#58a6ff',
  base: '#6e7681',
};

// ---- markdown table parsing ----------------------------------------------------
// A table = consecutive lines starting with '|'. First row is the header.
function parseTables(text) {
  const tables = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (!cur) cur = { header: null, rows: [] };
      if (cur.header === null) cur.header = cells;
      else if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator
      else cur.rows.push(cells);
    } else if (cur) {
      tables.push(cur);
      cur = null;
    }
  }
  if (cur) tables.push(cur);
  return tables;
}

// Rows as { headerName -> cellString } maps.
function rowMaps(table) {
  return table.rows.map((r) => {
    const o = {};
    table.header.forEach((h, i) => (o[h] = r[i]));
    return o;
  });
}

function cell(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) throw new Error(`bad numeric cell: ${raw}`);
  return { raw, num };
}

function bytesOf(size) {
  const m = /^(\d+)(KB|MB|GB)$/.exec(size);
  if (!m) throw new Error(`bad size: ${size}`);
  const mult = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  return Number(m[1]) * mult[m[2]];
}

// piwrite summary: '## mode=--full' section, one '### <size>' table per payload.
function parsePiwrite(text) {
  const full = text.split(/^## /m).find((c) => c.startsWith('mode=--full'));
  if (!full) throw new Error('no mode=--full section');
  const sizes = [];
  for (const chunk of full.split(/^### /m).slice(1)) {
    const name = chunk.split('\n', 1)[0].trim();
    const table = parseTables(chunk)[0];
    if (!table) continue;
    const arms = {};
    for (const r of rowMaps(table))
      arms[r.label] = { p50: cell(r['p50 ms/op']), mbs: cell(r['MB/s']) };
    sizes.push({ size: name, bytes: bytesOf(name), arms });
  }
  sizes.sort((a, b) => a.bytes - b.bytes); // stable: 4KB, 1MB, 16MB, 100MB
  return sizes;
}

// piread/pibash/piedit microbenches: the 'Dispatch latency (ms)' table.
function parseMicrobench(text, tool) {
  const table = parseTables(text).find(
    (t) => t.header.includes('oracle p50') && t.header.includes('oneshot p50'),
  );
  if (!table) throw new Error(`no dispatch latency table for ${tool}`);
  return rowMaps(table).map((r) => ({
    caseName: r[table.header[0]],
    baseline: cell(r['oracle p50']),
    native: cell(r[`${tool} p50`]),
    oneshot: cell(r['oneshot p50']),
  }));
}

// pidx: docs/native-tools.md summary table row, native cell '2.1 s → 28 ms'
// (baseline = cold full re-parse, native = warm cache hit).
function parsePidx(text) {
  const table = parseTables(text).find((t) => t.header.includes('native p50'));
  if (!table) throw new Error('no native-tools summary table');
  const row = rowMaps(table).find((r) => (r.Tool || '').includes('pidx'));
  if (!row) throw new Error('no pidx row');
  const m = /^([\d.]+)\s*s\s*→\s*([\d.]+)\s*ms$/.exec(row['native p50']);
  if (!m) throw new Error(`pidx cell did not parse: ${row['native p50']}`);
  return {
    baseline: { raw: `${m[1]} s`, num: Number(m[1]) * 1000 },
    native: { raw: `${m[2]} ms`, num: Number(m[2]) },
  };
}

// Throughput arms (2026-11-07): one '## Throughput (MB/s)' table per tool,
// first data row is the representative case; columns 'baseline MB/s' /
// 'native MB/s'. Numbers are MB/s = 32 MiB ÷ p50 s, one decimal.
function parseThroughput(text, tool, wantCase) {
  const table = parseTables(text).find((t) => t.header.includes('baseline MB/s'));
  if (!table) throw new Error(`no throughput table for ${tool}`);
  const rows = rowMaps(table);
  const r = wantCase
    ? rows.find((x) => x.case.replace(/-32mib$/, '') === wantCase)
    : rows[0];
  if (!r) throw new Error(`no throughput row ${wantCase ?? '[0]'} for ${tool}`);
  return {
    caseName: r.case.replace(/-32mib$/, ''), // payload stated once, in the panel header
    baseline: cell(r['baseline MB/s']),
    native: cell(r['native MB/s']),
  };
}

// ---- data assembly ---------------------------------------------------------------
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const piwriteSizes = parsePiwrite(read(SRC_PIWRITE));
const bySize = (name) => {
  const s = piwriteSizes.find((x) => x.size === name);
  if (!s) throw new Error(`no ${name} section in ${SRC_PIWRITE}`);
  return s;
};
const s4 = bySize('4KB');
const s1 = bySize('1MB');

const pickCase = (rows, name, src) => {
  const r = rows.find((x) => x.caseName === name);
  if (!r) throw new Error(`no case ${name} in ${src}`);
  return r;
};
const pireadOne = pickCase(parseMicrobench(read(SRC_PIREAD), 'piread'), 'one-line', SRC_PIREAD);
const pibashSeq = pickCase(parseMicrobench(read(SRC_PIBASH), 'pibash'), 'seq50000', SRC_PIBASH);
const pieditBig = pickCase(parseMicrobench(read(SRC_PIEDIT), 'piedit'), 'large-1mib', SRC_PIEDIT);
const pidx = parsePidx(read(SRC_NATIVE_TOOLS));
const tp = (src, tool, wantCase) => parseThroughput(read(src), tool, wantCase);
const tpPiread = tp(SRC_TP_PIREAD, 'piread');
const tpPibash = tp(SRC_TP_PIBASH, 'pibash');
const tpPiedit = tp(SRC_TP_PIEDIT, 'piedit');
const tpPiwrite = tp(SRC_TP_PIWRITE, 'piwrite');
const tpPidx = tp(SRC_TP_PIDX, 'pidx', 'warm-rerun');

const SERIES = [
  { key: 'baseline', name: 'built-in baseline (oracle / node-builtin / cold parse)', color: C.base },
  { key: 'native', name: 'native tool', color: C.native },
];

const panelA = {
  header: 'A — LATENCY · p50 ms per op · bars scaled per row · lower is better',
  yLabel: 'p50 latency — % of row max',
  unit: 'ms',
  groups: [
    { label: 'piread: one-line read', cells: { baseline: pireadOne.baseline, native: pireadOne.native } },
    { label: 'pibash: seq50000', cells: { baseline: pibashSeq.baseline, native: pibashSeq.native } },
    { label: 'piedit: large-1mib edit', cells: { baseline: pieditBig.baseline, native: pieditBig.native } },
    { label: 'piwrite: 4KB serve', cells: { baseline: s4.arms['node-builtin'].p50, native: s4.arms['piwrite-serve'].p50 } },
    { label: 'pidx: warm-cache reindex', cells: { baseline: pidx.baseline, native: pidx.native } },
  ],
};

const panelB = {
  header: 'B — THROUGHPUT · 32 MiB per op · MB/s · higher is better',
  yLabel: 'throughput — % of row max',
  unit: 'MB/s',
  ratio: 'nativeOverBase',
  groups: [
    { label: `piread: ${tpPiread.caseName}`, cells: { baseline: tpPiread.baseline, native: tpPiread.native } },
    { label: `pibash: ${tpPibash.caseName}`, cells: { baseline: tpPibash.baseline, native: tpPibash.native } },
    { label: `piedit: ${tpPiedit.caseName}`, cells: { baseline: tpPiedit.baseline, native: tpPiedit.native } },
    { label: `piwrite: ${tpPiwrite.caseName}`, cells: { baseline: tpPiwrite.baseline, native: tpPiwrite.native } },
    { label: `pidx: ${tpPidx.caseName}`, cells: { baseline: tpPidx.baseline, native: tpPidx.native } },
  ],
};

const TITLE = 'pi-native: native tools vs built-in baselines — latency & throughput';
const SUBTITLE =
  'tool-call-boundary microbenchmarks (dispatch / serve protocol), not agent-level task runs · p50 per op · one representative case per tool';

const caveat = `caveat: piwrite serve p50 trails built-in at 1–100 MB in-bench (1 MB: ${s1.arms['piwrite-serve'].p50.raw} vs ${s1.arms['node-builtin'].p50.raw} ms/op); large serves = kernel dirty-page throttling (${SRC_RUST_OPT})`;

const FOOTER = [
  `sources: benchmark/runs/{piread,pibash,piedit}-microbench-2026-10-27.md · ${SRC_PIWRITE} (mode=--full)`,
  `throughput (panel B): benchmark/runs/throughput-{piread,pibash,piedit,piwrite,pidx}-2026-11-07.md · 32 MiB per op · N=10/arm (5 warmup) · MB/s = 32 ÷ p50 s`,
  `${SRC_NATIVE_TOOLS} pidx row: 511 sessions / 110 MB, cold re-parse 2.1 s → warm 28 ms (re-measured 2026-10-28)`,
  caveat,
  'bar labels verbatim from source tables; xN.n sublabels = improvement ratio, computed (latency: baseline/native; throughput: native/baseline); full source paths in the SVG desc element',
];

const DESC = [
  TITLE,
  SUBTITLE,
  ...FOOTER,
  `full paths: ${[SRC_PIREAD, SRC_PIBASH, SRC_PIEDIT, SRC_PIWRITE, SRC_TP_PIREAD, SRC_TP_PIBASH, SRC_TP_PIEDIT, SRC_TP_PIWRITE, SRC_TP_PIDX, SRC_NATIVE_TOOLS, SRC_RUST_OPT].join('; ')}`,
].join(' | ');

const FOOTER_SHORT =
  'sources: benchmark/runs · benchmark/piwrite · docs/native-tools.md · bars scaled per row — citations in the SVG desc';

// ---- SVG rendering -----------------------------------------------------------------
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// One panel of grouped bars. Bars are scaled PER ROW: within a row, bar
// height is exactly proportional to the value; rows are not comparable
// across each other (the value label and xN.n ratio carry the numbers).
// Appends SVG fragments, returns bar count.
function renderPanel(parts, { panel, top, bottom, barMax }) {
  const L = 96;
  const R = 26;
  const W = 980;
  const plotL = L;
  const plotR = W - R;
  const plotW = plotR - plotL;
  const plotH = bottom - top;

  // Per-row linear scale: exact proportionality inside a row.
  const rowMax = (g) =>
    Math.max(...SERIES.flatMap((s) => (g.cells[s.key] ? [g.cells[s.key].num] : [])));
  const yOfRow = (v, max) => bottom - (v / max) * (plotH - 22); // 22 px label headroom
  const withUnit = (c) => {
    if (/\d\s*(ms|s|MB\/s)$/i.test(c.raw)) return c.raw;
    if (panel.unit === 'ms' && c.num >= 1000) return `${(c.num / 1000).toFixed(2)} s`;
    return `${c.raw} ${panel.unit ?? 'ms'}`;
  };

  parts.push(
    `<text x="${plotL}" y="${top - 14}" font-size="13" font-weight="700" fill="${C.text}">${esc(panel.header)}</text>`,
  );
  for (let k = 0; k <= 100; k += 25) {
    const y = (bottom - (k / 100) * (plotH - 22)).toFixed(1);
    parts.push(
      `<line x1="${plotL}" y1="${y}" x2="${plotR}" y2="${y}" stroke="${k === 0 ? C.axis : C.grid}" stroke-width="1"/>`,
      `<text x="${plotL - 10}" y="${y}" font-size="11" fill="${C.sub}" text-anchor="end" dominant-baseline="middle">${k}%</text>`,
    );
  }
  parts.push(
    `<line x1="${plotL}" y1="${bottom}" x2="${plotR}" y2="${bottom}" stroke="${C.axis}" stroke-width="1"/>`,
    `<text x="24" y="${top + plotH / 2}" font-size="12" fill="${C.sub}" text-anchor="middle" transform="rotate(-90 24 ${top + plotH / 2})">${esc(panel.yLabel)}</text>`,
  );

  const gw = plotW / panel.groups.length;
  let bars = 0;
  panel.groups.forEach((g, i) => {
    const center = plotL + gw * (i + 0.5);
    const innerW = Math.min(gw * 0.78, panel.groups.length === 1 ? 300 : Infinity);
    const slot = innerW / SERIES.length;
    const barW = Math.min(slot - 6, barMax);
    SERIES.forEach((s, j) => {
      const c = g.cells[s.key];
      if (!c) return;
      bars++;
      const x = center - innerW / 2 + slot * j + (slot - barW) / 2;
      const yTop = yOfRow(c.num, rowMax(g));
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(bottom - yTop, 1).toFixed(1)}" fill="${s.color}"/>`,
        `<text x="${(x + barW / 2).toFixed(1)}" y="${(yTop - 6).toFixed(1)}" font-size="11" fill="${C.text}" text-anchor="middle">${esc(withUnit(c))}</text>`,
      );
    });
    const labelFits = g.label.length * 6.6 <= gw;
    parts.push(
      labelFits
        ? `<text x="${center.toFixed(1)}" y="${bottom + 18}" font-size="11" fill="${C.text}" text-anchor="middle">${esc(g.label)}</text>`
        : `<text x="${center.toFixed(1)}" y="${bottom + 18}" font-size="11" fill="${C.text}" text-anchor="end" transform="rotate(-35 ${center.toFixed(1)} ${bottom + 18})">${esc(g.label)}</text>`,
    );
    const ratio = panel.ratio === 'nativeOverBase'
      ? g.cells.native.num / g.cells.baseline.num
      : g.cells.baseline.num / g.cells.native.num;
    parts.push(
      `<text x="${center.toFixed(1)}" y="${bottom + 33}" font-size="10" fill="${C.sub}" text-anchor="middle">x${ratio.toFixed(1)}</text>`,
    );
  });
  return bars;
}

function renderAllTools() {
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 920" width="980" height="920" role="img" aria-labelledby="chart-title chart-desc">`,
    `<title id="chart-title">${esc(TITLE)}</title>`,
    `<desc id="chart-desc">${esc(DESC)}</desc>`,
    `<rect x="0" y="0" width="980" height="920" fill="${C.bg}"/>`,
    `<g font-family="sans-serif">`,
    `<text x="96" y="32" font-size="20" font-weight="700" fill="${C.text}">${esc(TITLE)}</text>`,
    `<text x="96" y="54" font-size="12" fill="${C.sub}">${esc(SUBTITLE)}</text>`,
  );
  let lx = 96;
  for (const s of SERIES) {
    parts.push(
      `<rect x="${lx.toFixed(1)}" y="68" width="14" height="14" fill="${s.color}"/>`,
      `<text x="${(lx + 20).toFixed(1)}" y="79" font-size="12" fill="${C.text}">${esc(s.name)}</text>`,
    );
    lx += 34 + s.name.length * 7;
  }
  const barsA = renderPanel(parts, { panel: panelA, top: 126, bottom: 468, barMax: 46 });
  const barsB = renderPanel(parts, { panel: panelB, top: 550, bottom: 790, barMax: 110 });
  parts.push(`<text x="96" y="846" font-size="10" fill="${C.sub}">${esc(FOOTER_SHORT)}</text>`);
  parts.push(`</g></svg>\n`);
  return { svg: parts.join('\n'), bars: barsA + barsB, panels: 2 };
}

// ---- run ------------------------------------------------------------------------------
mkdirSync(dirname(OUT_FILE), { recursive: true });
const { svg, bars, panels } = renderAllTools();
writeFileSync(OUT_FILE, svg);
console.log(`wrote docs/assets/benchmarks/all-tools.svg — ${panels} panels, ${bars} bars`);
