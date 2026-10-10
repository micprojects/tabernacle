import { icon } from './icons.js';
import { recentItems, recentDay, recentTime } from './recent-history.js';

const kinds = {
  viewed: { event: 'Viewed tab', action: 'Switch to', icon: 'enter' },
  folder: { event: 'Entered folder', action: 'Enter', icon: 'chevron' },
  closed: { event: 'Closed tab', action: 'Reopen', icon: 'undo' },
};
const emptyMessages = {
  all: 'No recent activity yet.',
  viewed: 'No recently viewed tabs.',
  folder: 'No recently entered folders.',
  closed: 'No recently closed tabs.',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createRecentActivity({
  trigger,
  getState,
  beforeOpen,
  restore,
  activate,
  enter,
  favicon,
}) {
  const popup = el('section', 'recently-closed');
  popup.id = 'recently-closed';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-labelledby', 'recently-closed-title');
  const heading = el('div', 'recently-closed-heading');
  const title = el('h2', '', 'Recent');
  title.id = 'recently-closed-title';
  const dismiss = el('button', 'icon-button');
  dismiss.type = 'button';
  dismiss.title = 'Close recent activity';
  dismiss.setAttribute('aria-label', dismiss.title);
  dismiss.append(icon('close'));
  heading.append(icon('history'), title, dismiss);
  const filters = el('div', 'recent-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter recent activity');
  let filter = 'all';
  for (const [value, label] of [
    ['all', 'All'],
    ['viewed', 'Viewed tabs'],
    ['folder', 'Folders'],
    ['closed', 'Closed tabs'],
  ]) {
    const button = el('button', 'recent-filter', label);
    button.type = 'button';
    button.dataset.filter = value;
    button.setAttribute('aria-pressed', String(value === filter));
    button.addEventListener('click', () => {
      filter = value;
      for (const item of filters.children)
        item.setAttribute('aria-pressed', String(item.dataset.filter === value));
      list.scrollTop = 0;
      render();
    });
    filters.append(button);
  }
  const searchBox = el('div', 'recent-search');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search recent';
  search.setAttribute('aria-label', 'Search recent activity');
  search.addEventListener('input', () => {
    list.scrollTop = 0;
    render();
  });
  searchBox.append(icon('search'), search);
  const list = el('div', 'recently-closed-list');
  const empty = el('p', 'recently-closed-empty');
  empty.setAttribute('role', 'status');
  popup.append(heading, filters, searchBox, list);
  document.body.append(popup);
  let renderKey, timer;

  function position() {
    if (popup.hidden) return;
    const rect = trigger.getBoundingClientRect();
    popup.style.maxHeight = `${Math.max(0, Math.min(640, rect.top - 16))}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.max(8, rect.top - popup.offsetHeight - 8)}px`;
  }

  function close(restoreFocus = false) {
    if (popup.hidden) return;
    popup.hidden = true;
    clearInterval(timer);
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function render() {
    if (popup.hidden) return;
    const state = getState();
    const items = recentItems(state, filter, search.value);
    const error = (filter === 'all' || filter === 'closed') && state.recentlyClosedError;
    const now = Date.now();
    const key = JSON.stringify([items, error, filter, search.value, Math.floor(now / 60_000)]);
    if (key !== renderKey) {
      renderKey = key;
      const focused = document.activeElement;
      const focusedKey = focused?.dataset.recentKey;
      const oldIndex = [...list.querySelectorAll('button')].indexOf(focused);
      const scroll = list.scrollTop;
      list.replaceChildren();
      let day;
      for (const item of items) {
        const itemDay = recentDay(item.timestamp, now);
        if (itemDay !== day) {
          list.append(el('h3', 'recent-day', itemDay));
          day = itemDay;
        }
        const kind = kinds[item.kind];
        const row = el('button', 'recently-closed-row');
        row.type = 'button';
        row.dataset.recentKey = item.key;
        row.dataset.kind = item.kind;
        if (item.sessionId) row.dataset.sessionId = item.sessionId;
        row.title = [
          item.title,
          item.url || item.detail,
          `${kind.action} ${item.kind === 'folder' ? 'folder' : 'tab'}`,
        ]
          .filter(Boolean)
          .join('\n');
        row.setAttribute('aria-label', `${kind.action} ${item.title}`);
        const text = el('span', 'recent-item-text');
        text.append(
          el('span', 'recently-closed-label', item.title),
          el('span', 'recent-item-detail', [kind.event, item.detail].filter(Boolean).join(' · ')),
        );
        const time = el('time', 'recently-closed-time', recentTime(item.timestamp, now));
        if (item.timestamp) {
          const date = new Date(item.timestamp);
          time.dateTime = date.toISOString();
          time.title = date.toLocaleString();
        }
        const action = el('span', 'recent-item-action');
        action.setAttribute('aria-hidden', 'true');
        action.append(icon(kind.icon));
        if (item.kind === 'viewed') action.append(el('span', 'recent-switch-label', 'Switch'));
        row.append(item.kind === 'folder' ? icon('group') : favicon(item), text, time, action);
        row.addEventListener('click', () => {
          close(true);
          if (item.kind === 'closed') restore(item.sessionId);
          else if (item.kind === 'folder') enter(item.id);
          else activate(item.id);
        });
        list.append(row);
      }
      empty.hidden = items.length > 0 && !error;
      empty.textContent = [
        !items.length && !error
          ? search.value.trim()
            ? 'No matching recent activity.'
            : emptyMessages[filter]
          : '',
        error ? `Could not load closed tabs. ${error}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      list.append(empty);
      list.scrollTop = scroll;
      if (focusedKey) {
        const rows = [...list.querySelectorAll('button')];
        const matching = rows.find((row) => row.dataset.recentKey === focusedKey);
        (matching || rows[Math.min(oldIndex, rows.length - 1)] || search).focus({
          preventScroll: true,
        });
      }
    }
    position();
  }

  function open() {
    if (!getState()) return;
    beforeOpen();
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    render();
    list.scrollTop = 0;
    (list.querySelector('button') || search).focus({ preventScroll: true });
    clearInterval(timer);
    timer = setInterval(render, 60_000);
  }

  trigger.append(icon('history'));
  trigger.addEventListener('click', () => (popup.hidden ? open() : close(true)));
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
      if (event.key === 'ArrowUp') ([...list.querySelectorAll('button')].at(-1) || search).focus();
    }
  });
  dismiss.addEventListener('click', () => close(true));
  popup.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    const rows = [...list.querySelectorAll('button')];
    const index = rows.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = rows[(index + 1) % rows.length];
    else if (event.key === 'ArrowUp') next = index <= 0 ? rows.at(-1) : rows[index - 1];
    else if (event.key === 'Home' && index >= 0) next = rows[0];
    else if (event.key === 'End' && index >= 0) next = rows.at(-1);
    else return;
    event.preventDefault();
    next?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!popup.contains(event.target) && !trigger.contains(event.target)) close();
  });
  document.addEventListener('focusin', (event) => {
    if (!popup.contains(event.target) && !trigger.contains(event.target)) close();
  });
  window.addEventListener('resize', position);
  window.addEventListener('blur', () => close());
  window.addEventListener('pagehide', () => close(), { once: true });
  return { open, close, render, isOpen: () => !popup.hidden };
}
