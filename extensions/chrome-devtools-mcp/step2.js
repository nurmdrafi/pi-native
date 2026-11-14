() => {
  const h = window.__h || { seen: new Map() };
  const main = document.querySelector('main');
  const sc = main && (main.querySelector('div.overflow-y-auto') || main);
  const el = sc || document.documentElement;
  const height = el.scrollHeight;
  if (height === h.lastH) h.stall++; else h.stall = 0;
  h.lastH = height; h.cycles = (h.cycles || 0) + 1;
  const posts = document.querySelectorAll('main [role="listitem"]');
  for (const p of posts) {
    const txt = (p.innerText || '').replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    const key = 'k' + txt.length + ':' + txt.slice(0, 80);
    if (h.seen.has(key)) continue;
    const a = p.querySelector('a[href*="/posts/"], a[href*="/feed/update/"], a[href^="/in/"]');
    const headBlock = p.querySelector('a[href^="/in/"], [dir="ltr"] span');
    h.seen.set(key, {
      poster: headBlock ? headBlock.innerText.replace(/\s+/g, ' ').trim().split('\n')[0].slice(0, 120) : '',
      url: a ? a.href : '',
      snippet: txt.slice(0, 250), full: txt.slice(0, 1600)
    });
  }
  return { done: h.stall >= 3, stall: h.stall, cycles: h.cycles, height, seen: h.seen.size };
}
