import { icon } from './icons.js';
import { reconcileChildren } from './dom.js';
import { captureFocus, restoreFocusToken, captureScroll, restoreScroll } from './view-state.js';
import { isSavedForLater } from './model.js';
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
  getState,
  onOpen,
  onClose,
  onActivate,
  onReturn,
  onCloseTab,
  onMenu,
  onActions,
  onError = () => {},
}) {
  const events = new AbortController();
  let disposed = false;
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
  actions.addEventListener('click', (event) => {
    if (!onActions) return;
    const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]));
    onActions(event, visibleIds.map((id) => tabsById.get(id)).filter(Boolean), {
      kind: 'later',
      query: search.value,
    });
  });
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
  let savedScroll;

  function close({ restoreFocus = true } = {}) {
    if (pane.hidden) return;
    savedScroll = captureScroll(list, '.later-row', 'data-id', content);
    pane.hidden = true;
    root.classList.remove('later-open');
    rows.clear();
    list.replaceChildren();
    visibleIds = [];
    state = null;
    trigger.setAttribute('aria-expanded', 'false');
    onClose();
    if (restoreFocus) restoreFocusToken(savedFocus, trigger);
    savedFocus = null;
  }

  function makeRow(id) {
    const row = element('li', 'later-row');
    row.dataset.id = id;
    const open = button('Open saved tab', null, 'later-open-tab');
    open.dataset.rowAction = 'activate';
    const favicon = element('span', 'later-favicon');
    const label = element('span', 'later-label');
    open.append(favicon, label);
    const actions = element('div', 'later-row-actions');
    const restore = button('Return to original folder', 'group');
    const remove = button('Close tab', 'closeSmall');
    restore.dataset.rowAction = 'return';
    remove.dataset.rowAction = 'close';
    actions.append(restore, remove);
    row.append(open, actions);
    const item = { row, open, favicon, label, restore };
    return item;
  }

  function rowTarget(event) {
    const row = event.target.closest('.later-row');
    const id = Number(row?.dataset.id);
    const item = rows.get(id);
    if (pane.hidden || !item || item.row !== row || !list.contains(row)) return null;
    if (!state?.tabs.some((tab) => tab.id === id && isSavedForLater(tab))) return null;
    return { item, id };
  }

  async function run(control, id, action) {
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

  function context(event, target) {
    event.preventDefault();
    event.stopPropagation();
    target.item.open.focus({ preventScroll: true });
    const rect = target.item.open.getBoundingClientRect();
    onMenu(
      target.id,
      event.type === 'keydown' ? rect.left : event.clientX,
      event.type === 'keydown' ? rect.bottom : event.clientY,
    );
  }

  list.addEventListener(
    'click',
    (event) => {
      const target = rowTarget(event);
      const control = event.target.closest('button');
      if (!target || !control) return;
      if (control.dataset.rowAction === 'activate') onActivate(target.id);
      else if (control.dataset.rowAction === 'return') run(control, target.id, onReturn);
      else if (control.dataset.rowAction === 'close') run(control, target.id, onCloseTab);
    },
    { signal: events.signal },
  );
  list.addEventListener(
    'mousedown',
    (event) => {
      if (event.button === 1 && rowTarget(event)) event.preventDefault();
    },
    { signal: events.signal },
  );
  list.addEventListener(
    'auxclick',
    (event) => {
      const target = rowTarget(event);
      if (event.button !== 1 || !target) return;
      event.preventDefault();
      run(target.item.row.querySelector('[data-row-action="close"]'), target.id, onCloseTab);
    },
    { signal: events.signal },
  );
  list.addEventListener(
    'contextmenu',
    (event) => {
      const target = rowTarget(event);
      if (target) context(event, target);
    },
    { signal: events.signal },
  );
  list.addEventListener(
    'keydown',
    (event) => {
      const target = rowTarget(event);
      if (!target) return;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
        context(event, target);
      if (event.key === 'Delete' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        run(target.item.row.querySelector('[data-row-action="close"]'), target.id, onCloseTab);
      }
    },
    { signal: events.signal },
  );

  function render() {
    if (pane.hidden || !state) return;
    const saved = state.tabs.filter(isSavedForLater);
    const entries = laterResults(saved, { query: search.value, sort: sort.value });
    visibleIds = entries.map((tab) => tab.id);
    const total = saved.length;
    const groupsById = new Map(state.groups.map((group) => [group.id, group]));
    const focused = document.activeElement;
    const focusedIndex = list.contains(focused)
      ? [...list.children].findIndex((row) => row.contains(focused))
      : -1;
    const alive = new Set();
    for (const tab of entries) {
      alive.add(tab.id);
      if (!rows.has(tab.id)) rows.set(tab.id, makeRow(tab.id));
      const item = rows.get(tab.id);
      const source = sourceUrl(tab);
      const label = tab.title || source || 'New tab';
      // Keep unchanged text nodes connected for selection and native Find.
      // Saved rows stay mounted; a metadata refresh need only paint its changes.
      if (item.labelText !== label) {
        item.labelText = label;
        item.label.textContent = label;
        item.open.setAttribute('aria-label', label);
      }
      const title = source && source !== label ? `${label}\n${source}` : label;
      if (item.titleText !== title) {
        item.titleText = title;
        item.open.title = title;
      }
      const active = Boolean(tab.active);
      if (item.active !== active) {
        item.active = active;
        if (active) item.open.setAttribute('aria-current', 'true');
        else item.open.removeAttribute('aria-current');
        item.row.classList.toggle('active', active);
      }
      const folder = groupsById.get(tab.groupId)?.name || 'Home';
      const returnLabel = `Return to ${tab.pinned ? 'pinned tabs' : folder}`;
      if (item.returnLabel !== returnLabel) {
        item.returnLabel = returnLabel;
        item.restore.title = returnLabel;
        item.restore.setAttribute('aria-label', returnLabel);
      }
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
    if (disposed || !pane.hidden || !getState()) return;
    savedFocus = captureFocus();
    onOpen();
    state = getState();
    pane.hidden = false;
    root.classList.add('later-open');
    trigger.setAttribute('aria-expanded', 'true');
    fold.disabled = true;
    render();
    restoreScroll(list, savedScroll, content);
    dismiss.focus({ preventScroll: true });
  }

  dismiss.addEventListener('click', () => close(), { signal: events.signal });
  trigger.addEventListener('click', () => (pane.hidden ? open() : close()), {
    signal: events.signal,
  });
  search.addEventListener('input', render, { signal: events.signal });
  sort.addEventListener('change', render, { signal: events.signal });
  pane.addEventListener(
    'keydown',
    (event) => {
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
    },
    { signal: events.signal },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (
        event.key !== 'Escape' ||
        pane.hidden ||
        document.querySelector('dialog[open], #menu:not([hidden])')
      )
        return;
      event.preventDefault();
      close();
    },
    { signal: events.signal },
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!trigger.contains(event.target) && event.target.closest('footer'))
        close({ restoreFocus: false });
    },
    { capture: true, signal: events.signal },
  );
  return {
    open,
    close,

    dispose() {
      disposed = true;
      events.abort();
      state = savedFocus = savedScroll = null;
      visibleIds = [];
      rows.clear();
      list.replaceChildren();
      pane.hidden = true;
      root.classList.remove('later-open');
      pane.remove();
      trigger.remove();
    },

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
      if (disposed) return false;
      state = pane.hidden ? null : next;
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
