import { createRefreshScheduler } from './refresh-scheduler.js';
import { icon } from './icons.js';
import { groupById } from './model.js';
import { folderContainer, folderIcon } from './folder-icons.js';
import { createRowCache, reconcileChildren } from './dom.js';
import { createFolderIndex } from './folder-index.js';
import {
  activityItems,
  activityKinds,
  filterActivity,
  activityDay,
  activityTime,
} from './activity-data.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const demo = !globalThis.browser?.runtime?.id && params.has('demo');
const mockup = demo && params.has('mockup');
const pageUrl = location.href.split(/[?#]/)[0];
const results = $('activity-results');
const search = $('activity-search');
const period = $('activity-period');
const folderEvent = $('folder-event');
let state, request, windowId, busyKey, readFailed;
let disposed = false;
let kind = 'all';
const rows = createRowCache({ retain: 2048 });
const sections = new Map();
const timelineRoot = el('div', 'activity-timeline');

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
  if (document.documentElement.dataset.colorScheme !== state.look.colorScheme)
    document.documentElement.dataset.colorScheme = state.look.colorScheme;
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
  const folders = createFolderIndex(state);
  const days = new Map();
  const labels = new Map();
  const now = Date.now();
  for (const item of items) {
    const date = new Date(item.timestamp).toDateString();
    if (!labels.has(date)) labels.set(date, activityDay(item.timestamp, now));
    const day = labels.get(date);
    if (!days.has(day)) days.set(day, []);
    const group = item.kind === 'folder' && folders.byId.get(item.id);
    const details = group && folders.details.get(item.id);
    days
      .get(day)
      .push(
        rows.get(
          item.key,
          [
            item.title,
            item.detail,
            item.path,
            item.event,
            item.timestamp,
            item.favIconUrl,
            busyKey === item.key,
            activityTime(item.timestamp, now),
            group?.appearance?.icon,
            details?.appearance?.color,
            details?.container?.icon,
            details?.container?.iconUrl,
            group?.defaultCookieStoreId,
          ],
          () => row(item),
        ),
      );
  }
  const nodes = [];
  for (const [day, children] of days) {
    if (!sections.has(day)) {
      const node = el('section', 'day-section');
      const list = el('ul', 'activity-list');
      node.append(el('h3', 'day-heading', day), list);
      sections.set(day, { node, list });
    }
    const section = sections.get(day);
    reconcileChildren(section.list, children);
    nodes.push(section.node);
  }
  reconcileChildren(timelineRoot, nodes);
  for (const day of sections.keys()) if (!days.has(day)) sections.delete(day);
  return timelineRoot;
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
  reconcileChildren(results, [items.length ? timeline(items) : empty()]);
  if (!items.length) {
    timelineRoot.replaceChildren();
    sections.clear();
  }
  const live = new Set(all.map((item) => item.key));
  // A folder-event filter hides otherwise live history; keep those rows just
  // as we keep rows hidden by the text, date and category filters.
  const historyFolders = new Set(
    [...(state.view.recentFolders || []), ...(state.view.recentExpandedFolders || [])].map(
      ({ id }) => id,
    ),
  );
  for (const group of state.groups)
    if (historyFolders.has(group.id)) live.add(`folder:${group.id}`);
  rows.finish((key) => live.has(key));
  results.setAttribute('aria-busy', 'false');
  if (focusedKey) {
    const selector = `[data-key="${CSS.escape(focusedKey)}"]`;
    (results.querySelector(selector) || results.querySelector('.item-button') || search).focus({
      preventScroll: true,
    });
  }
}

const refreshScheduler = createRefreshScheduler({
  delay: 50,
  getState: () => state,
  getWindowId: () => windowId,
  canRefresh: () => Boolean(request) && !document.hidden,

  async refresh() {
    try {
      state = await request('snapshot');
      if (disposed) return;
      if (readFailed) showError('');
      readFailed = false;
      render();
    } catch (error) {
      if (disposed) return;
      readFailed = true;
      if (!state)
        results.replaceChildren(el('p', 'empty-message', 'Recent activity is unavailable.'));
      showError(error.message || 'Could not load recent activity.', true);
    } finally {
      if (!disposed) results.setAttribute('aria-busy', 'false');
    }
  },
});
const scheduleRefresh = refreshScheduler.schedule;
const refresh = refreshScheduler.now;

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
let searchFrame;
search.addEventListener('input', () => {
  if (searchFrame) return;
  searchFrame = requestAnimationFrame(() => {
    searchFrame = null;
    render();
  });
});
period.addEventListener('change', render);
folderEvent.addEventListener('change', render);
window.addEventListener('hashchange', navigate);
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
    windowId = 1;
    request = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
    $('activity-demo').hidden = false;
  } else {
    if (!globalThis.browser?.runtime?.id)
      throw new Error('Open this page from Tabernacle in Firefox.');
    windowId = (await browser.windows.getCurrent()).id;
    request = async (type, args = {}) => {
      windowId = (await browser.windows.getCurrent()).id;
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
      if (message.type === 'tabernacle:changed') scheduleRefresh(message);
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
window.addEventListener('focus', () => scheduleRefresh());
window.addEventListener(
  'pagehide',
  () => {
    disposed = true;
    refreshScheduler.dispose();
    clearInterval(timer);
    cancelAnimationFrame(searchFrame);
  },
  { once: true },
);
start().catch((error) => {
  results.replaceChildren(el('p', 'empty-message', error.message));
  results.setAttribute('aria-busy', 'false');
});
