() => {
  const h = window.__jh || { seen: new Map() };
  const rows = [...h.seen.values()].map(p => {
    const t = p.text;
    const bd = /bangladesh|dhaka|chattogram|chittagong|khulna|sylhet/i.test(t);
    const india = /\bindia\b|bengaluru|bangalore|gurgaon|gurugram|noida|pune|mumbai|hyderabad|chennai|\bdelhi\b/i.test(t);
    const remote = /\bremote\b/i.test(t);
    let discard = '';
    if (india && !bd) discard = 'india_based';
    else if (!remote && !bd) discard = 'outside_bd_no_remote';
    return { url: p.url, snippet: t.slice(0, 200), discard };
  });
  const drop = {};
  rows.forEach(r => { if (r.discard) drop[r.discard] = (drop[r.discard] || 0) + 1; });
  return { total_seen: rows.length, drop, matches: rows.filter(r => !r.discard) };
}
