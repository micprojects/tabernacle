import { icon } from './icons.js';
import { reconcileChildren } from './dom.js';
import { captureFocus, restoreFocusToken, captureScroll, restoreScroll } from './view-state.js';
import { listDomains } from './domains.js';

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

export function createDomainsView({ root, getState, onOpen, onClose, onSelect, onPin, onMenu }) {
  const events = new AbortController();
  let disposed = false;
  const pane = element('section', 'domains-view');
  pane.id = 'domains-view';
  pane.hidden = true;
  pane.setAttribute('aria-labelledby', 'domains-title');
  const heading = element('div', 'domains-heading');
  const title = element('h1', '', 'Domains');
  title.id = 'domains-title';
  const dismiss = button('Close domains view', 'close', 'domains-close');
  const actions = button('Domains actions', 'more', 'icon-button');
  actions.setAttribute('aria-haspopup', 'menu');
  actions.addEventListener('click', (event) => onMenu?.(event));
  heading.append(icon('globe'), title, dismiss);
  const tools = element('div', 'domains-tools');
  const count = element('span');
  count.setAttribute('role', 'status');
  tools.append(count, element('span', '', 'Most tabs'), actions);
  const content = element('div', 'domains-content');
  const pinnedHeading = element('h2', '', 'Pinned');
  const otherHeading = element('h2', '', 'Other domains');
  const pinnedList = element('ul');
  pinnedList.setAttribute('aria-label', 'Pinned domains');
  const otherList = element('ul');
  otherList.setAttribute('aria-label', 'Other domains');
  const empty = element('div', 'domains-empty');
  empty.append(
    icon('globe'),
    element('h2', '', 'No domains with multiple tabs'),
    element('p', '', 'Domains appear here when two or more tabs match.'),
  );
  const note = element('p', 'domains-note', 'Pinned domains and domains with 2 or more tabs');
  content.append(pinnedHeading, pinnedList, otherHeading, otherList, empty, note);
  pane.append(heading, tools, content);
  root.prepend(pane);
  const trigger = button('Domains', 'globe');
  trigger.id = 'domains-toggle';
  trigger.disabled = true;
  trigger.setAttribute('aria-controls', pane.id);
  trigger.setAttribute('aria-expanded', 'false');
  root.querySelector('#recently-closed-toggle').before(trigger);
  const fold = root.querySelector('#tree-toggle');
  const rows = new Map();
  let state;
  let savedFocus;
  let foldDisabled;
  let selectedDomain;
  let selectedIndex = 0;
  let savedScroll;

  function close({ restoreFocus = true } = {}) {
    if (pane.hidden) return;
    savedScroll = captureScroll(content, '.domains-row', 'data-domain');
    pane.hidden = true;
    root.classList.remove('domains-open');
    rows.clear();
    pinnedList.replaceChildren();
    otherList.replaceChildren();
    state = null;
    trigger.setAttribute('aria-expanded', 'false');
    fold.disabled = foldDisabled;
    onClose();
    if (restoreFocus) restoreFocusToken(savedFocus, trigger);
    savedFocus = null;
  }

  function makeRow(domain) {
    const row = element('li', 'domains-row');
    row.dataset.domain = domain;
    const open = button(domain, null, 'domains-open-domain');
    open.dataset.rowAction = 'open';
    const favicon = element('span', 'domains-favicon');
    const label = element('span', 'domains-label', domain);
    const total = element('span', 'domains-tab-count');
    open.append(favicon, label, total);
    const pin = button(`Pin ${domain}`, 'pin', 'domains-pin');
    pin.dataset.rowAction = 'pin';
    row.append(open, pin);
    const item = { row, open, favicon, total, pin };
    return item;
  }

  content.addEventListener(
    'click',
    async (event) => {
      const row = event.target.closest('.domains-row');
      const domain = row?.dataset.domain;
      const item = rows.get(domain);
      const control = event.target.closest('button');
      if (pane.hidden || !item || item.row !== row || !content.contains(row) || !control) return;
      if (control.dataset.rowAction === 'open') {
        selectedDomain = domain;
        selectedIndex = [...content.querySelectorAll('.domains-open-domain')].indexOf(item.open);
        const sourceId = item.entry.source.id;
        close({ restoreFocus: false });
        onSelect(domain, sourceId);
      } else if (control.dataset.rowAction === 'pin') {
        if (control.getAttribute('aria-disabled') === 'true') return;
        control.setAttribute('aria-disabled', 'true');
        try {
          await onPin(domain, !item.entry.pinned);
        } finally {
          control.removeAttribute('aria-disabled');
        }
      }
    },
    { signal: events.signal },
  );

  function render() {
    if (pane.hidden || !state) return;
    const entries = listDomains(state.tabs, state.domainPins);
    const focused = document.activeElement;
    const focusedIndex = content.contains(focused)
      ? [...content.querySelectorAll('.domains-open-domain')].findIndex((node) =>
          node.closest('li').contains(focused),
        )
      : -1;
    const alive = new Set();
    for (const entry of entries) {
      alive.add(entry.domain);
      if (!rows.has(entry.domain)) rows.set(entry.domain, makeRow(entry.domain));
      const item = rows.get(entry.domain);
      item.entry = entry;
      if (item.count !== entry.count) {
        item.count = entry.count;
        item.open.setAttribute('aria-label', `${entry.domain}, ${entry.count} tabs`);
        item.total.textContent = entry.count;
      }
      if (item.pinned !== entry.pinned) {
        item.pinned = entry.pinned;
        item.pin.setAttribute('aria-pressed', String(entry.pinned));
        item.pin.title = `${entry.pinned ? 'Unpin' : 'Pin'} ${entry.domain}`;
        item.pin.setAttribute('aria-label', item.pin.title);
      }
      const url = entry.source.favIconUrl;
      if (item.url !== url || !item.favicon.childNodes.length) {
        item.url = url;
        let image = icon('globe');
        if (typeof url === 'string' && /^(https?:|data:image\/|moz-extension:)/i.test(url)) {
          image = element('img');
          image.alt = '';
          image.draggable = false;
          image.referrerPolicy = 'no-referrer';
          image.src = url;
          image.addEventListener('error', () => image.replaceWith(icon('globe')), { once: true });
        }
        item.favicon.replaceChildren(image);
      }
    }
    for (const domain of rows.keys()) if (!alive.has(domain)) rows.delete(domain);
    const pinned = entries.filter((entry) => entry.pinned);
    const others = entries.filter((entry) => !entry.pinned);
    reconcileChildren(
      pinnedList,
      pinned.map((entry) => rows.get(entry.domain).row),
    );
    reconcileChildren(
      otherList,
      others.map((entry) => rows.get(entry.domain).row),
    );
    pinnedHeading.hidden = pinnedList.hidden = !pinned.length;
    otherHeading.hidden = !pinned.length || !others.length;
    otherList.hidden = !others.length;
    empty.hidden = Boolean(entries.length);
    note.hidden = !entries.length;
    count.textContent = `${entries.length} ${entries.length === 1 ? 'domain' : 'domains'}`;
    if (focusedIndex >= 0) {
      const nextButtons = focused.isConnected
        ? []
        : [...content.querySelectorAll('.domains-open-domain')];
      const target = focused.isConnected
        ? focused
        : nextButtons[Math.min(focusedIndex, nextButtons.length - 1)] || dismiss;
      target.focus({ preventScroll: true });
    }
  }

  function open({ restore = false } = {}) {
    if (disposed || !pane.hidden || !getState()) return;
    savedFocus = captureFocus();
    onOpen();
    state = getState();
    foldDisabled = fold.disabled;
    fold.disabled = true;
    pane.hidden = false;
    root.classList.add('domains-open');
    trigger.setAttribute('aria-expanded', 'true');
    render();
    restoreScroll(content, savedScroll);
    const buttons = [...content.querySelectorAll('.domains-open-domain')];
    const previous =
      rows.get(selectedDomain)?.open || buttons[Math.min(selectedIndex, buttons.length - 1)];
    (restore && previous ? previous : dismiss).focus({ preventScroll: true });
  }

  dismiss.addEventListener('click', () => close(), { signal: events.signal });
  trigger.addEventListener('click', () => (pane.hidden ? open() : close()), {
    signal: events.signal,
  });
  pane.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      const buttons = [...content.querySelectorAll('.domains-open-domain')];
      const current = event.target.closest('.domains-row');
      const index = buttons.findIndex((node) => node.closest('li') === current);
      let target;
      if (event.key === 'ArrowDown') target = buttons[Math.min(index + 1, buttons.length - 1)];
      else if (event.key === 'ArrowUp') target = buttons[Math.max(index - 1, 0)];
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
      rows.clear();
      pinnedList.replaceChildren();
      otherList.replaceChildren();
      pane.hidden = true;
      root.classList.remove('domains-open');
      pane.remove();
      trigger.remove();
    },

    detail(active) {
      trigger.setAttribute('aria-expanded', String(active || !pane.hidden));
    },

    update(next) {
      if (disposed) return false;
      state = pane.hidden ? null : next;
      trigger.disabled = false;
      render();
      return !pane.hidden;
    },
  };
}
