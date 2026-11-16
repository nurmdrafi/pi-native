() => {
  const h = window.__h || { seen: new Map() };
  const rows = [...h.seen.values()].map(p => {
    const text = p.full || p.snippet;
    const m = text.match(/(\d+)\s*(mo|w|d|h)\b/i);
    let age_days = null;
    if (m) {
      const n = +m[1], u = m[2].toLowerCase();
      age_days = u === 'h' ? n / 24 : u === 'd' ? n : u === 'w' ? n * 7 : n * 30;
    }
    const bd = /bangladesh|dhaka|chattogram|chittagong|khulna|sylhet/i.test(text);
    const india = /\bindia\b|bengaluru|bangalore|gurgaon|gurugram|noida|pune|mumbai|hyderabad|chennai|\bdelhi\b/i.test(text);
    const remote = /\bremote\b/i.test(text);
    const otw = /open to work/i.test(text);
    let discard = '';
    if (otw) discard = 'open_to_work';
    else if (age_days !== null && age_days > 31) discard = 'older_than_1mo';
    else if (india && !bd) discard = 'india_based';
    else if (!remote && !bd) discard = 'outside_bd_no_remote';
    return { poster: p.poster, url: p.url, snippet: p.snippet, age_days, discard, bd, india, remote };
  });
  const drop = {};
  rows.forEach(r => { if (r.discard) drop[r.discard] = (drop[r.discard] || 0) + 1; });
  const footer = (document.querySelector('main') || document.body).innerText.slice(-1000);
  const footerOk = /footer|no more results|end of results|try different/i.test(footer);
  return { total_seen: rows.length, footerOk, cycles: h.cycles || 0, drop, matches: rows.filter(r => !r.discard) };
}
