#!/usr/bin/env node
// normalize.mjs — raw expand2 dump -> jobposts.ndjson rows (schema-exact).
// usage: node normalize.mjs <raw-dump.json> '<#hiring query>' [startFid]
// Emits valid NDJSON rows (score-desc) to stdout; rejects + discard counts to stderr.
import { readFileSync } from 'node:fs';

const [rawPath, queryArg, startArg] = process.argv.slice(2);
if (!rawPath || !queryArg) { console.error('usage: node normalize.mjs <raw.json> <query> [startFid]'); process.exit(2); }
let payload = readFileSync(rawPath, 'utf8').trim();
if (!/^[[{]/.test(payload)) { const a = payload.indexOf('```json'); const b = payload.lastIndexOf('```'); payload = payload.slice(a >= 0 ? a + 7 : 0, b > a ? b : undefined).trim(); }
const raw = JSON.parse(payload);
const query = queryArg.startsWith('#') ? queryArg : decodeURIComponent(raw.keywords || '');
const fid = startArg ? parseInt(startArg.replace(/^F/i, ''), 10) : 1;

const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Dhaka' }).slice(0, 16).replace(' ', 'T') + '+06:00';
const strip = (t) => t.replace(/[\u200b\u200c\ufeff]/g, '').replace(/^feed post\s*/i, '').replace(/…\s*more\s+\d+(\s+\d+)?\s*$/i, '').replace(/\s+/g, ' ').trim();
const chipDays = (c) => { if (!c) return null; const m = c.match(/^(\d+)(mo|[hdw])$/i); if (!m) return null; const n = +m[1], u = m[2].toLowerCase(); return u === 'h' ? n / 24 : u === 'd' ? n : u === 'w' ? n * 7 : n * 30; };

let discards = { 'people-card': 0, 'intern-junior': 0, 'over-1mo': 0, 'india-evidence': 0, 'contact-url-missing': 0, 'schema-invalid': 0, 'empty': 0 };
const rows = [];
for (const it of raw.items || []) {
  const text = strip(it.text || '');
  if (!it.peopleCard && (!it.poster || text.length < 10)) { discards['empty']++; continue; }
  if (it.peopleCard) { discards['people-card']++; continue; } // tagged in raw, excluded from jobposts (SKILL)
  const t2 = text.replace(/#[A-Za-z0-9_]+/g, '');
  const low = t2.toLowerCase();
  if (/\b(intern|junior|jr\.?|fresher|entry[- ]level)\b|\b0[-–]2\s*(years|yrs)\b/i.test(t2.slice(0, 300))) { discards['intern-junior']++; continue; }
  const age = chipDays(it.age_chip);
  if (age !== null && age > 31) { discards['over-1mo']++; continue; }
  const bd = /bangladesh|dhaka|chattogram|chittagong|khulna|sylhet/i.test(t2);
  const india = /\bindia\b|bengaluru|bangalore|gurgaon|gurugram|noida|pune|mumbai|hyderabad|chennai|\bdelhi\b/i.test(t2);
  const remote = /(^|[^a-z])remote([^a-z]|$)/i.test(t2);
  if (india && !bd && !remote) { discards['india-evidence']++; continue; }
  const link = t2.match(/(https?:\/\/[^\s]+|mailto:[^\s]+|lnkd\.in\/[^\s]+)/i);
  const wantsDm = !!it.wantsDm || /\b(dm|direct message|inbox)\b.{0,40}(me|us|for|now)|\b(send|drop|message).{0,20}\b(dm|inbox)\b/i.test(t2);
  const comment = /\bcomment\b.{0,30}(details|info|link|below|interested)/i.test(t2);
  let contact_url = '', apply_route = 'dm-poster';
  if (link && !wantsDm && !comment) { contact_url = link[1]; apply_route = 'link'; }
  else if (wantsDm) { contact_url = it.poster_url || it.post_url || (link ? link[1] : ''); }
  else if (comment) { contact_url = it.poster_url || it.post_url || (link ? link[1] : ''); apply_route = 'comment'; }
  else contact_url = it.poster_url || it.post_url || (link ? link[1] : '');
  if (!contact_url) { discards['contact-url-missing']++; continue; }
  let score = 0;
  if (/\breact\b/.test(low)) score += 3;
  if (/\bnext( ?js|\.js)\b/.test(low)) score += 3;
  if (/\btypescript\b/.test(low)) score += 3;
  if (/\bgis\b/.test(low)) score += 3;
  for (const k of ['frontend', 'javascript', 'map', 'geo', 'tailwind', 'webgl', 'leaflet']) if (low.includes(k)) score += 2;
  if (/\bsenior\b|\blead\b/.test(low)) score += 1;
  for (const k of ['vue', 'angular', 'svelte']) if (new RegExp(`\\b${k}\\b`).test(low)) score -= 2;
  for (const k of ['wordpress', 'laravel']) if (low.includes(k)) score -= 3;
  if (/\bphp\b/.test(low)) score -= 3;
  score = Math.max(0, score);
  let poster = (it.poster || '').replace(/\b(premium|verified)\b/gi, '').replace(/[•·]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (poster.length < 2 || poster.toLowerCase() === 'post') {
    const m = text.match(/^feed post\s+(.+?)(?:\s+[123](?:st|nd|rd)\+?\b|\s+\d+mo\b|\s+\d+[hdw]\b|\s+follow(?:ing)?\b|•)/i) || text.match(/^(.+?)(?:\s+[123](?:st|nd|rd)\+?\b|\s+\d+mo\b|\s+\d+[hdw]\b|\s+follow(?:ing)?\b|•)/);
    poster = m ? m[1].trim().slice(0, 120) : '';
  }
  const flags = [];
  if (!it.post_url) flags.push('no-permalink');
  if (age !== null && age >= 25) flags.push('near-1mo');
  if (wantsDm) flags.push('wants-dm');
  if (it.phone) flags.push('phone-in-post');
  const row = {
    query, poster, age_days: age,
    location_type: remote ? 'remote' : bd ? 'bd' : 'unknown',
    origin_flag: ((india && bd) || (!india && !bd)) ? 'verify-origin' : '',
    score, apply_route, contact_url, full_text: text, flags, ts
  };
  if (it.poster_url && /^https:\/\/(www\.)?linkedin\.com\/(in|company)\/[A-Za-z0-9_%-]+\/?$/.test(it.poster_url)) row.poster_url = it.poster_url;
  if (it.post_url && /^https:\/\//.test(it.post_url)) row.post_url = it.post_url;
  if (/^(\d+[hdw]|\d+mo)$/.test(it.age_chip || '')) row.age_chip = it.age_chip;
  if (['1st', '2nd', '3rd', '3rd+', 'following'].includes(it.degree)) row.degree = it.degree;
  if (it.edited) row.edited = true;
  if (Array.isArray(it.badges) && it.badges.length) row.poster_badge = it.badges.filter(b => ['premium', 'verified'].includes(b));
  if (it.phone && /^\+?[0-9][0-9 -]{7,14}$/.test(it.phone)) row.contact_phone = it.phone;
  if ((it.text || '').length >= 6000) row.full_text_truncated = true;
  row.matched_queries = [query];
  // field-by-field validation (schema has no validator pkg; mirror constraints)
  const errs = [];
  if (!row.poster) errs.push('poster');
  if (!row.full_text || row.full_text.length < 10) errs.push('full_text');
  if (!row.contact_url) errs.push('contact_url');
  if (!['remote', 'bd', 'unknown'].includes(row.location_type)) errs.push('location_type');
  if (!['link', 'dm-poster', 'comment'].includes(row.apply_route)) errs.push('apply_route');
  if (!Number.isInteger(row.score) || row.score < 0) errs.push('score');
  if (row.age_days !== null && (row.age_days < 0)) errs.push('age_days');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+\d{2}:\d{2}$/.test(row.ts)) errs.push('ts');
  if (errs.length) { discards['schema-invalid']++; console.error(`REJECT poster="${(it.poster || '').slice(0, 40)}" fields=${errs.join(',')}`); continue; }
  rows.push(row);
}
rows.sort((a, b) => b.score - a.score);
rows.forEach((r, i) => { r.id = 'F' + String(fid + i).padStart(3, '0'); process.stdout.write(JSON.stringify(r) + '\n'); });
console.error(`SUMMARY items=${(raw.items || []).length} emitted=${rows.length} discards=${JSON.stringify(discards)}`);
