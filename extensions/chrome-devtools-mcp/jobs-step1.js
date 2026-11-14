() => {
  const main = document.querySelector('main');
  if (!main) return { done: true, err: 'no main' };
  const sc = main.querySelector('div.overflow-y-auto') || main;
  const el = sc;
  el.scrollTo({ top: el.scrollHeight });
  return { done: false, h: el.scrollHeight };
}
