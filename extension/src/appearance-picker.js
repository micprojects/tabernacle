import { icon } from './icons.js';
import { folderContainerIconUrl, folderIcon, folderSymbol } from './folder-icons.js';
import {
  folderIcons,
  folderColors,
  folderAppearance,
  matchingFolderIcons,
  normalizeGroupAppearance,
} from './folder-appearance.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Local draft only: Save commits it, Cancel leaves the folder untouched.
export function createAppearancePicker({ group, container, state }) {
  let value = normalizeGroupAppearance(group.appearance);
  const element = el('div', 'appearance-picker');
  const preview = el('div', 'appearance-preview');
  const sample = el('span', 'appearance-sample');
  const details = el('div', 'appearance-details');
  const name = el('strong', '', group.name || 'New folder');
  name.title = name.textContent;
  const summary = el('span', 'appearance-summary');
  summary.setAttribute('aria-live', 'polite');
  details.append(name, summary);
  preview.append(sample, details);
  const usesContainer = Boolean(container);
  const usesContainerIcon = Boolean(folderContainerIconUrl(group, container));
  const defaultGroup = { ...group, appearance: {} };
  const inheritsColor = Boolean(folderAppearance(defaultGroup, undefined, state).color);
  const reset = el(
    'button',
    'appearance-reset',
    inheritsColor || (usesContainer && !usesContainerIcon)
      ? 'Reset icon and colour'
      : usesContainer
        ? 'Use container icon and colour'
        : 'Use folder icon and colour',
  );
  reset.type = 'button';
  reset.prepend(icon('undo'));
  reset.addEventListener('click', () => {
    value = {};
    update();
  });

  function choices(key, title, entries, defaultGlyph) {
    const field = el('fieldset', 'appearance-field');
    field.append(el('legend', '', title));
    const grid = el('div', 'appearance-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', title);
    const buttons = [
      {
        id: '',
        name:
          key === 'color' && inheritsColor
            ? 'Inherited colour'
            : `${(key === 'icon' ? usesContainerIcon : usesContainer) ? 'Container' : 'Folder'} ${title.toLowerCase()}`,
      },
      ...entries,
    ].map((entry) => {
      const button = el('button', 'appearance-choice');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', entry.name);
      button.title = entry.name;
      button.dataset.value = entry.id;
      if (!entry.id) {
        button.classList.add('appearance-default');
        button.append(defaultGlyph, document.createTextNode(entry.name));
      } else if (key === 'icon') button.append(folderSymbol(entry.id));
      else {
        const swatch = el('span', 'appearance-swatch');
        swatch.style.backgroundColor = entry.color;
        button.append(swatch);
      }
      button.addEventListener('click', () => {
        if (entry.id) value[key] = entry.id;
        else delete value[key];
        update();
      });
      grid.append(button);
      return button;
    });
    grid.addEventListener('keydown', (event) => {
      const visible = buttons.filter((button) => !button.hidden);
      const index = visible.indexOf(document.activeElement);
      if (index < 0) return;
      const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      let next;
      switch (event.key) {
        case 'ArrowRight':
          next = (index + 1) % visible.length;
          break;
        case 'ArrowLeft':
          next = (index + visible.length - 1) % visible.length;
          break;
        case 'ArrowDown':
          next = Math.min(visible.length - 1, index === 0 ? 1 : index + columns);
          break;
        case 'ArrowUp':
          next = Math.max(0, index - columns);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = visible.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      visible[next].focus();
      visible[next].click();
      visible[next].scrollIntoView({ block: 'nearest' });
    });
    field.append(grid);
    return { field, grid, buttons, key };
  }

  const colors = choices(
    'color',
    'Colour',
    folderColors,
    folderIcon(defaultGroup, container, { state }),
  );
  const icons = choices(
    'icon',
    'Icon',
    folderIcons,
    folderIcon(defaultGroup, container, { state }),
  );
  icons.grid.classList.add('appearance-icon-grid');
  const filters = el('div', 'appearance-filters');
  const searchWrap = el('div', 'appearance-search');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Find an icon…';
  search.setAttribute('aria-label', 'Find an icon');
  search.autocomplete = 'off';
  searchWrap.append(icon('search'), search);
  const category = el('select');
  category.setAttribute('aria-label', 'Icon category');
  for (const name of ['', ...new Set(folderIcons.map((item) => item.category))]) {
    const option = el('option', '', name || 'All icons');
    option.value = name;
    category.append(option);
  }
  filters.append(searchWrap, category);
  icons.field.insertBefore(filters, icons.grid);
  const results = el('p', 'appearance-results');
  results.setAttribute('role', 'status');
  icons.field.append(results);

  function filter() {
    const matches = matchingFolderIcons(search.value, category.value);
    const ids = new Set(matches.map(({ id }) => id));
    for (const button of icons.buttons)
      button.hidden = Boolean(button.dataset.value) && !ids.has(button.dataset.value);
    results.textContent = matches.length
      ? `${matches.length} ${matches.length === 1 ? 'icon' : 'icons'}`
      : 'No icons found. Try another word or category.';
    icons.grid.scrollTop = 0;
    update();
  }

  search.addEventListener('input', filter);
  category.addEventListener('change', filter);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      icons.buttons.find((button) => !button.hidden && button.dataset.value)?.focus();
    }
  });

  function update() {
    const draft = { ...group, appearance: value };
    sample.replaceChildren(folderIcon(draft, container, { state }));
    const iconName = folderIcons.find((item) => item.id === value.icon)?.name;
    const colorName = folderColors.find((item) => item.id === value.color)?.name;
    summary.textContent = [
      iconName || (usesContainerIcon ? `${container.name} icon` : 'Folder icon'),
      colorName ||
        (inheritsColor
          ? 'inherited colour'
          : usesContainer
            ? 'container colour'
            : 'default colour'),
    ].join(' · ');
    reset.disabled = !Object.keys(value).length;
    const color = folderAppearance(draft, container, state).color;
    element.style.setProperty(
      '--appearance-color',
      color && CSS.supports('color', color) ? color : 'var(--panel-text)',
    );
    for (const { buttons, key } of [icons, colors]) {
      const current = buttons.find((button) => button.dataset.value === (value[key] || ''));
      const focus = !current.hidden ? current : buttons.find((button) => !button.hidden);
      for (const button of buttons) {
        button.setAttribute('aria-checked', String(button === current));
        button.tabIndex = button === focus ? 0 : -1;
      }
    }
  }

  element.append(preview, reset, colors.field, icons.field);
  filter();
  return { element, getValue: () => ({ ...value }), focus: () => search.focus() };
}
