// The shared shell is part of the HTML. Enhance its menu without moving page content.
(() => {
  const body = document.body;
  if (!body) return;
  const visibility = () => body.classList.toggle('app-page-hidden', document.hidden);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', () => body.classList.add('app-page-hidden'));
  window.addEventListener('pageshow', visibility);
  visibility();

  const bar = document.querySelector('.app-topnav');
  // A briefly cached legacy page keeps its original navigation and controls.
  // Never hide it behind a splash or attempt another body-wide reconstruction.
  if (!bar || bar.dataset.enhanced === 'true') return;
  const menu = bar.querySelector('.app-menu');
  const links = bar.querySelector('.app-links');
  if (!menu || !links) return;
  bar.dataset.enhanced = 'true';
  menu.dataset.productLabel = 'menu';
  const open = () => bar.classList.contains('menu-open');
  const closeMenu = (restoreFocus = false) => {
    if (!open()) return;
    bar.classList.remove('menu-open');
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', menu.dataset.openLabel || 'Open menu');
    if (restoreFocus) menu.focus();
  };
  menu.addEventListener('click', () => {
    if (open()) { closeMenu(); return; }
    bar.classList.add('menu-open');
    menu.setAttribute('aria-expanded', 'true');
    menu.setAttribute('aria-label', menu.dataset.closeLabel || 'Close menu');
    links.querySelector('a')?.focus();
  });
  links.addEventListener('click', event => {
    if (event.target.closest?.('a')) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open()) { event.preventDefault(); closeMenu(true); }
  });
  document.addEventListener('click', event => {
    if (!bar.contains(event.target)) closeMenu();
  });
  matchMedia('(min-width:761px)').addEventListener('change', () => closeMenu());
})();
