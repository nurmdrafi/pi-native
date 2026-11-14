() => {
  const main = document.querySelector('main');
  const tail = main.innerText.replace(/\s+/g, ' ').slice(-500);
  const win = (document.querySelector('main') || {}).innerText ? '' : '';
  return { tail, scrollH: main.scrollHeight };
}
