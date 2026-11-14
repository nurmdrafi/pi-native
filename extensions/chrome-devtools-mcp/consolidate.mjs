#!/usr/bin/env node
// consolidate.mjs — recovery-mode consolidation of run-2 passes into deliverables.
// usage: node consolidate.mjs <runDir> <startFid> <startRid> <ndjson>:<pass>:<query> ...
// - merges cross-pass duplicates (poster_url|poster + text key) into matched_queries
// - rows also seen in existing jobposts.ndjson get flag 'run2-recovered' (kept, never dropped)
// - renumbers new F-ids in global score order, appends to jobposts.ndjson
// - appends findings rows (R-ids) for every raw item incl. discard reasons
// - regenerates jobposts.md from the full jobposts.ndjson
// - deletes normalized raw dumps of this consolidation (named by --keep excluded list)
import { readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [runDir, startFidS, startRidS, ...specs] = process.argv.slice(2);
if (!runDir || !startFidS || !startRidS || specs.length < 1) { console.error('usage: consolidate.mjs <runDir> <startFid> <startRid> <ndjson>:<pass>:<query>...'); process.exit(2); }
let fid = parseInt(startFidS.replace(/^F/i, ''), 10);
let rid = parseInt(startRidS.replace(/^R/i, ''), 10);
const jpPath = join(runDir, 'jobposts.ndjson');
const exist = readFileSync(jpPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const existKeys = new Set(exist.map(r => key(r)));
const existSec = new Set(exist.map(r => (r.poster || '') + '|' + (r.age_chip || '') + '|' + r.score));
function key(r) { return ((r.poster_url || r.poster || '') + '|' + (r.full_text || '').slice(0, 80)).toLowerCase(); }
function secKey(r) { return (r.poster || '') + '|' + (r.age_chip || '') + '|' + r.score; }

// 1. load passes, cross-pass merge
const byKey = new Map();
const passOrder = [];
for (const spec of specs) {
  const [file, pass, query] = spec.split(':');
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  passOrder.push({ pass, query, file, raw: file.replace(/\.ndjson$/, '.rawmeta.json') });
  for (const r of rows) {
    const k = key(r);
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { row: r, passes: [query], rawFile: file });
    else {
      const qs = new Set([...prev.row.matched_queries, ...r.matched_queries]);
      prev.row.matched_queries = [...qs];
      for (const f of ['poster_url', 'post_url', 'age_chip', 'degree', 'contact_phone']) if (!prev.row[f] && r[f]) prev.row[f] = r[f];
      if ((r.full_text || '').length > (prev.row.full_text || '').length) prev.row.full_text = r.full_text;
      prev.passes.push(query);
    }
  }
}
// 2. recovery mark + renumber in score order
const merged = [...byKey.entries()].map(([k, v]) => {
  const r = { ...v.row };
  delete r.id;
  if ((existKeys.has(k) || existSec.has(secKey(r))) && !r.flags.includes('run2-recovered')) r.flags.push('run2-recovered');
  r._k = k;
  return r;
});
merged.sort((a, b) => b.score - a.score || (a.age_days ?? 999) - (b.age_days ?? 999));
for (const r of merged) { r.id = 'F' + String(fid++).padStart(3, '0'); }
// query field = first matched query in trained order
for (const r of merged) r.query = r.matched_queries[0];
// 3. append jobposts
appendFileSync(jpPath, merged.map(r => { const { _k, ...clean } = r; return JSON.stringify(clean); }).join('\n') + '\n');
// 4. findings rows for every raw item
const chipDays = (c) => { if (!c) return null; const m = String(c).match(/^(\d+)(mo|[hdw])$/i); if (!m) return null; const n = +m[1], u = m[2].toLowerCase(); return u === 'h' ? n / 24 : u === 'd' ? n : u === 'w' ? n * 7 : n * 30; };
const jobKeys = new Map(merged.map(r => [r._k, r]));
const fRows = [];
const rawFiles = [];
for (const spec of specs) {
  const [file, pass, query] = spec.split(':');
  // locate the raw dump that produced this ndjson (newest matching pass in raw/)
  const rawDir = join(runDir, 'raw');
  const tag = `${pass}-${query}`;
  const cands = readdirSync(rawDir).filter(f => f.endsWith(`-${tag}.json`)).sort();
  const rawFile = cands[cands.length - 1];
  if (!rawFile) { console.error(`WARN no raw dump for ${pass}`); continue; }
  rawFiles.push(join(rawDir, rawFile));
  let payload = readFileSync(join(rawDir, rawFile), 'utf8').trim();
  if (!/^[[{]/.test(payload)) { const a = payload.indexOf('```json'); const b = payload.lastIndexOf('```'); payload = payload.slice(a + 7, b).trim(); }
  const dump = JSON.parse(payload);
  for (const it of dump.items || []) {
    const age = chipDays(it.age_chip);
    let discard = '';
    if (it.peopleCard) discard = 'people-card';
    else if (age !== null && age > 31) discard = 'over-1mo';
    else if (/\b(intern|junior|jr\.?|fresher|entry[- ]level)\b|\b0[-–]2\s*(years|yrs)\b/i.test((it.text || '').slice(0, 300))) discard = 'intern-junior';
    const jk = ((it.poster_url || it.poster || '') + '|' + (it.text || '').slice(0, 80)).toLowerCase();
    const j = jobKeys.get(jk);
    fRows.push({
      ts: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Dhaka' }).slice(0, 16).replace(' ', 'T') + '+06:00',
      pass, title: it.poster || '', company: '', place: it.peopleCard ? 'people-card' : '', workplace: '',
      posted: it.age_chip || '', url: it.poster_url || it.post_url || '',
      flags: discard ? [`discard:${discard}`] : [], fit: j ? j.score : null, merged_from: [],
      id: 'R' + String(rid++).padStart(3, '0')
    });
  }
}
appendFileSync(join(runDir, 'findings.ndjson'), fRows.map(r => JSON.stringify(r)).join('\n') + '\n');
// 5. regenerate jobposts.md from full jobposts.ndjson
const all = readFileSync(jpPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const run2Start = parseInt(startFidS.replace(/^F/i, ''), 10);
const l1 = all.filter(r => parseInt(r.id.slice(1)) < run2Start);
const l2 = all.filter(r => parseInt(r.id.slice(1)) >= run2Start);
let md = '# Jobposts — 2026-11-13\n\n## Run 1 (F001-F067)\n\n';
md += l1.map(r => `- **${r.id}** ${r.query} — ${r.poster || r.contact_url.slice(0, 40)} (score ${r.score})`).join('\n');
md += `\n\n## Run 2 recovery (F${String(run2Start).padStart(3, '0')}+)\n\n`;
md += l2.map(r => `- **${r.id}** [${r.score}] ${r.poster}${r.age_chip ? ` · ${r.age_chip}` : ''} · ${r.location_type}${r.origin_flag ? ' · verify-origin' : ''} · ${r.apply_route} · ${r.contact_url}${r.flags.length ? ` · flags:${r.flags.join(',')}` : ''} — ${(r.full_text || '').slice(0, 90)}…`).join('\n');
md += '\n';
writeFileSync(join(runDir, 'jobposts.md'), md);
// 6. delete normalized raw dumps of these passes (recovery-mode: keep run-1 dumps)
for (const f of rawFiles) if (existsSync(f)) rmSync(f);
console.log(JSON.stringify({ merged_rows: merged.length, recovered: merged.filter(r => r.flags.includes('run2-recovered')).length, findings_appended: fRows.length, next_fid: 'F' + fid, next_rid: 'R' + rid, raw_deleted: rawFiles.map(f => f.split('/').pop()) }));
