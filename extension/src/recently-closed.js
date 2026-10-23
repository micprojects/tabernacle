import { icon } from './icons.js';
import { groupById } from './model.js';
import { folderContainer, folderIcon } from './folder-icons.js';
import { recentPreviewItems, recentTime } from './recent-history.js';

const itemLimit = 50;
const kinds = {
  viewed: { event: 'Viewed tab', action: 'Switch to', icon: 'eye' },
  folder: { event: 'Opened folder', action: 'Open', icon: 'group' },
  closed: { event: 'Closed tab', action: 'Reopen', icon: 'undo' },
};
const emptyMessages = {
  all: 'No recent activity yet.',
  viewed: 'No recently viewed tabs.',
  folder: 'No recently opened or expanded folders.',
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
  openMore,
}) {
  const popup = el('section', 'recently-closed');
  popup.id = 'recently-closed';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-labelledby', 'recently-closed-title');
  const backdrop = el('div', 'recent-backdrop');
  backdrop.setAttribute('aria-hidden', 'true');
  const dock = trigger.closest('footer') || trigger;
  const heading = el('div', 'recently-closed-heading');
  const title = el('h2', '', 'Recent activity');
  title.id = 'recently-closed-title';
  const dismiss = el('button', 'icon-button');
  dismiss.type = 'button';
  dismiss.title = 'Close recent activity';
  dismiss.setAttribute('aria-label', dismiss.title);
  dismiss.append(icon('close'));
  heading.append(title, dismiss);
  const filters = el('div', 'recent-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter recent activity');
  let filter = 'all';

  function selectFilter(value) {
    filter = value;
    for (const item of filters.children)
      item.setAttribute('aria-pressed', String(item.dataset.filter === value));
  }

  for (const [value, label, glyph] of [
    ['all', 'All', 'list'],
    ['viewed', 'Viewed', 'eye'],
    ['closed', 'Closed', 'undo'],
    ['folder', 'Folders', 'group'],
  ]) {
    const button = el('button', 'recent-filter', label);
    button.prepend(icon(glyph));
    button.type = 'button';
    button.dataset.filter = value;
    button.setAttribute('aria-pressed', String(value === filter));
    button.addEventListener('click', () => {
      selectFilter(value);
      list.scrollTop = 0;
      render();
    });
    filters.append(button);
  }
  const list = el('div', 'recently-closed-list');
  const empty = el('p', 'recently-closed-empty');
  empty.setAttribute('role', 'status');
  const more = el('button', 'recent-more');
  more.type = 'button';
  more.setAttribute('aria-label', 'More');
  const moreText = el('span');
  const moreHelp = el('span', 'recent-more-help', 'Open the full activity page');
  moreHelp.id = 'recent-more-help';
  more.setAttribute('aria-describedby', moreHelp.id);
  moreText.append(el('span', '', 'More'), moreHelp);
  more.append(moreText, icon('enter'));
  more.addEventListener('click', () => {
    close(true);
    openMore();
  });
  popup.append(heading, filters, list, more);
  document.body.append(popup, backdrop);
  let renderKey, timer;

  function position() {
    if (popup.hidden) return;
    const rect = trigger.getBoundingClientRect();
    backdrop.style.bottom = `${Math.max(0, innerHeight - dock.getBoundingClientRect().top)}px`;
    popup.style.maxHeight = `${Math.max(0, Math.min(640, rect.top - 16))}px`;
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
    const items = recentPreviewItems(state, filter, itemLimit);
    const error = (filter === 'all' || filter === 'closed') && state.recentlyClosedError;
    const now = Date.now();
    const key = JSON.stringify([
      items,
      state.groups,
      state.containers,
      state.look.tintFavicons,
      error,
      filter,
      Math.floor(now / 60_000),
    ]);
    if (key !== renderKey) {
      renderKey = key;
      const focused = document.activeElement;
      const focusedKey = focused?.dataset.recentKey;
      const oldIndex = [...list.querySelectorAll('button')].indexOf(focused);
      const scroll = list.scrollTop;
      list.replaceChildren();
      for (const item of items) {
        const kind = kinds[item.kind];
        const row = el('button', 'recently-closed-row');
        row.type = 'button';
        row.dataset.recentKey = item.key;
        row.dataset.kind = item.kind;
        if (item.sessionId) row.dataset.sessionId = item.sessionId;
        row.title = [
          item.title,
          item.event ? `${item.event} folder` : kind.event,
          item.url || item.detail,
          `${kind.action} ${item.kind === 'folder' ? 'folder' : 'tab'}`,
        ]
          .filter(Boolean)
          .join('\n');
        row.setAttribute('aria-label', `${kind.action} ${item.title}`);
        const text = el('span', 'recently-closed-label', item.title);
        const timeLabel = recentTime(item.timestamp, now);
        const time = el(
          'time',
          'recently-closed-time',
          timeLabel === 'Just now' ? 'Now' : timeLabel,
        );
        if (item.timestamp) {
          const date = new Date(item.timestamp);
          time.dateTime = date.toISOString();
          time.title = date.toLocaleString();
        }
        const action = el('span', 'recent-item-action');
        action.setAttribute('aria-hidden', 'true');
        action.append(icon(kind.icon));
        const group = item.kind === 'folder' && groupById(state, item.id);
        row.append(
          group ? folderIcon(group, folderContainer(state, group), { state }) : favicon(item),
          text,
          action,
          time,
        );
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
        !items.length && !error ? emptyMessages[filter] : '',
        error ? `Could not load closed tabs. ${error}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      list.append(empty);
      list.scrollTop = scroll;
      if (focusedKey) {
        const rows = [...list.querySelectorAll('button')];
        const matching = rows.find((row) => row.dataset.recentKey === focusedKey);
        (matching || rows[Math.min(oldIndex, rows.length - 1)] || filters.firstElementChild).focus({
          preventScroll: true,
        });
      }
    }
    position();
  }

  function open() {
    if (!getState()) return;
    beforeOpen();
    selectFilter('all');
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    render();
    list.scrollTop = 0;
    (list.querySelector('button') || filters.firstElementChild).focus({ preventScroll: true });
    clearInterval(timer);
    timer = setInterval(render, 60_000);
  }

  trigger.append(icon('history'));
  trigger.addEventListener('click', () => (popup.hidden ? open() : close(true)));
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
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
  window.addEventListener('resize', () => {
    position();
    if (!popup.hidden && list.contains(document.activeElement))
      document.activeElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  window.addEventListener('blur', () => close());
  window.addEventListener('pagehide', () => close(), { once: true });
  return { open, close, render };
}
