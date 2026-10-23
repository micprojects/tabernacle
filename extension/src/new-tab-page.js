import { createSnapshotReader } from './snapshot-transfer.js';
import { icon } from './icons.js';
import { folderIcon } from './folder-icons.js';
import { isSavedForLater, groupPath } from './model.js';
import { createFolderIndex } from './folder-index.js';
import { normalizeNewTab, isNewTabPage, searchAddress } from './new-tab-preferences.js';
import { createRefreshScheduler } from './refresh-scheduler.js';
import { weatherLabel } from './new-tab-weather.js';
import { captureFocus, restoreFocusToken, captureScroll, restoreScroll } from './view-state.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const demo = !globalThis.browser?.runtime?.id && params.has('demo');
let state, request, windowId, ownTabId, draft, weatherData, weatherKey;
let disposed = false;
let readSnapshot;
let suspendedView;
let viewGeneration = 0;
let weatherGeneration = 0;
const expanded = new Set();

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function error(error) {
  $('page-error').textContent = error?.message || '';
  $('page-error').hidden = !error;
}

function button(label, className, action, key) {
  const node = el('button', className);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  if (key) node.dataset.key = key;
  node.addEventListener('click', () => {
    error();
    try {
      Promise.resolve(action()).catch(error);
    } catch (err) {
      error(err);
    }
  });
  return node;
}

function favicon(item, className) {
  const holder = el('span', className);
  holder.setAttribute('aria-hidden', 'true');
  const fallback = () => holder.replaceChildren(icon('globe'));
  fallback();
  if (item?.favIconUrl && /^(https?:|data:image\/|moz-extension:)/i.test(item.favIconUrl)) {
    const image = el('img');
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', fallback, { once: true });
    image.src = item.favIconUrl;
    holder.replaceChildren(image);
  }
  return holder;
}

function domain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

function settings() {
  if (demo) {
    window.open(new URL('../settings.html?demo#new-tab', import.meta.url), 'tabernacle-settings');
    return;
  }
  return request('openPage', { page: 'settings', section: 'new-tab' });
}

async function openFolder(group) {
  // Call before awaiting anything so Firefox receives the click's user activation.
  const opening = demo ? Promise.resolve() : browser.sidebarAction.open().catch(() => {});
  await request('enterGroup', { id: group.id });
  await opening;
  $('page-status').textContent = `Opened ${group.name} in the sidebar.`;
}

function entry(item, subtitle, action, key) {
  const row = button(item.title || item.name || item.url, 'entry', action, key);
  const copy = el('span', 'item-copy');
  copy.append(el('strong', '', item.title || item.name || item.url), el('small', '', subtitle));
  row.append(favicon(item, 'entry-icon'), copy, icon('chevron'));
  return row;
}

function prefs() {
  return draft || state?.newTab || normalizeNewTab();
}

function tabs() {
  return (state?.tabs || []).filter(
    (tab) => tab.id !== ownTabId && !isNewTabPage(globalThis.browser || {}, tab.url),
  );
}

