import { icon } from './icons.js';
import { groupById } from './model.js';
import { folderContainer, folderIcon } from './folder-icons.js';
import {
  activityItems,
  activityKinds,
  filterActivity,
  activityDay,
  activityTime,
} from './activity-data.js';
import { observeTheme } from './theme-observer.js';
import { createPaletteRenderer, resolveTheme } from './theme-palette.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const demo = !globalThis.browser?.runtime?.id && params.has('demo');
const mockup = demo && params.has('mockup');
const pageUrl = location.href.split(/[?#]/)[0];
const results = $('activity-results');
const search = $('activity-search');
const period = $('activity-period');
const folderEvent = $('folder-event');
const paint = createPaletteRenderer(document.documentElement);
const forced = matchMedia('(forced-colors: active)');
let state, request, observer, windowId, busyKey, readFailed;
let refreshing = false,
  refreshAgain = false,
  refreshTimer,
  disposed = false;
let kind = 'all';

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, action) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function appearance() {
  if (!state) return;
  const theme = resolveTheme(state.look, observer?.snapshot || {}, observer?.dark || false);
  paint(forced.matches ? null : theme.palette, state.look?.colorScheme);
}

function setWindow(id) {
  if (id === windowId) return;
  windowId = id;
  observer?.dispose();
  observer = observeTheme({
    api: demo ? null : browser,
    windowId,
    media: matchMedia('(prefers-color-scheme: dark)'),
    onChange: appearance,
  });
}

function itemIcon(item) {
  const node = el('span', 'item-icon');
  node.setAttribute('aria-hidden', 'true');

  const fallback = () => {
    const group = item.kind === 'folder' && groupById(state, item.id);
    node.replaceChildren(
      group ? folderIcon(group, folderContainer(state, group), { state }) : icon('globe'),
    );
  };

  // Only use the favicon supplied by Firefox. Never fetch a history URL to get one.
  if (item.favIconUrl && /^(https?:|data:image\/|moz-extension:)/i.test(item.favIconUrl)) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', fallback, { once: true });
    img.src = item.favIconUrl;
    node.append(img);
  } else fallback();
  return node;
}

function eventLabel(item) {
  return item.event || activityKinds[item.kind].event;
}

function showError(message, retry = false) {
  const node = $('activity-error');
  node.replaceChildren(document.createTextNode(message || ''));
  node.hidden = !message;
  if (retry) node.append(button('retry', 'Try again', refresh));
}

async function act(item) {
  if (busyKey) return;
  busyKey = item.key;
  showError('');
  render();
  try {
    if (item.kind === 'closed') await request('restoreClosedTab', { sessionId: item.sessionId });
    else if (item.kind === 'folder') {
      // Firefox requires a user gesture to show the sidebar. Start this before
      // awaiting the controller, including when the folder contains no tabs.
      const opening = demo ? Promise.resolve() : browser.sidebarAction.open().catch(() => {});
      await request('enterGroup', { id: item.id });
      await opening;
    } else await request('activateTab', { id: item.id, reveal: true });
    $('activity-status').textContent =
      `${item.kind === 'closed' ? 'Reopened' : item.kind === 'folder' ? 'Opened' : 'Switched to'} ${item.title}.`;
    await refresh();
  } catch (error) {
    showError(error.message || 'Could not open this item. Try again.');
  } finally {
    busyKey = null;
    render();
  }
}

function row(item) {
  const li = el('li', 'activity-row');
  li.dataset.kind = item.kind;
  const action = activityKinds[item.kind];
  const node = button('item-button', undefined, () => act(item));
  node.dataset.key = item.key;
  node.disabled = busyKey === item.key;
  node.setAttribute('aria-label', `${action.action}: ${item.title}`);
  const text = el('span', 'item-text');
  const title = el('span', 'item-title', item.title);
  title.title = item.title;
  const meta = el('span', 'item-detail');
  const event = el('span', 'item-kind');
  event.append(
    icon(item.kind === 'folder' && item.event === 'Expanded' ? 'expand' : action.icon),
    el('span', '', eventLabel(item)),
  );
  const context = el('span', 'item-context', item.detail || item.path || 'Tab');
  context.title = context.textContent;
  meta.append(event, context);
  text.append(title, meta);
  const time = el('time', 'item-time', activityTime(item.timestamp));
  if (item.timestamp) {
    time.dateTime = new Date(item.timestamp).toISOString();
    time.title = new Date(item.timestamp).toLocaleString();
  }
  const affordance = el('span', 'item-action');
  affordance.setAttribute('aria-hidden', 'true');
  affordance.append(
    el('span', '', item.kind === 'closed' ? 'Reopen' : item.kind === 'folder' ? 'Open' : 'Switch'),
    icon(item.kind === 'closed' ? 'undo' : 'enter'),
  );
  node.append(itemIcon(item), text, time, affordance);
  li.append(node);
  return li;
}

function timeline(items) {
  const container = el('div', 'activity-timeline');
  let currentDay, list;
  for (const item of items) {
    const day = activityDay(item.timestamp);
    if (day !== currentDay) {
      currentDay = day;
      const section = el('section', 'day-section');
      section.append(el('h3', 'day-heading', day));
      list = el('ul', 'activity-list');
      section.append(list);
      container.append(section);
    }
    list.append(row(item));
  }
  return container;
}

