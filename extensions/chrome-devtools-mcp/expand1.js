async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const w = window;
  if (!w.__x) w.__x = { seen: new Map(), clicks: 0, stall: 0, lastH: -1, pos: 0, cls: new Map() };
  const x = w.__x;
  const main = document.querySelector('main');
  const sc = (main && main.querySelector('div.overflow-y-auto')) || main || document.documentElement;
  const isMatch = (t) => {
    const t2 = t.replace(/#[A-Za-z0-9_]+/g, '');
    const bd = /bangladesh|dhaka|chattogram|chittagong|khulna|sylhet/i.test(t2);
    const remote = /\bremote\b/i.test(t2);
    return !/open to work/i.test(t) && (bd || remote);
  };
  const collect = () => {
    const items = document.querySelectorAll('main [role="listitem"]');
    let expandedHere = 0;
    for (const p of items) {
      const txt = (p.innerText || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      const key = 'k' + txt.length + ':' + txt.slice(0, 80);
      const peopleCard = [...p.querySelectorAll('button')].some(b => /^connect$/i.test((b.innerText || '').trim())) && !p.querySelector('a[href*="/posts/"], a[href*="/feed/update/"]');
      const matched = isMatch(txt);
      if (!x.cls.has(key)) x.cls.set(key, matched ? (peopleCard ? 'people-card' : 'matched') : (/open to work/i.test(txt) ? 'open-to-work' : 'non-match'));
      if (!matched) continue;
      const prev = x.seen.get(key);
      if (!prev) {
        const more = [...p.querySelectorAll('button, span, div[role="button"]')].find(e => /^…?\s*more$/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()) && e.offsetParent !== null);
        if (more) { try { more.click(); x.clicks++; expandedHere++; } catch (e) {} }
      }
      const prof = p.querySelector('a[href^="/in/"], a[href*="linkedin.com/in/"], a[href*="/company/"], a[href*="linkedin.com/company/"]');
      const posterUrl = prof ? prof.href.split('?')[0] : '';
      const head = txt.slice(0, 150);
      let poster = prof ? (prof.innerText || '').replace(/\s+/g, ' ').trim().split('•')[0] : '';
      if (!poster) {
        const m1 = txt.match(/^feed post\s+(.+?)(?:\s+[123](?:st|nd|rd)\+?\b|\s+\d+mo\b|\s+\d+[hdw]\b|\s+follow(?:ing)?\b|•)/i) || txt.match(/^(.+?)(?:\s+[123](?:st|nd|rd)\+?\b|\s+\d+mo\b|\s+\d+[hdw]\b|\s+follow(?:ing)?\b|•)/);
        poster = m1 ? m1[1] : '';
      }
      poster = poster.replace(/\b(premium|verified)\b/gi, '').replace(/[•·]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      const badges = [];
      if (/premium/i.test(head)) badges.push('premium');
      if (/verified/i.test(head) && !/opportunit/i.test(head)) badges.push('verified');
      const pa = p.querySelector('a[href*="/posts/"], a[href*="/feed/update/"]');
      const postUrl = pa ? pa.href.split('?')[0] : '';
      const chipM = head.match(/\b(\d+mo|\d+[hdw])\b/i);
      const ageChip = chipM ? chipM[1].toLowerCase() : '';
      let degree = 'none';
      const degM = head.match(/\b([123])(st|nd|rd)(\+)?\b/);
      if (degM) degree = degM[1] + degM[2] + (degM[3] || '');
      else if (/\bfollowing\b/i.test(head)) degree = 'following';
      const edited = /\bedited\b/i.test(head);
      const phone = (txt.match(/\+?[0-9][0-9 -]{8,14}[0-9]/) || [])[0] || '';
      const wantsDm = /\b(dm|direct message|inbox)\b.{0,40}(me|us|for|now)|\b(send|drop|message).{0,20}\b(dm|inbox)\b/i.test(txt);
      const nu = {
        text: txt.slice(0, 6000), poster: poster, poster_url: posterUrl, post_url: postUrl,
        age_chip: ageChip, degree: degree, edited: edited, badges: badges, phone: phone,
        wantsDm: wantsDm, peopleCard: peopleCard
      };
      if (!prev) x.seen.set(key, nu);
      else {
        for (const k of Object.keys(nu)) {
          const v = nu[k];
          if (k === 'text') { if (v.length > prev.text.length) prev.text = v; }
          else if (typeof v === 'boolean') { if (v) prev[k] = true; }
          else if (Array.isArray(v)) { if (v.length) prev[k] = v; }
          else if (v && v !== 'none') prev[k] = v;
        }
      }
    }
    return expandedHere;
  };
  // jittered stepped scrolling: 3-6 steps of 300-800px, 80-250ms apart,
  // 20% chance of a brief back-scroll before continuing
  const steps = rnd(3, 6);
  const max = sc.scrollHeight - sc.clientHeight;
  for (let i = 0; i < steps; i++) {
    if (Math.random() < 0.2) { x.pos = Math.max(0, x.pos - rnd(150, 400)); sc.scrollTo({ top: x.pos }); await sleep(rnd(200, 600)); }
    x.pos = Math.min(max, x.pos + rnd(300, 800));
    sc.scrollTo({ top: x.pos });
    await sleep(rnd(80, 250));
  }
  if (x.pos >= max - 50) sc.scrollTo({ top: sc.scrollHeight }); // ensure load trigger at bottom
  await sleep(rnd(150, 400));
  const expandedHere = collect();
  const h = sc.scrollHeight;
  if (h === x.lastH) x.stall++; else x.stall = 0;
  x.lastH = h;
  const brk = {};
  for (const c of x.cls.values()) brk[c] = (brk[c] || 0) + 1;
  return { clicked: x.clicks, collected: x.seen.size, expandedHere, h, stall: x.stall, pos: x.pos, breakdown: brk, done: x.stall >= 3 && x.pos >= max - 50 };
}
