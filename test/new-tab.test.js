import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBrowser, memoryEvent } from '../preview/browser.js';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY, TAB_KEY } from '../extension/src/model.js';
import {
  linkUrl,
  normalizeNewTab,
  requireNewTab,
  searchAddress,
} from '../extension/src/new-tab-preferences.js';
import { createNewTabRouting } from '../extension/src/new-tab-routing.js';
import { createWeatherService, WEATHER_ACCESS } from '../extension/src/new-tab-weather.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const location = { name: 'Manchester, England, United Kingdom', latitude: 53.48, longitude: -2.24 };
const link = { id: 'one', name: 'Example', url: 'https://example.com/' };

test('the page opens clear web addresses and leaves other input as a search', () => {
  for (const query of ['a search query', 'weather', 'javascript:alert(1)', 'data:text/html,test'])
    assert.equal(searchAddress(query), null);
  assert.throws(() => searchAddress('https://user:secret@example.com'));
  assert.throws(() => searchAddress('https://'));
  assert.equal(searchAddress('example.com/path?q=test'), 'https://example.com/path?q=test');
  assert.equal(searchAddress('http://localhost:4173'), 'http://localhost:4173/');
  assert.equal(searchAddress('example.com:443'), 'https://example.com/');
});

test('new tab is off by default; stored and submitted links reject unsafe URLs and oversized data', () => {
  assert.equal(normalizeNewTab().enabled, false);
  assert.equal(normalizeNewTab().weatherEnabled, false);
  assert.deepEqual(normalizeNewTab().links, []);
  assert.equal(linkUrl('example.com/path?q=hello'), 'https://example.com/path?q=hello');
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///etc/passwd',
    'https://user:secret@example.com',
    'https://' + 'x'.repeat(2050),
  ]) {
    assert.throws(() => linkUrl(url));
    assert.deepEqual(normalizeNewTab({ links: [{ ...link, url }] }).links, []);
    assert.throws(() => requireNewTab({ ...normalizeNewTab(), links: [{ ...link, url }] }));
  }
  assert.throws(() => requireNewTab({ ...normalizeNewTab(), links: [link, link] }));
  assert.throws(() => requireNewTab({ ...normalizeNewTab(), weatherEnabled: true }));
  assert.throws(() => requireNewTab({ ...normalizeNewTab(), enabled: 'true' }));
  assert.equal(
    requireNewTab({ ...normalizeNewTab(), weatherEnabled: true, location }).location.name,
    location.name,
  );
});

test('partial preferences persist across restarts and failed saves preserve every field', async () => {
  const api = memoryBrowser();
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  await send('setNewTab', { value: { links: [link], enabled: true } });
  await send('setNewTab', { value: { linkStyle: 'list' } });
  await send('setLook', { partial: true, value: { colorScheme: 'dark' } });
  const before = await send('getSettings');
  assert.deepEqual(before.newTab.links, [link]);
  assert.equal(before.newTab.enabled, true);
  assert.equal(before.newTab.linkStyle, 'list');
  const set = api.storage.local.set;
  api.storage.local.set = async () => {
    throw new Error('Disk unavailable');
  };
  await assert.rejects(send('setNewTab', { value: { enabled: false } }), /Disk unavailable/);
  api.storage.local.set = set;
  assert.deepEqual((await send('getSettings')).newTab, before.newTab);
  controller.dispose();
  const restarted = createController(api);
  assert.deepEqual(
    (await restarted.request({ type: 'getSettings', windowId: 1 })).newTab,
    before.newTab,
  );
  const preview = await restarted.request({
    type: 'previewNewTab',
    windowId: 1,
    value: { linkStyle: 'icons' },
  });
  assert((await api.tabs.get(preview.tabId)).url.includes('?preview='));
  assert.equal(
    (await restarted.request({ type: 'getSettings', windowId: 1 })).newTab.linkStyle,
    'list',
  );
  await api.tabs.remove(preview.tabId);
  assert.deepEqual((await restarted.request({ type: 'snapshot', windowId: 1 })).recentlyClosed, []);
  restarted.dispose();
});

test('routing respects opt-in, blanks, private/discarded/restored tabs, other overrides and navigation races', async () => {
  const api = memoryBrowser({ events: true });
  const router = createNewTabRouting(api);
  const off = await api.tabs.create({});
  await tick();
  assert.equal((await api.tabs.get(off.id)).url, 'about:newtab');
  await api.storage.local.set({ [MODEL_KEY]: { newTab: { enabled: true } } });
  const fresh = await api.tabs.create({});
  await tick();
  assert.equal((await api.tabs.get(fresh.id)).url, api.runtime.getURL('new-tab.html?start=1'));
  for (const props of [
    { url: 'about:blank' },
    { url: 'about:home' },
    { url: 'moz-extension://other/start.html' },
    { incognito: true },
    { discarded: true },
  ]) {
    const tab = await api.tabs.create(props);
    await tick();
    assert.equal((await api.tabs.get(tab.id)).url, tab.url);
  }
  const restored = await api.tabs.create({ url: 'about:blank' });
  await api.sessions.setTabValue(restored.id, TAB_KEY, {
    groupId: null,
    openedAt: Date.now() - 10000,
  });
  await api.tabs.update(restored.id, { url: 'about:newtab' });
  await tick();
  assert.equal((await api.tabs.get(restored.id)).url, 'about:newtab');
  const race = await api.tabs.create({});
  await api.tabs.update(race.id, { url: 'https://example.com/' });
  await tick();
  assert.equal((await api.tabs.get(race.id)).url, 'https://example.com/');
  const pending = await api.tabs.create({ url: 'about:blank' });
  await api.storage.local.set({ [MODEL_KEY]: { newTab: { enabled: false } } });
  await api.tabs.update(pending.id, { url: 'about:newtab' });
  await tick();
  assert.equal((await api.tabs.get(pending.id)).url, 'about:newtab');
  router.dispose();
});

