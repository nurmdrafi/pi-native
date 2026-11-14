() => {
  const x = window.__x || { seen: new Map(), cls: new Map() };
  const kw = new URLSearchParams(location.search).get('keywords') || '';
  const brk = {};
  for (const c of (x.cls ? x.cls.values() : [])) brk[c] = (brk[c] || 0) + 1;
  return {
    url: location.href, keywords: kw, count: x.seen.size, breakdown: brk,
    items: [...x.seen.values()].map(v => ({
      poster: v.poster || '', poster_url: v.poster_url || '', post_url: v.post_url || '',
      age_chip: v.age_chip || '', degree: v.degree || '', edited: !!v.edited,
      badges: v.badges || [], phone: v.phone || '', wantsDm: !!v.wantsDm,
      peopleCard: !!v.peopleCard, text: v.text || ''
    }))
  };
}
