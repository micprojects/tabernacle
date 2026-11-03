import { icon } from './icons.js';
import { groupById } from './model.js';
import { folderContainer, folderIcon } from './folder-icons.js';
import { recentPreviewItems, recentActivityDays } from './recent-history.js';
import { activityDay } from './activity-data.js';
import { captureScroll, restoreScroll } from './view-state.js';

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
  root,
  trigger,
  getState,
  beforeOpen,
  afterClose,
  restore,
  activate,
  enter,
  favicon,
  openMore,
}) {
  const events = new AbortController();
  const pane = el('section', 'recently-closed');
  pane.id = 'recently-closed';
  pane.hidden = true;
  pane.setAttribute('aria-labelledby', 'recently-closed-title');
  const fold = root.querySelector('#tree-toggle');
  const heading = el('div', 'recently-closed-heading pane-heading');
  const title = el('h1', '', 'Recent activity');
  title.id = 'recently-closed-title';
  const dismiss = el('button', 'recent-close pane-back');
  dismiss.type = 'button';
  dismiss.title = 'Back to tabs (Esc)';
  dismiss.setAttribute('aria-label', 'Back to tabs');
  dismiss.append(icon('back'), el('span', '', 'Tabs'));
  heading.append(dismiss, title);
  const filters = el('div', 'recent-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter recent activity');
  let filter = 'all';
  let renderKey, timer, foldDisabled;
  let disposed = false;

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
      render();
      list.scrollTop = 0;
    });
    filters.append(button);
  }
  const searchField = el('label', 'recent-search');
  const search = el('input');
  search.type = 'search';
  search.id = 'recent-search';
  search.placeholder = 'Search activity';
  search.setAttribute('aria-label', 'Search recent activity');
  search.setAttribute('aria-controls', 'recent-activity-list');
  search.autocomplete = 'off';
  searchField.append(icon('search'), search);
  search.addEventListener('input', () => {
    render();
    list.scrollTop = 0;
  });
  const list = el('div', 'recently-closed-list');
  list.id = 'recent-activity-list';
  const empty = el('p', 'recently-closed-empty');
  empty.setAttribute('role', 'status');
  const more = el('button', 'recent-more', 'Open full activity page');
  more.type = 'button';
  more.append(icon('enter'));
  more.addEventListener('click', () => {
    close(true);
    openMore();
  });
  pane.append(heading, filters, searchField, list, more);
  root.prepend(pane);

  function close(restoreFocus = false) {
    if (pane.hidden) return;
    pane.hidden = true;
    root.classList.remove('recent-open');
    clearInterval(timer);
    renderKey = null;
    list.replaceChildren();
    trigger.setAttribute('aria-expanded', 'false');
    fold.disabled = foldDisabled;
    afterClose();
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function row(item, state, formatTime) {
    const kind = kinds[item.kind];
    const node = el('button', 'recently-closed-row');
    node.type = 'button';
    node.dataset.recentKey = item.key;
    node.dataset.kind = item.kind;
    if (item.sessionId) node.dataset.sessionId = item.sessionId;
    node.title = [
      item.title,
      item.event ? `${item.event} folder` : kind.event,
      item.url || item.detail,
      `${kind.action} ${item.kind === 'folder' ? 'folder' : 'tab'}`,
    ]
      .filter(Boolean)
      .join('\n');
    node.setAttribute('aria-label', `${kind.action} ${item.title}`);
    const text = el('span', 'recently-closed-label', item.title);
    const time = el(
      'time',
      'recently-closed-time',
      item.timestamp ? formatTime(item.timestamp) : '',
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
    node.append(
      group ? folderIcon(group, folderContainer(state, group), { state }) : favicon(item),
      text,
      action,
      time,
    );
    node.addEventListener('click', () => {
      close(true);
      if (item.kind === 'closed') restore(item.sessionId);
      else if (item.kind === 'folder') enter(item.id);
      else activate(item.id);
    });
    return node;
  }

  function render() {
    if (disposed || pane.hidden) return false;
    const state = getState();
    const items = recentPreviewItems(state, filter, itemLimit, search.value);
    const error = (filter === 'all' || filter === 'closed') && state.recentlyClosedError;
    const now = Date.now();
    const key = JSON.stringify([
      items,
      state.groups,
      state.containers,
      state.look.tintFavicons,
      error,
      filter,
      search.value,
      Math.floor(now / 60_000),
    ]);
    if (key !== renderKey) {
      renderKey = key;
      const focused = document.activeElement;
      const focusedKey = focused?.dataset.recentKey;
      const oldIndex = [...list.querySelectorAll('button')].indexOf(focused);
      const scroll = captureScroll(list, '.recently-closed-row', 'data-recent-key');
      const formatter = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      const formatTime = (time) => formatter.format(time);
      const content = document.createDocumentFragment();
      for (const day of recentActivityDays(items)) {
        const section = el('section', 'recent-day');
        section.append(el('h2', 'recent-day-heading', activityDay(day.timestamp, now)));
        for (const session of day.sessions) {
          const group = el('div', 'recent-session');
          if (session.start) {
            const start = formatTime(session.start);
            const end = formatTime(session.end);
            group.append(
              el('h3', 'recent-session-heading', start === end ? start : `${start}–${end}`),
            );
          }
          for (const item of session.items) group.append(row(item, state, formatTime));
          section.append(group);
        }
        content.append(section);
      }
      empty.hidden = items.length > 0 && !error;
      empty.textContent = [
        !items.length && !error
          ? search.value.trim()
            ? 'No matching activity.'
            : emptyMessages[filter]
          : '',
        error ? `Could not load closed tabs. ${error}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      content.append(empty);
      list.replaceChildren(content);
      restoreScroll(list, scroll);
      if (focusedKey) {
        const rows = [...list.querySelectorAll('button')];
        const matching = rows.find((node) => node.dataset.recentKey === focusedKey);
        (matching || rows[Math.min(oldIndex, rows.length - 1)] || filters.firstElementChild).focus({
          preventScroll: true,
        });
      }
    }
    return true;
  }

  function open() {
    if (disposed || !pane.hidden || !getState()) return;
    beforeOpen();
    selectFilter('all');
    search.value = '';
    foldDisabled = fold.disabled;
    fold.disabled = true;
    pane.hidden = false;
    root.classList.add('recent-open');
    trigger.setAttribute('aria-expanded', 'true');
    render();
    list.scrollTop = 0;
    (list.querySelector('button') || filters.firstElementChild).focus({ preventScroll: true });
    clearInterval(timer);
    timer = setInterval(render, 60_000);
  }

  trigger.append(icon('history'));
  trigger.addEventListener('click', () => (pane.hidden ? open() : close(true)), {
    signal: events.signal,
  });
  trigger.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (pane.hidden) open();
        else (list.querySelector('button') || filters.firstElementChild).focus();
      }
    },
    { signal: events.signal },
  );
  dismiss.addEventListener('click', () => close(true));
  pane.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target === search && event.key !== 'ArrowDown') return;
    const rows = [...list.querySelectorAll('button')];
    const index = rows.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = rows[(index + 1) % rows.length];
    else if (event.key === 'ArrowUp') next = index <= 0 ? rows.at(-1) : rows[index - 1];
    else if (event.key === 'Home' && index >= 0) next = rows[0];
    else if (event.key === 'End' && index >= 0) next = rows.at(-1);
    else return;
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  });
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
      if (event.target === search && search.value) {
        search.value = '';
        render();
        list.scrollTop = 0;
      } else close(true);
    },
    { signal: events.signal },
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!trigger.contains(event.target) && event.target.closest('footer')) close();
    },
    { capture: true, signal: events.signal },
  );
  return {
    open,
    close,
    render,

    focusSearch() {
      if (pane.hidden) return false;
      search.focus();
      search.select();
      return true;
    },

    dispose() {
      disposed = true;
      events.abort();
      clearInterval(timer);
      list.replaceChildren();
      renderKey = null;
      pane.remove();
      root.classList.remove('recent-open');
    },
  };
}