function weatherFixture() {
  const api = memoryBrowser({ events: true });
  let allowed = false;
  api.permissions = {
    contains: async (permission) => {
      assert.deepEqual(permission, WEATHER_ACCESS);
      return allowed;
    },

    onRemoved: memoryEvent(),
  };
  const calls = [];

  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        current: { temperature_2m: 14, weather_code: 3 },
        daily: { temperature_2m_max: [15], temperature_2m_min: [9] },
      }),
    };
  };

  return {
    api,
    calls,
    fetcher,

    allow: () => {
      allowed = true;
    },

    revoke: () => {
      allowed = false;
      api.permissions.onRemoved.emit({});
    },
  };
}

test('weather needs both saved opt-ins and permission; requests are shared, cached across restarts and omit credentials', async () => {
  const f = weatherFixture();
  const service = createWeatherService(f.api, f.fetcher);
  assert.equal(await service.current(), null);
  await f.api.storage.local.set({
    [MODEL_KEY]: { newTab: { enabled: true, weatherEnabled: true, location } },
  });
  await assert.rejects(service.current(), /Allow weather access/);
  assert.equal(f.calls.length, 0);
  f.allow();
  const [a, b] = await Promise.all([service.current(), service.current()]);
  assert.equal(a.temperature, 14);
  assert.deepEqual(a, b);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.credentials, 'omit');
  assert.equal(f.calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(new URL(f.calls[0].url).searchParams.get('latitude'), '53.48');
  assert.deepEqual(await createWeatherService(f.api, f.fetcher).current(), a);
  assert.equal(f.calls.length, 1);
  f.revoke();
  await assert.rejects(service.current(), /Allow weather access/);
  f.allow();
  await f.api.storage.local.set({
    [MODEL_KEY]: { newTab: { enabled: false, weatherEnabled: true, location } },
  });
  assert.equal(await service.current(), null);
  assert.equal(f.calls.length, 1);
});

test('late weather responses are discarded after opt-out even when the transport ignores abort', async () => {
  const f = weatherFixture();
  f.allow();
  await f.api.storage.local.set({
    [MODEL_KEY]: { newTab: { enabled: true, weatherEnabled: true, location } },
  });
  let release;
  const service = createWeatherService(f.api, async (url, options) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return f.fetcher(url, options);
  });
  const pending = service.current();
  await tick();
  await f.api.storage.local.set({
    [MODEL_KEY]: { newTab: { enabled: false, weatherEnabled: true, location } },
  });
  release();
  assert.equal(await pending, null);
  assert.equal(
    (await f.api.storage.local.get('tabernacle.weather.v1'))['tabernacle.weather.v1'],
    undefined,
  );
});

test('location search is bounded, user-initiated, encoded and ignores invalid provider results', async () => {
  const f = weatherFixture();
  const service = createWeatherService(f.api, async (url) => {
    assert.equal(new URL(url).searchParams.get('name'), 'York & Leeds');
    return {
      ok: true,
      json: async () => ({
        results: [
          {
            name: 'York',
            admin1: 'England',
            country: 'United Kingdom',
            latitude: 53.95,
            longitude: -1.08,
          },
          { name: 'Broken', latitude: 999, longitude: 1 },
        ],
      }),
    };
  });
  await assert.rejects(service.locations('York'), /Allow weather access/);
  f.allow();
  const results = await service.locations('York & Leeds');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'York, England, United Kingdom');
});

test('weather rejects malformed cache entries and keeps stale readings available during an outage', async () => {
  const f = weatherFixture();
  f.allow();
  const model = { newTab: { enabled: true, weatherEnabled: true, location } };
  await f.api.storage.local.set({
    [MODEL_KEY]: model,
    'tabernacle.weather.v1': {
      key: '53.48,-2.24',
      temperature: 12,
      fetchedAt: Date.now() + 3600000,
    },
  });
  const service = createWeatherService(f.api, f.fetcher);
  const result = await service.current();
  assert.equal(result.temperature, 14);
  assert.equal(f.calls.length, 1);
  await f.api.storage.local.set({
    'tabernacle.weather.v1': { ...result, fetchedAt: Date.now() - 3600000 },
  });
  let attempts = 0;
  const offline = createWeatherService(f.api, async () => {
    attempts++;
    throw new Error('Offline');
  });
  assert.equal((await offline.current()).stale, true);
  assert.equal((await offline.current()).temperature, 14);
  assert.equal(attempts, 1, 'Repeated page loads should respect the retry backoff');
  await f.api.storage.local.set({
    [MODEL_KEY]: { newTab: { ...model.newTab, location: { ...location, latitude: 51 } } },
  });
  await assert.rejects(offline.current(), /Weather is unavailable/);
  assert.equal(attempts, 2, 'A new location should not inherit the previous location’s backoff');
});
