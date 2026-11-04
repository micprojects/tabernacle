import { createSnapshotReader } from './snapshot-transfer.js';
import { icon } from './icons.js';
import { groupPath } from './model.js';
import { activityDay, activityTime } from './activity-data.js';
import { recentItems, recentActivityDays } from './recent-history.js';
import { normalizeNewTab, isNewTabPage, searchAddress } from './new-tab/preferences.js';
import { createRefreshScheduler } from './refresh-scheduler.js';
import { weatherLabel } from './new-tab/weather.js';
import { captureFocus, restoreFocusToken, captureScroll, restoreScroll } from './view-state.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const demo = !globalThis.browser?.runtime?.id && params.has('demo');
let state, request, windowId, ownTabId, draft, weatherData, weatherKey;
let readFailed = false;
let disposed = false;
let readSnapshot;
let suspendedView;
let viewGeneration = 0;
let weatherGeneration = 0;
const expanded = new Set();
const presses = new Map();
let renderPending = false;

function deferRender() {
  if (!presses.size) return false;
  renderPending = true;
  return true;
}

function holdRender(key, event) {
  if (event.target.closest('#new-tab-content button, #new-tab-content a')) presses.set(key, {});
}

function releaseRender(key) {
  const press = presses.get(key);
  if (!press) return;
  // Pointer and Space activation dispatch their click after the release event.
  // Retain the original control until that click has reached its handler.
  setTimeout(() => {
    if (presses.get(key) !== press) return;
    presses.delete(key);
    if (renderPending) render();
  }, 0);
}

document.addEventListener('pointerdown', (event) => holdRender(event.pointerId, event), true);
for (const type of ['pointerup', 'pointercancel'])
  document.addEventListener(type, (event) => releaseRender(event.pointerId), true);
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key === ' ' || event.key === 'Enter') holdRender(event.key, event);
  },
  true,
);
document.addEventListener('keyup', (event) => releaseRender(event.key), true);
window.addEventListener('blur', () => {
  for (const key of presses.keys()) releaseRender(key);
});

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function error(error, readFailure = false) {
  readFailed = readFailure;
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
    window.open(new URL('../settings.html?demo#features', import.meta.url), 'tabernacle-settings');
    return;
  }
  return request('openPage', { page: 'settings', section: 'features' });
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
  row.title = `${item.title || item.name || item.url}\n${subtitle}`;
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
  if (deferRender()) return;
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
    `${count} matching tabs and folders${foundTabs.length > 12 || groups.length > 6 ? '; showing the first matches' : ''}.`;
}

function renderRecent(now = Date.now()) {
  const container = $('recent');
  container.replaceChildren();
  if (!prefs().showRecent) return;
  const items = recentItems(state, 'closed');
  const limit = 8;
  const shown = expanded.has('recent') ? items : items.slice(0, limit);
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (const [index, day] of recentActivityDays(shown).entries()) {
    const section = el('section', 'recent-day');
    const label = activityDay(day.timestamp, now);
    const heading = el('h3', 'recent-day-heading', label);
    heading.id = `recent-day-${index}`;
    section.setAttribute('aria-labelledby', heading.id);
    const list = el('div', 'recent-day-list');
    for (const { items } of day.sessions) {
      for (const item of items) {
        const row = button(
          `Reopen ${item.title}`,
          'entry recent-entry',
          () => request('restoreClosedTab', { sessionId: item.sessionId }),
          `closed-${item.sessionId}`,
        );
        const time = el(
          'time',
          'recent-time',
          item.timestamp
            ? label === 'Today'
              ? activityTime(item.timestamp, now)
              : formatter.format(item.timestamp)
            : '',
        );
        if (item.timestamp) {
          time.dateTime = new Date(item.timestamp).toISOString();
          time.title = new Date(item.timestamp).toLocaleString();
        }
        row.title = [item.title, item.url, time.title].filter(Boolean).join('\n');
        row.append(
          favicon(item, 'entry-icon'),
          el('span', 'recent-title', item.title),
          el('span', 'recent-domain', item.detail),
          time,
          icon('undo'),
        );
        list.append(row);
      }
    }
    section.append(heading, list);
    container.append(section);
  }
  if (state.recentlyClosedError)
    container.append(
      el('p', 'error', 'Recently closed tabs are unavailable. Try reloading this page.'),
    );
  else if (!items.length)
    container.append(el('p', 'empty', 'Tabs closed in this window appear here.'));
  const toggle = $('all-recent');
  toggle.hidden = items.length <= limit;
  toggle.textContent = expanded.has('recent') ? 'Show fewer' : 'View all';
  toggle.setAttribute('aria-expanded', String(expanded.has('recent')));
}