function empty() {
  const node = el('div', 'empty-message');
  const filtered =
    Boolean(search.value.trim()) ||
    period.value !== 'all' ||
    (kind === 'folder' && folderEvent.value !== 'all');
  node.append(el('strong', '', filtered ? 'No matching activity' : 'Nothing here yet'));
  const copy =
    kind === 'folder'
      ? 'Folders you open or expand will appear here.'
      : kind === 'closed'
        ? 'Tabs you close in this window will appear here.'
        : 'Tabs you view and folders you use will appear here.';
  node.append(el('p', '', filtered ? 'Try another search or a different time period.' : copy));
  if (filtered)
    node.append(
      button('reset-filters', 'Clear filters', () => {
        search.value = '';
        period.value = folderEvent.value = 'all';
        render();
        search.focus();
      }),
    );
  return node;
}

function render() {
  if (!state || disposed) return;
  appearance();
  const focusedKey = document.activeElement?.dataset.key;
  const options = { query: search.value, period: period.value };
  const all = activityItems(state, {
    pageUrl,
    folderEvent: kind === 'folder' ? folderEvent.value : 'all',
  });
  const matching = filterActivity(all, options);
  const items = filterActivity(matching, { kind });
  for (const link of $('activity-filters').children) {
    const value = link.dataset.kind;
    if (value === kind) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
    link.querySelector('.filter-count').textContent =
      value === 'all' ? matching.length : matching.filter((item) => item.kind === value).length;
  }
  $('activity-heading').textContent = kind === 'all' ? 'All activity' : activityKinds[kind].label;
  $('activity-count').textContent = items.length;
  $('activity-count').setAttribute(
    'aria-label',
    `${items.length} ${items.length === 1 ? 'item' : 'items'}`,
  );
  $('folder-filter-label').hidden = kind !== 'folder';
  const historyError = (kind === 'all' || kind === 'closed') && state.recentlyClosedError;
  $('activity-history-error').hidden = !historyError;
  $('activity-history-error').textContent = historyError
    ? `Could not load closed tabs. ${historyError}`
    : '';
  results.replaceChildren();
  if (!items.length) results.append(empty());
  else results.append(timeline(items));
  results.setAttribute('aria-busy', 'false');
  if (focusedKey) {
    const selector = `[data-key="${CSS.escape(focusedKey)}"]`;
    (results.querySelector(selector) || results.querySelector('.item-button') || search).focus({
      preventScroll: true,
    });
  }
}

async function refresh() {
  if (disposed || !request) return;
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      state = await request('snapshot');
    } while (refreshAgain && !disposed);
    if (readFailed) showError('');
    readFailed = false;
    render();
  } catch (error) {
    readFailed = true;
    if (!state)
      results.replaceChildren(el('p', 'empty-message', 'Recent activity is unavailable.'));
    showError(error.message || 'Could not load recent activity.', true);
  } finally {
    refreshing = false;
    results.setAttribute('aria-busy', 'false');
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 50);
}

function navigate() {
  const value = location.hash.slice(1);
  kind = Object.hasOwn(activityKinds, value) ? value : 'all';
  render();
}

for (const [value, label, symbol] of [
  ['all', 'All activity', 'history'],
  ['viewed', 'Viewed tabs', 'globe'],
  ['closed', 'Closed tabs', 'undo'],
  ['folder', 'Folders', 'group'],
]) {
  const link = el('a', 'filter-link');
  link.href = `#${value}`;
  link.dataset.kind = value;
  link.append(icon(symbol), el('span', '', label), el('span', 'filter-count'));
  $('activity-filters').append(link);
}
for (const node of document.querySelectorAll('span[data-icon]'))
  node.append(icon(node.dataset.icon));
search.addEventListener('input', render);
period.addEventListener('change', render);
folderEvent.addEventListener('change', render);
window.addEventListener('hashchange', navigate);
forced.addEventListener('change', appearance);
document.addEventListener('keydown', (event) => {
  const typing = event.target.closest('input, textarea, select, [contenteditable="true"]');
  if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    search.focus();
  }
  if (event.key === 'Escape' && document.activeElement === search) {
    search.value = '';
    render();
  }
  const rows = [...results.querySelectorAll('.item-button')];
  const index = rows.indexOf(document.activeElement);
  if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  rows[next]?.focus();
});

async function start() {
  if (demo) {
    const controller = mockup
      ? await (await import('../../preview/activity-demo.js')).createActivityDemo(scheduleRefresh)
      : await (await import('../../preview/session.js')).connectDemo(scheduleRefresh);
    setWindow(1);
    request = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
    $('activity-demo').hidden = false;
  } else {
    if (!globalThis.browser?.runtime?.id)
      throw new Error('Open this page from Tabernacle in Firefox.');
    request = async (type, args = {}) => {
      setWindow((await browser.windows.getCurrent()).id);
      const result = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!result?.ok)
        throw new Error(result?.error || 'Could not connect to Tabernacle. Try again.');
      return result.data;
    };

    const changed = (message) => {
      if (message.type === 'tabernacle:changed') scheduleRefresh();
    };

    browser.runtime.onMessage.addListener(changed);
    window.addEventListener('pagehide', () => browser.runtime.onMessage.removeListener(changed), {
      once: true,
    });
  }
  navigate();
  await refresh();
}

const timer = setInterval(() => {
  if (!document.hidden) render();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
window.addEventListener('focus', scheduleRefresh);
window.addEventListener(
  'pagehide',
  () => {
    disposed = true;
    clearTimeout(refreshTimer);
    clearInterval(timer);
    observer?.dispose();
  },
  { once: true },
);
start().catch((error) => {
  results.replaceChildren(el('p', 'empty-message', error.message));
  results.setAttribute('aria-busy', 'false');
});