function renderSearch() {
  const query = $('search').value.trim().toLocaleLowerCase();
  $('search-results').hidden = !query;
  const matches = $('search-matches');
  matches.replaceChildren();
  if (!query || !state) return;
  const foundTabs = tabs().filter((tab) =>
    `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(query),
  );
  const groups = state.groups.filter((group) => group.name.toLocaleLowerCase().includes(query));
  const count = foundTabs.length + groups.length;
  for (const tab of foundTabs.slice(0, 12))
    matches.append(
      entry(
        tab,
        `Open tab · ${domain(tab.url)}`,
        () => request('activateTab', { id: tab.id }),
        `search-tab-${tab.id}`,
      ),
    );
  for (const group of groups.slice(0, 6))
    matches.append(
      entry(
        group,
        `Folder · ${groupPath(state, group.id)
          .map((item) => item.name)
          .join(' / ')}`,
        () => openFolder(group),
        `search-group-${group.id}`,
      ),
    );
  if (!count)
    matches.append(el('p', 'empty', 'No matching tabs or folders. Press Enter to search the web.'));
  $('search-status').textContent =
    `${count} matching tabs and folders${count > 18 ? '; showing the first matches' : ''}.`;
}

function showRows(id, items, limit, render, empty) {
  const container = $(id);
  container.replaceChildren(...(expanded.has(id) ? items : items.slice(0, limit)).map(render));
  if (!items.length) container.append(el('p', 'empty', empty));
  const toggle = $(`all-${id}`);
  toggle.hidden = items.length <= limit;
  toggle.textContent = expanded.has(id) ? 'Show fewer' : 'View all';
  toggle.setAttribute('aria-expanded', String(expanded.has(id)));
}

function render() {
  if (!state || disposed || document.hidden) return;
  const focused = document.activeElement?.dataset.key;
  const value = prefs();
  document.documentElement.dataset.colorScheme =
    value.colorScheme === 'inherit' ? state.look.colorScheme : value.colorScheme;
  $('loading').hidden = true;
  $('links-section').hidden = false;
  $('search-section').hidden = !value.showSearch;
  $('folders-section').hidden = !value.showFolders;
  $('later-section').hidden = !value.showLater;
  $('recent-section').hidden = !value.showRecent;
  $('preview-notice').hidden = !params.has('preview') && !demo;
  if (demo)
    $('preview-notice').textContent =
      'Preview with example tabs. Changes here do not affect Firefox.';
  const available = tabs();
  const folderIndex = createFolderIndex(state);
  const counts = new Map();
  for (const tab of available)
    if (!isSavedForLater(tab)) counts.set(tab.groupId, (counts.get(tab.groupId) || 0) + 1);
  for (const group of [...folderIndex.order].reverse()) {
    const parent = folderIndex.parents.get(group.id);
    counts.set(parent, (counts.get(parent) || 0) + (counts.get(group.id) || 0));
  }
  $('links').classList.toggle('list-style', value.linkStyle === 'list');
  $('links').replaceChildren(
    ...value.links.map((link) => {
      const node = el('a', 'site');
      node.href = link.url;
      node.dataset.key = `link-${link.id}`;
      const known = available.find((tab) => domain(tab.url) === domain(link.url));
      node.append(favicon(known, 'site-icon'), el('span', 'site-label', link.name));
      return node;
    }),
  );
  const add = button('Add link', 'site add', settings, 'add-link');
  const plus = el('span', 'site-icon');
  plus.append(icon('plus'));
  add.append(plus, el('span', 'site-label', 'Add link'));
  $('links').append(add);
  const pinned = new Set(state.folderPins.map((item) => item.id));
  const groups = [...state.groups].sort(
    (a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)),
  );
  showRows(
    'folders',
    groups,
    3,
    (group) => {
      const node = button(
        `Open ${group.name} in the sidebar`,
        'folder',
        () => openFolder(group),
        `folder-${group.id}`,
      );
      const art = el('span', 'folder-icon-wrap');
      const details = folderIndex.details.get(group.id);
      art.append(folderIcon(group, details.container, { state, appearance: details.appearance }));
      const count = counts.get(group.id) || 0;
      const copy = el('span', 'item-copy');
      copy.append(
        el('strong', '', group.name),
        el('small', '', `${count} ${count === 1 ? 'tab' : 'tabs'}`),
      );
      node.append(art, copy, icon('chevron'));
      return node;
    },
    'Folders you create in the sidebar appear here.',
  );
  showRows(
    'later',
    available.filter(isSavedForLater).sort((a, b) => b.savedForLaterAt - a.savedForLaterAt),
    3,
    (tab) =>
      entry(tab, domain(tab.url), () => request('activateTab', { id: tab.id }), `later-${tab.id}`),
    'Save tabs for later from the sidebar to see them here.',
  );
  showRows(
    'recent',
    state.recentlyClosed,
    3,
    (tab) =>
      entry(
        tab,
        domain(tab.url),
        () => request('restoreClosedTab', { sessionId: tab.sessionId }),
        `closed-${tab.sessionId}`,
      ),
    state.recentlyClosedError
      ? 'Recently closed tabs are unavailable. Try reloading this page.'
      : 'Tabs closed in this window appear here.',
  );
  renderSearch();
  renderWeather();
  if (suspendedView) {
    restoreScroll($('new-tab-content'), suspendedView.scroll, document.scrollingElement);
    if (document.activeElement === document.body) restoreFocusToken(suspendedView.focus);
    suspendedView = undefined;
  }
  if (focused)
    [...document.querySelectorAll('[data-key]')]
      .find((node) => node.dataset.key === focused)
      ?.focus();
}

function renderWeather() {
  const value = prefs();
  const holder = $('weather');
  holder.hidden = !value.weatherEnabled;
  if (!value.weatherEnabled) {
    weatherGeneration++;
    weatherKey = undefined;
    return;
  }
  if (draft || demo) {
    holder.textContent = value.location
      ? `${value.location.name} · Weather appears when enabled and saved.`
      : 'Choose a weather location in Settings.';
    return;
  }
  if (!value.enabled) {
    weatherGeneration++;
    weatherKey = undefined;
    weatherData = null;
    holder.textContent = 'Weather is paused while the new tab page is off.';
    return;
  }
  const key = JSON.stringify(value.location);
  if (weatherKey !== key) {
    weatherKey = key;
    weatherData = null;
    holder.textContent = 'Loading weather…';
    const version = ++weatherGeneration;
    request('weatherCurrent')
      .then((data) => {
        if (disposed || version !== weatherGeneration) return;
        weatherData = data;
        if (data) renderWeather();
        else holder.textContent = 'Weather is paused.';
      })
      .catch((err) => {
        if (!disposed && version === weatherGeneration) holder.textContent = err.message;
      });
  }
  if (!weatherData) return;
  const degrees = (number) =>
    `${Math.round(value.unit === 'fahrenheit' ? (number * 9) / 5 + 32 : number)}°`;
  holder.replaceChildren();
  const current = el('div', 'weather-current');
  const location = el('div', 'weather-location');
  location.append(
    el('strong', '', value.location.name),
    el(
      'span',
      '',
      `${weatherLabel(weatherData.code)} · High ${degrees(weatherData.high)} / Low ${degrees(weatherData.low)}`,
    ),
  );
  current.append(
    el(
      'span',
      'temperature',
      `${degrees(weatherData.temperature)}${value.unit === 'fahrenheit' ? 'F' : 'C'}`,
    ),
    location,
  );
  const source = el('div', 'weather-source');
  const attribution = el('a', '', 'Open-Meteo');
  attribution.href = 'https://open-meteo.com/';
  attribution.target = '_blank';
  attribution.rel = 'noreferrer';
  source.append(
    attribution,
    document.createTextNode(
      ` · ${weatherData.stale ? 'Last available · ' : 'Updated '}${new Date(weatherData.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    ),
  );
  holder.append(current, source);
}

const scheduler = createRefreshScheduler({
  getState: () => state,
  getWindowId: () => windowId,
  canRefresh: () => Boolean(request) && !document.hidden,
  delay: 80,

  async refresh() {
    const version = viewGeneration;
    try {
      const next = await request('getNewTabState');
      if (disposed || document.hidden || version !== viewGeneration) return;
      state = next;
      render();
    } catch (err) {
      if (!disposed && !document.hidden && version === viewGeneration) throw err;
    }
  },

  onError(err) {
    if (!disposed && !document.hidden) error(err);
  },
});

for (const node of document.querySelectorAll('[data-icon]')) node.append(icon(node.dataset.icon));
$('customise').addEventListener('click', () => Promise.resolve(settings()).catch(error));
$('edit-links').addEventListener('click', () => Promise.resolve(settings()).catch(error));
$('search').addEventListener('input', renderSearch);
$('search').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    $('search').value = '';
    renderSearch();
  }
});
$('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('search').value.trim();
  if (!query) return;
  error();
  try {
    if (demo) throw new Error('Web search is available when Tabernacle is installed in Firefox.');
    const tab = await browser.tabs.getCurrent();
    const url = searchAddress(query);
    if (url) await browser.tabs.update(tab.id, { url });
    else await browser.search.search({ query, tabId: tab.id });
  } catch (err) {
    error(err);
  }
});
for (const id of ['folders', 'later', 'recent'])
  $(`all-${id}`).addEventListener('click', () => {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
  });

