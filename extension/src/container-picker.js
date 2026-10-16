import { containerListIcon } from './container-dialogs.js';
import { sortContainers } from './containers.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Keep native radio semantics while filtering only the visible choices. Filtering
// never changes the selection or reopens a tab on its own.
export function populateContainerPicker({
  containers,
  selectedStore,
  currentStore,
  inheritName,
  onSelect,
}) {
  const list = $('dialog-options');
  const search = $('container-search');
  const clear = $('container-search-clear');
  const status = $('container-search-status');
  const choices = [
    ...(inheritName ? [{ cookieStoreId: '', name: inheritName }] : []),
    { cookieStoreId: 'firefox-default', name: 'No container' },
    ...sortContainers(containers),
  ];
  list.replaceChildren();
  const rows = choices.map((container) => {
    const label = el('label', 'container-option');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'container';
    radio.value = container.cookieStoreId;
    radio.checked = container.cookieStoreId === selectedStore;
    radio.dataset.current = String(container.cookieStoreId === currentStore);
    radio.addEventListener('change', updateSelection);
    radio.addEventListener('focus', () => radio.scrollIntoView({ block: 'nearest' }));
    label.title = container.name;
    label.append(radio, containerListIcon(container), el('span', 'container-name', container.name));
    if (radio.dataset.current === 'true') label.append(el('span', 'container-current', 'Current'));
    label.append(icon('check', 'container-check'));
    list.append(label);
    return { label, radio, name: container.name.toLocaleLowerCase() };
  });
  const empty = el('p', 'container-empty', 'No containers found.');
  empty.hidden = true;
  list.append(empty);
  const unconfigured = el('p', 'container-empty', 'No containers are configured in Firefox.');
  unconfigured.hidden = containers.length > 0;
  list.append(unconfigured);

  function visibleRows() {
    return rows.filter(({ label }) => !label.hidden);
  }

  function updateSelection() {
    const selected = visibleRows().find(({ radio }) => radio.checked);
    onSelect(Boolean(selected && selected.radio.dataset.current !== 'true'));
  }

  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    for (const { label, radio, name } of rows) {
      label.hidden = !name.includes(query);
      // Hidden checked radios retain the choice for clearing the search, but
      // cannot receive focus or be submitted while they are filtered out.
      radio.disabled = label.hidden;
    }
    const count = visibleRows().length;
    empty.hidden = count > 0;
    unconfigured.hidden = containers.length > 0 || Boolean(query);
    clear.hidden = !search.value;
    status.textContent = count
      ? `${count} ${count === 1 ? 'container' : 'containers'} found.`
      : 'No containers found.';
    list.scrollTop = 0;
    updateSelection();
  }

  function choose(row) {
    if (!row) return;
    row.radio.checked = true;
    row.radio.focus();
    updateSelection();
  }

  search.oninput = filter;
  search.onkeydown = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || event.isComposing) return;
    event.preventDefault();
    const visible = visibleRows();
    // Enter chooses a result; confirmation still requires the submit action.
    choose(event.key === 'ArrowUp' ? visible.at(-1) : visible[0]);
  };
  list.onkeydown = (event) => {
    if (!['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const visible = visibleRows();
    choose(event.key === 'Home' ? visible[0] : visible.at(-1));
  };
  clear.onclick = () => {
    search.value = '';
    filter();
    search.focus();
  };
  clear.replaceChildren(icon('closeSmall'));
  const field = $('container-search-field');
  if (!field.querySelector(':scope > svg')) field.prepend(icon('search'));
  search.disabled = false;
  filter();
  search.focus();
}
