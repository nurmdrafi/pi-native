async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // inner scroll container: the results main element
  const main = document.querySelector('main') || document.scrollingElement;
  const scroller = main && (main.querySelector('div.overflow-y-auto, [role="feed"]') ? main.querySelector('div.overflow-y-auto, [role="feed"]') : main);
  const getH = () => (scroller || document.body).scrollHeight;
  const collect = () => {
    const posts = document.querySelectorAll('main [data-id^="urn:li:activity"], main [data-urn*="activity"]');
    for (const p of posts) {
      const urn = p.getAttribute('data-id') || p.getAttribute('data-urn');
      if (!urn || seen.has(urn)) continue;
      const txt = (p.innerText || '').replace(/\s+/g, ' ').trim();
      const sub = p.querySelector('.update-components-actor__sub-description, .update-components-text-view.white-space-pre');
      const subTxt = sub ? sub.innerText.replace(/\s+/g, ' ').trim() : '';
      let url = '';
      const a = p.querySelector('a[href*="/posts/"], a[href*="/feed/update/"]');
      if (a) url = a.href;
      const nameEl = p.querySelector('.update-components-actor__title, .update-components-actor__name');
      const poster = nameEl ? nameEl.innerText.replace(/\s+/g, ' ').trim() : '';
      const body = p.querySelector('.feed-shared-update-v2__text, .feed-shared-text');
      const snippet = body ? body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200) : txt.slice(0, 200);
      seen.set(urn, { urn, poster, sub: subTxt, snippet, url, text: txt.slice(0, 1500) });
    }
  };
  const seen = new Map();
  let stall = 0, lastH = -1, cycles = 0;
  while (stall < 3) {
    collect();
    (scroller || window).scrollTo({ top: (scroller || document.documentElement).scrollHeight });
    await sleep(6000);
    collect();
    const h = getH();
    cycles++;
    if (h === lastH) stall++; else stall = 0;
    lastH = h;
  }
  (scroller || window).scrollTo({ top: 0 });
  await sleep(800);
  const footerOk = !!document.querySelector('main') && /footer|end of results|no more/i.test((document.querySelector('main').innerText || '').slice(-800) + ' ' + document.body.innerText.slice(-800));
  // ---- filter pass ----
  const drop = { open_to_work: 0, old: 0, india: 0, outside_no_remote: 0 };
  const matches = [], flagged = [];
  const ageDays = (s) => {
    const m = (s.match(/(\d+)\s*(mo|w|d|h)/i) || [])[0];
    if (!m) return null;
    const n = +m.match(/\d+/)[0], u = m.match(/[a-z]+$/i)[0].toLowerCase();
    if (u === 'h') return n / 24; if (u === 'd') return n;
    if (u === 'w') return n * 7; return n * 30;
  };
  for (const p of seen.values()) {
    const t = p.text;
    if (/open to work/i.test(t)) { drop.open_to_work++; continue; }
    const ad = ageDays(p.sub + ' ' + t);
    if (ad !== null && ad > 31) { drop.old++; continue; }
    const india = /\bindia\b|bengaluru|bangalore|gurgaon|gurugram|noida|pune|mumbai|hyderabad|chennai|delhi/i.test(t + ' ' + p.sub);
    const remote = /\bremote\b/i.test(t);
    const bd = /\bbangladesh\b|dhaka|chattogram|chittagong|khulna|sylhet/i.test(t + ' ' + p.sub);
    if (india && !bd) { drop.india++; continue; }
    if (!remote && !bd) { drop.outside_no_remote++; continue; }
    const row = {
      poster: p.poster, url: p.url || p.urn, snippet: p.snippet,
      origin_flag: (india && bd) || (!india && !bd && !remote) ? 'verify-origin' : ''
    };
    matches.push(row);
  }
  return { total_seen: seen.size, cycles, footerOk, drop, matches };
}