async function start() {
  if (demo) {
    const { connectDemo } = await import('../../preview/session.js');
    if (disposed) return;
    const controller = await connectDemo(scheduler.schedule);
    if (disposed) return;
    windowId = 1;
    request = (type, args = {}) => controller.request({ type, windowId, ...args });
    if (params.has('preview'))
      draft = normalizeNewTab(
        JSON.parse(sessionStorage.getItem('tabernacle.newTabPreview') || 'null'),
      );
  } else {
    if (!globalThis.browser?.runtime?.id)
      throw new Error('Open this page from Tabernacle in Firefox.');
    const tab = await browser.tabs.getCurrent();
    if (disposed) return;
    windowId = tab.windowId;
    ownTabId = tab.id;

    const send = async (type, args = {}) => {
      windowId = (await browser.tabs.getCurrent()).windowId;
      const response = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!response?.ok)
        throw new Error(
          response?.error || 'Could not connect to Tabernacle. Reload this page to try again.',
        );
      return response.data;
    };

    readSnapshot = createSnapshotReader((snapshotToken) =>
      send('getNewTabState', { incremental: true, snapshotToken }),
    );
    request = (type, args) => (type === 'getNewTabState' ? readSnapshot() : send(type, args));
    const token = params.get('preview');
    if (token) {
      const key = `tabernacle.newTabPreview.${token}`;
      const value = (await browser.storage.session.get(key))[key];
      if (value) sessionStorage.setItem('tabernacle.newTabPreview', JSON.stringify(value));
      draft = normalizeNewTab(
        value || JSON.parse(sessionStorage.getItem('tabernacle.newTabPreview') || 'null'),
      );
      await browser.storage.session.remove(key);
    }
    // Finish consuming an already-read preview token, then avoid late listeners.
    if (disposed) return;

    const changed = (message) => {
      if (message.type === 'tabernacle:changed') scheduler.schedule(message);
    };

    browser.runtime.onMessage.addListener(changed);

    const permissionsChanged = () => {
      weatherKey = undefined;
      scheduler.schedule();
    };

    browser.permissions.onRemoved.addListener(permissionsChanged);
    browser.permissions.onAdded.addListener(permissionsChanged);
    window.addEventListener(
      'pagehide',
      () => {
        browser.permissions.onRemoved.removeListener(permissionsChanged);
        browser.permissions.onAdded.removeListener(permissionsChanged);
      },
      { once: true },
    );
    window.addEventListener('pagehide', () => browser.runtime.onMessage.removeListener(changed), {
      once: true,
    });
  }
  await scheduler.now();
  if (disposed) return;
  if (params.has('start')) {
    // A runtime redirect cannot select Firefox's address bar. Focus our input
    // once for a newly opened foreground page; background tabs never take focus.
    const url = new URL(location.href);
    url.searchParams.delete('start');
    history.replaceState(null, '', url.href);
    if (!document.hidden) {
      window.focus();
      (prefs().showSearch ? $('search') : $('customise')).focus();
    }
  }
}

