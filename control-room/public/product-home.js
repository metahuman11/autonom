// Original SVG workbench plus homepage localization.
import {getProductCopy} from './product-copy.mjs?v=unified-20260930';


function translate() {
  const copy = getProductCopy(document.documentElement.lang);
  document.querySelectorAll('[data-product-copy]').forEach(element => {
    const value = copy[element.dataset.productCopy];
    if (typeof value === 'string') element.textContent = value;
  });
  document.querySelectorAll('[data-product-label]').forEach(element => {
    const value = copy[element.dataset.productLabel];
    if (typeof value === 'string') element.setAttribute('aria-label', value);
  });
  const menu = document.querySelector('.app-menu');
  if (menu) {
    menu.dataset.openLabel = copy.menu;
    menu.dataset.closeLabel = copy.closeMenu;
    menu.setAttribute('aria-label', copy[menu.getAttribute('aria-expanded') === 'true' ? 'closeMenu' : 'menu']);
  }
}

new MutationObserver(translate).observe(document.documentElement, {attributes:true, attributeFilter:['lang']});
translate();
