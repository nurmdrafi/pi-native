() => {
  const w = window;
  if (!w.__h) w.__h = { seen: new Map(), stall: 0, lastH: -1, cycles: 0 };
  const h = w.__h;
  const main = document.querySelector('main');
  const sc = main && (main.querySelector('div.overflow-y-auto') || main);
  const collect = () => {
    const posts = document.querySelectorAll('main [role="listitem"]');
    for (const p of posts) {
      const txt = (p.innerText || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      const key = 'k' + txt.length + ':' + txt.slice(0, 80);
      if (h.seen.has(key)) continue;
      const lines = txt.split(' ');
      const a = p.querySelector('a[href*="/posts/"], a[href*="/feed/update/"], a[href^="/in/"]');
      // header line: "Name 6d • Follow" — poster is text before the age chip line
      const headBlock = p.querySelector('a[href^="/in/"], [dir="ltr"] span');
      const poster = headBlock ? headBlock.innerText.replace(/\s+/g, ' ').trim().split('\n')[0].slice(0, 120) : '';
      h.seen.set(key, {
        poster, url: a ? a.href : '',
        snippet: txt.slice(0, 250), full: txt.slice(0, 1600)
      });
    }
  };
  collect();
  const el = sc || document.documentElement;
  el.scrollTo({ top: el.scrollHeight });
  return { done: false, stall: h.stall, cycles: h.cycles, seen: h.seen.size };
}