function render() {
  if (!state || disposed || document.hidden) return;
  if (deferRender()) return;
  renderPending = false;
  const focused = document.activeElement?.dataset.key;
  const recentIndex = [...$('recent').querySelectorAll('button')].indexOf(document.activeElement);
  const value = prefs();
  document.documentElement.dataset.colorScheme =
    value.colorScheme === 'inherit' ? state.look.colorScheme : value.colorScheme;
  $('loading').hidden = true;
  $('links-section').hidden = false;
  $('search-section').hidden = !value.showSearch;
  $('recent-section').hidden = !value.showRecent;
  $('preview-notice').hidden = !params.has('preview') && !demo;
  if (demo)
    $('preview-notice').textContent =
      'Preview with example tabs. Changes here do not affect Firefox.';
  const available = tabs();
  // Match the first available tab, including a missing favicon, as before.
  // Index only requested link hosts, stopping when each has its first match.
  const linkDomains = value.links.map((link) => domain(link.url));
  const remainingDomains = new Set(linkDomains);
  const tabsByDomain = new Map();
  for (const tab of available) {
    if (!remainingDomains.size) break;
    const key = domain(tab.url);
    if (remainingDomains.delete(key)) tabsByDomain.set(key, tab);
  }
  $('links').classList.toggle('list-style', value.linkStyle === 'list');
  $('links').replaceChildren(
    ...value.links.map((link, i) => {
      const node = el('a', 'site');
      node.href = link.url;
      node.dataset.key = `link-${link.id}`;
      const known = tabsByDomain.get(linkDomains[i]);
      node.append(favicon(known, 'site-icon'), el('span', 'site-label', link.name));
      return node;
    }),
  );
  const add = button('Add link', 'site add', settings, 'add-link');
  const plus = el('span', 'site-icon');
  plus.append(icon('plus'));
  add.append(plus, el('span', 'site-label', 'Add link'));
  $('links').append(add);
  renderRecent();
  renderSearch();
  renderWeather();
  if (suspendedView) {
    restoreScroll($('new-tab-content'), suspendedView.scroll, document.scrollingElement);
    if (document.activeElement === document.body) restoreFocusToken(suspendedView.focus);
    suspendedView = undefined;
  }
  if (focused) {
    const matching = [...document.querySelectorAll('[data-key]')].find(
      (node) => node.dataset.key === focused,
    );
    const recentRows = [...$('recent').querySelectorAll('button')];
    const fallback =
      recentIndex >= 0
        ? recentRows[Math.min(recentIndex, recentRows.length - 1)] || $('recent-title')
        : null;
    (matching || fallback)?.focus({ preventScroll: true });
  }
}

function renderWeather() {
  if (deferRender()) return;
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
    el('strong', '', value.location.name.split(',')[0]),
    el(
      'span',
      '',
      `${weatherLabel(weatherData.code)} · High ${degrees(weatherData.high)} / Low ${degrees(weatherData.low)}`,
    ),
  );
  current.title = `${value.location.name} · ${weatherLabel(weatherData.code)} · High ${degrees(weatherData.high)} / Low ${degrees(weatherData.low)}`;
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
      if (readFailed) error();
      render();
    } catch (err) {
      if (!disposed && !document.hidden && version === viewGeneration) throw err;
    }
  },

  onError(err) {
    if (!disposed && !document.hidden) error(err, true);
  },
});

for (const node of document.querySelectorAll('[data-icon]')) node.append(icon(node.dataset.icon));
$('customise').addEventListener('click', () => Promise.resolve(settings()).catch(error));
$('search').addEventListener('input', renderSearch);
$('search').addEventListener('keydown', (event) => {
  if (event.isComposing) return;
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
$('all-recent').addEventListener('click', () => {
  if (expanded.has('recent')) expanded.delete('recent');
  else expanded.add('recent');
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
      send('getNewTabState', { incremental: 3, snapshotToken }),
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
  const now = new Date();
  $('clock').dateTime = now.toISOString();
  $('clock').textContent = now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  $('date').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

let clockTimer;

function updateClock() {
  clearTimeout(clockTimer);
  if (disposed || document.hidden) return;
  date();
  render();
  clockTimer = setTimeout(updateClock, 60_000 - (Date.now() % 60_000));
}

updateClock();
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
  clearTimeout(clockTimer);
  presses.clear();
  renderPending = false;
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
  for (const id of ['links', 'recent', 'search-matches']) $(id).replaceChildren();
  $('loading').hidden = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspend();
  else {
    updateClock();
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
  error(err, true);
});
