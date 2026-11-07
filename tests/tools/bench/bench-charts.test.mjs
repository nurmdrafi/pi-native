import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = resolve(ROOT, 'scripts', 'bench-charts.mjs');

const BAR_FILLS = new Set(['#58a6ff', '#6e7681']); // native, baseline

function render(outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, PI_BENCH_CHART_OUT: outPath },
  });
  return readFileSync(outPath, 'utf8');
}

/** Bar rects: [ { fill, y, height, label } ] in document order. */
function parseBars(svg) {
  const bars = [];
  const re = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9a-f]{6})"\/>\s*<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]+)<\/text>/g;
  let m;
  while ((m = re.exec(svg))) {
    if (!BAR_FILLS.has(m[5])) continue;
    if (Number(m[3]) <= 15) continue; // legend swatches are 14 px wide; bars are 46/110
    bars.push({ y: Number(m[2]), height: Number(m[4]), fill: m[5], labelY: Number(m[7]), label: m[8].trim() });
  }
  return bars;
}

const ms = (label) => {
  const m = /([\d.]+)\s*(ms|s)\s*$/.exec(label);
  assert.ok(m, `label without time unit: ${JSON.stringify(label)}`);
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
};

test('generated chart: exact bar proportions, unit labels, short footer, deterministic', () => {
  const out1 = resolve(ROOT, '.cache', 'bench-charts-test-1.svg');
  const out2 = resolve(ROOT, '.cache', 'bench-charts-test-2.svg');
  let svg;
  try {
    svg = render(out1);
    const again = render(out2);
    assert.equal(svg, again, 'two runs must be byte-identical');

    // 1) no log scale anywhere
    assert.ok(!/log10/i.test(svg), 'chart must not use a log10 scale');

    // 2) latency panel bars (y < 500) come in baseline/native pairs; heights
    //    must be exactly proportional to the labeled values (per-row scale)
    const bars = parseBars(svg).filter((b) => b.y < 500);
    assert.ok(bars.length >= 10, `expected >=10 latency bars, got ${bars.length}`);
    for (let i = 0; i + 1 < bars.length; i += 2) {
      const [base, nat] = [bars[i], bars[i + 1]];
      const hRatio = base.height / nat.height;
      const vRatio = ms(base.label) / ms(nat.label);
      const rel = Math.abs(hRatio - vRatio) / vRatio;
      assert.ok(rel <= 0.02, `row ${i / 2}: height ratio ${hRatio.toFixed(3)} != value ratio ${vRatio.toFixed(3)}`);
    }

    // 3) every latency bar label carries an explicit time unit
    for (const b of bars) assert.match(b.label, /\d\s*(ms|s)$/, `unlabeled unit: ${b.label}`);

    // 3b) no bar value label may intrude above its panel top (header overlap)
    for (const b of bars) assert.ok(b.labelY >= 140, `label above panel top: y=${b.labelY} ${b.label}`);

    // 3c) the left vertical axis carries a measurement (percent of row max)
    for (const tick of ['0%', '50%', '100%']) {
      assert.ok(new RegExp(`text-anchor="end"[^<]*>${tick}<`).test(svg), `missing left tick ${tick}`);
    }

    // 4) footer: at most two lines, each short
    const footer = [...svg.matchAll(/<text x="96" y="(8[4-9]\d)(?:\.\d)?" font-size="10"[^>]*>([^<]+)</g)]
      .map((m) => m[2]);
    assert.ok(footer.length <= 2, `footer has ${footer.length} lines`);
    for (const line of footer) assert.ok(line.length <= 120, `footer line too long (${line.length}): ${line.slice(0, 60)}`);
  } finally {
    rmSync(out1, { force: true });
    rmSync(out2, { force: true });
  }
});

const mbs = (label) => {
  const m = /([\d.]+)\s*MB\/s$/.exec(label);
  assert.ok(m, `label without MB/s unit: ${JSON.stringify(label)}`);
  return Number(m[1]);
};

test('throughput panel: all five native tools, MB/s labels, per-row proportions', () => {
  const out = resolve(ROOT, '.cache', 'bench-charts-tp-test.svg');
  let svg;
  try {
    svg = render(out);

    // 1) one or two throughput rows per native tool, case-named; the 32 MiB
    //    payload is stated once (panel header) — never repeated in row labels
    for (const tool of ['piread', 'pibash', 'piedit', 'piwrite', 'pidx']) {
      assert.ok(
        new RegExp(`${tool}: \\S+`).test(svg),
        `missing throughput row label for ${tool}`,
      );
    }
    assert.ok(!/-32mib/.test(svg), 'payload must not be repeated inside row labels');
    assert.match(svg, /pidx: warm-rerun/, 'missing pidx warm-rerun row label');
    assert.ok(/B — THROUGHPUT · 32 MiB per op · MB\/s · higher is better/.test(svg), 'wrong throughput panel header');

    // 2) throughput bars (y > 500) come in baseline/native pairs, exactly
    //    proportional to the labeled MB/s values (per-row linear scale)
    const bars = parseBars(svg).filter((b) => b.y > 500);
    assert.equal(bars.length, 12, `expected 12 throughput bars (5 tools + pidx warm-rerun), got ${bars.length}`);
    for (let i = 0; i + 1 < bars.length; i += 2) {
      const [base, nat] = [bars[i], bars[i + 1]];
      assert.equal(base.fill, '#6e7681', `pair ${i / 2}: first bar must be baseline`);
      assert.equal(nat.fill, '#58a6ff', `pair ${i / 2}: second bar must be native`);
      const hRatio = nat.height / base.height;
      const vRatio = mbs(nat.label) / mbs(base.label);
      const rel = Math.abs(hRatio - vRatio) / vRatio;
      assert.ok(rel <= 0.02, `row ${i / 2}: height ratio ${hRatio.toFixed(3)} != value ratio ${vRatio.toFixed(3)}`);
    }

    // 3) every throughput bar label carries an explicit MB/s unit
    for (const b of bars) assert.match(b.label, /\d\s*MB\/s$/, `unlabeled unit: ${b.label}`);
  } finally {
    rmSync(out, { force: true });
  }
});
