import { icon } from '../icons.js';

// One instance belongs to one sidebar document. The entry point owns application state.
export function createSidebarControls() {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const buttonTemplates = new Map();

  function button(label, iconName, handler, className = 'icon-button') {
    const key = JSON.stringify([iconName, className]);
    if (!buttonTemplates.has(key)) {
      const template = el('button', className);
      template.type = 'button';
      if (iconName) template.append(icon(iconName));
      buttonTemplates.set(key, template);
    }
    const node = buttonTemplates.get(key).cloneNode(true);
    node.title = label;
    node.setAttribute('aria-label', label);
    if (handler)
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        handler(event);
      });
    return node;
  }

  return { el, button };
}
