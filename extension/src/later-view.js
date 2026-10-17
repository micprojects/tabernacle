import { icon } from './icons.js';
import { reconcileChildren } from './dom.js';
import { groupById, isSavedForLater } from './model.js';
import { laterResults } from './later.js';
import { sourceUrl } from './tab-source.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label, iconName, className) {
  const node = element('button', className);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  if (iconName) node.append(icon(iconName));
  return node;
}

export function createLaterView({
  root,
  onOpen,
  onClose,
  onActivate,
  onReturn,
  onCloseTab,
  onMenu,
  onActions,
  onError = () => {},
}) {
  const pane = element('section', 'later-view');
  pane.id = 'later-view';
  pane.hidden = true;
  pane.setAttribute('aria-labelledby', 'later-title');
  const heading = element('div', 'later-heading');
  const title = element('h1', '', 'Saved for Later');
  title.id = 'later-title';
  const dismiss = button('Close Saved for Later', 'close', 'later-dismiss');
  dismiss.id = 'later-close';
  heading.append(icon('later'), title, dismiss);
  const searchWrap = element('div', 'later-search');
  const search = element('input');
  search.id = 'later-search';
  search.type = 'search';
  search.placeholder = 'Search saved tabs';
  search.setAttribute('aria-label', 'Search saved tabs');
  searchWrap.append(icon('search'), search);
  const tools = element('div', 'later-tools');
  const count = element('span');
  count.setAttribute('role', 'status');
  const sort = element('select');
  sort.setAttribute('aria-label', 'Sort saved tabs');
  for (const [value, label] of [
    ['newest', 'Newest added'],
    ['oldest', 'Oldest added'],
  ]) {
    const option = element('option', '', label);
    option.value = value;
    sort.append(option);
  }
  const actions = button('Saved tabs actions', 'more', 'icon-button');
  actions.setAttribute('aria-haspopup', 'menu');
  actions.addEventListener('click', (event) =>
    onActions?.(
      event,
      visibleIds.map((id) => state.tabs.find((tab) => tab.id === id)).filter(Boolean),
      { kind: 'later', query: search.value },
    ),
  );
  tools.append(count, sort, actions);
  const content = element('div', 'later-content');
  const list = element('ul', 'later-list');
  list.setAttribute('aria-label', 'Saved tabs');
  const empty = element('div', 'later-empty');
  const emptyTitle = element('h2');
  const emptyText = element('p');
  empty.append(icon('later'), emptyTitle, emptyText);
  content.append(list, empty);
  pane.append(heading, searchWrap, tools, content);
  root.prepend(pane);
  const trigger = button('Saved for Later', 'later');
  trigger.id = 'later-toggle';
  trigger.disabled = true;
  trigger.setAttribute('aria-controls', pane.id);
  trigger.setAttribute('aria-expanded', 'false');
  root.querySelector('#domains-toggle').before(trigger);
  const fold = root.querySelector('#tree-toggle');
  const rows = new Map();
  let state, savedFocus;
  let visibleIds = [];

  function close({ restoreFocus = true } = {}) {
    if (pane.hidden) return;
    pane.hidden = true;
    root.classList.remove('later-open');
    trigger.setAttribute('aria-expanded', 'false');
    onClose();
    if (restoreFocus)
      (savedFocus?.isConnected ? savedFocus : trigger).focus({ preventScroll: true });
  }

  function makeRow(id) {
    const row = element('li', 'later-row');
    row.dataset.id = id;
    const open = button('Open saved tab', null, 'later-open-tab');
    const favicon = element('span', 'later-favicon');
    const label = element('span', 'later-label');
    open.append(favicon, label);
    const actions = element('div', 'later-row-actions');
    const restore = button('Return to original folder', 'group');
    const remove = button('Close tab', 'closeSmall');
    actions.append(restore, remove);
    row.append(open, actions);
    const item = { row, open, favicon, label, restore };
    open.addEventListener('click', () => onActivate(id));

    async function run(control, action) {
      if (control.getAttribute('aria-disabled') === 'true') return;
      control.setAttribute('aria-disabled', 'true');
      try {
        await action(id);
      } catch {
        onError('Could not update this tab. Try again.');
      } finally {
        control.removeAttribute('aria-disabled');
      }
    }

    restore.addEventListener('click', () => run(restore, onReturn));
    remove.addEventListener('click', () => run(remove, onCloseTab));
    row.addEventListener('mousedown', (event) => {
      if (event.button === 1) event.preventDefault();
    });
    row.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      run(remove, onCloseTab);
    });

    function context(event) {
      event.preventDefault();
      event.stopPropagation();
      open.focus({ preventScroll: true });
      const rect = open.getBoundingClientRect();
      onMenu(
        id,
        event.type === 'keydown' ? rect.left : event.clientX,
        event.type === 'keydown' ? rect.bottom : event.clientY,
      );
    }

    row.addEventListener('contextmenu', context);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) context(event);
      if (event.key === 'Delete' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        run(remove, onCloseTab);
      }
    });
    return item;
  }

  function render() {
    if (pane.hidden || !state) return;
    const saved = state.tabs.filter(isSavedForLater);
    const entries = laterResults(saved, { query: search.value, sort: sort.value });
    visibleIds = entries.map((tab) => tab.id);
    const total = state.tabs.filter(isSavedForLater).length;
    const focused = document.activeElement;
    const oldRows = [...list.children];
    const focusedIndex = oldRows.findIndex((row) => row.contains(focused));
    const alive = new Set();
    for (const tab of entries) {
      alive.add(tab.id);
      if (!rows.has(tab.id)) rows.set(tab.id, makeRow(tab.id));
      const item = rows.get(tab.id);
      const source = sourceUrl(tab);
      const label = tab.title || source || 'New tab';
      item.label.textContent = label;
      item.open.setAttribute('aria-label', label);
      item.open.title = source && source !== label ? `${label}\n${source}` : label;
      if (tab.active) item.open.setAttribute('aria-current', 'true');
      else item.open.removeAttribute('aria-current');
      item.row.classList.toggle('active', Boolean(tab.active));
      const folder = groupById(state, tab.groupId)?.name || 'Home';
      item.restore.title = `Return to ${tab.pinned ? 'pinned tabs' : folder}`;
      item.restore.setAttribute('aria-label', item.restore.title);
      if (item.url !== tab.favIconUrl || !item.favicon.childNodes.length) {
        item.url = tab.favIconUrl;
        let image = icon('globe');
        if (
          typeof item.url === 'string' &&
          /^(https?:|data:image\/|moz-extension:)/i.test(item.url)
        ) {
          image = element('img');
          image.alt = '';
          image.draggable = false;
          image.referrerPolicy = 'no-referrer';
          image.src = item.url;
          image.addEventListener('error', () => image.replaceWith(icon('globe')), { once: true });
        }
        item.favicon.replaceChildren(image);
      }
    }
    for (const id of rows.keys()) if (!alive.has(id)) rows.delete(id);
    reconcileChildren(
      list,
      entries.map((tab) => rows.get(tab.id).row),
    );
    count.textContent = `${entries.length === total ? total : `${entries.length} of ${total}`} ${total === 1 ? 'tab' : 'tabs'}`;
    empty.hidden = Boolean(entries.length);
    emptyTitle.textContent = total ? 'No matching tabs' : 'Nothing saved for later';
    emptyText.textContent = total
      ? 'Try another title or website address.'
      : 'Right-click a tab and choose Save for later.';
    if (focusedIndex >= 0 && !focused.isConnected) {
      const next = entries[Math.min(focusedIndex, entries.length - 1)];
      (next ? rows.get(next.id).open : search).focus({ preventScroll: true });
    }
  }

  function open() {
    if (!state || !pane.hidden) return;
    savedFocus = document.activeElement;
    onOpen();
    pane.hidden = false;
    root.classList.add('later-open');
    trigger.setAttribute('aria-expanded', 'true');
    fold.disabled = true;
    render();
    dismiss.focus({ preventScroll: true });
  }

  dismiss.addEventListener('click', () => close());
  trigger.addEventListener('click', () => (pane.hidden ? open() : close()));
  search.addEventListener('input', render);
  sort.addEventListener('change', render);
  pane.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, select'))
      return;
    const buttons = [...list.querySelectorAll('.later-open-tab')];
    const row = event.target.closest('.later-row');
    const position = buttons.findIndex((button) => button.closest('li') === row);
    let target;
    if (event.key === 'ArrowDown') target = buttons[Math.min(position + 1, buttons.length - 1)];
    else if (event.key === 'ArrowUp') target = buttons[Math.max(position - 1, 0)];
    else if (event.key === 'Home') target = buttons[0];
    else if (event.key === 'End') target = buttons.at(-1);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (
      event.key !== 'Escape' ||
      pane.hidden ||
      document.querySelector('dialog[open], #menu:not([hidden])')
    )
      return;
    event.preventDefault();
    close();
  });
  document.addEventListener(
    'click',
    (event) => {
      if (!trigger.contains(event.target) && event.target.closest('footer'))
        close({ restoreFocus: false });
    },
    true,
  );
  return {
    open,
    close,

    focusSearch() {
      search.focus();
      search.select();
    },

    get isOpen() {
      return !pane.hidden;
    },

    closeFilter: () =>
      pane.hidden
        ? null
        : { later: true, query: search.value, sort: sort.value, tabIds: visibleIds },

    update(next) {
      state = next;
      trigger.disabled = false;
      render();
      return !pane.hidden;
    },

    focusTab(id) {
      search.value = '';
      open();
      render();
      rows.get(id)?.open.focus();
    },
  };
}