function date() {
  $('date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

date();
const timer = setInterval(() => {
  if (!document.hidden) {
    date();
    weatherKey = undefined;
    scheduler.schedule();
  }
}, 30 * 60_000);

function hasResultSelection() {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (!range.collapsed && range.intersectsNode($('new-tab-content'))) return true;
  }
  return false;
}

function suspend() {
  viewGeneration++;
  weatherGeneration++;
  // Preserve the existing visible refresh path for native Find/user selections.
  // Page disposal still releases all derived state.
  if (!disposed && hasResultSelection()) return;
  if (state && !suspendedView)
    suspendedView = {
      scroll: captureScroll(
        $('new-tab-content'),
        '[data-key]',
        'data-key',
        document.scrollingElement,
      ),
      focus: captureFocus(),
    };
  readSnapshot?.clear();
  state = undefined;
  weatherKey = undefined;
  weatherData = null;
  for (const id of ['links', 'folders', 'later', 'recent', 'search-matches'])
    $(id).replaceChildren();
  $('loading').hidden = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspend();
  else {
    date();
    weatherKey = undefined;
    scheduler.schedule();
  }
});
window.addEventListener('focus', () => scheduler.schedule());
window.addEventListener(
  'pagehide',
  () => {
    disposed = true;
    suspend();
    suspendedView = undefined;
    weatherGeneration++;
    clearInterval(timer);
    scheduler.dispose();
  },
  { once: true },
);
start().catch((err) => {
  if (disposed) return;
  $('loading').hidden = true;
  error(err);
});
