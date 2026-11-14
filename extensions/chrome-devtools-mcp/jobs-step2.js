() => {
  const h = window.__jh || (window.__jh = { seen: new Map(), stall: 0, lastH: -1 });
  const main = document.querySelector('main');
  const sc = main.querySelector('div.overflow-y-auto') || main;
  const height = sc.scrollHeight;
  if (height === h.lastH) h.stall++; else h.stall = 0;
  h.lastH = height;
  const cards = document.querySelectorAll('main [role="listitem"], main li');
  for (const c of cards) {
    const txt = (c.innerText || '').replace(/\s+/g, ' ').trim();
    if (!txt || txt.length < 30) continue;
    const a = c.querySelector('a[href*="/jobs/"]');
    const key = 'k' + txt.length + ':' + txt.slice(0, 60);
    if (h.seen.has(key)) continue;
    h.seen.set(key, { url: a ? a.href : '', text: txt.slice(0, 500) });
  }
  return { done: h.stall >= 3, stall: h.stall, height, seen: h.seen.size };
}
