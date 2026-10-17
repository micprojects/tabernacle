import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { SITE_ENHANCEMENTS, coversOrigin, siteAccess } from '../extension/src/site-enhancements.js';
import { SITE_MODES, siteOrigins } from '../extension/src/site-modes.js';

test('global enhancement preference preserves site choices, survives restart and notifies all windows', async () => {
  const api = memoryBrowser({ tabs: [{ id: 1, windowId: 1, url: 'https://reddit.com/' }] });
  const notices = [];
  const controller = createController(api, (notice) => notices.push(notice));
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  assert.equal((await send('getSettings')).siteEnhancementsEnabled, true);
  await send('setSiteMode', { mode: 'reddit', enabled: false });
  await send('setYouTubeMode', { enabled: true });
  await send('setSiteEnhancementsEnabled', { enabled: false });
  assert.equal(notices.at(-1).windowId, undefined);
  const reopened = createController(api);
  for (const type of ['getSettings', 'snapshot']) {
    const state = await reopened.request({ type, windowId: 1 });
    assert.equal(state.siteEnhancementsEnabled, false);
    assert.equal(state.youtubeMode, true);
    assert.equal(state.siteModes.reddit, false);
  }
  await send('setSiteEnhancementsEnabled', { enabled: true });
  assert.equal((await send('getSettings')).siteModes.reddit, false);
  for (const enabled of [null, 'false', 0, undefined])
    await assert.rejects(send('setSiteEnhancementsEnabled', { enabled }));
  api.storage.local.set = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(
    send('setSiteEnhancementsEnabled', { enabled: false }),
    /Storage unavailable/,
  );
  assert.equal((await send('getSettings')).siteEnhancementsEnabled, true);
});

test('settings catalogue covers all enhancements and uses the existing domain permission scopes', () => {
  assert.deepEqual(
    SITE_ENHANCEMENTS.map(({ id }) => id),
    ['youtube', ...Object.keys(SITE_MODES)],
  );
  for (const enhancement of SITE_ENHANCEMENTS.slice(1)) {
    for (const { domain, origins } of enhancement.sites) {
      assert.deepEqual(origins, siteOrigins(domain, enhancement.id));
      assert(origins.length > 0);
      assert(!origins.includes('https://*/*'));
    }
  }
});

test('access management recognises partial and wider grants without revoking unrelated sites', async () => {
  const origins = ['https://*.reddit.com/*'];
  let grants = [];
  const permissions = {
    getAll: async () => ({ origins: grants }),
    contains: async ({ origins }) =>
      origins.every((origin) => grants.some((grant) => coversOrigin(grant, origin))),
  };
  assert.deepEqual(await siteAccess(permissions, origins), {
    allowed: false,
    any: false,
    wider: false,
    removable: [],
  });
  grants = ['https://www.reddit.com/*', 'https://github.com/*'];
  assert.deepEqual(await siteAccess(permissions, origins), {
    allowed: false,
    any: true,
    wider: false,
    removable: ['https://www.reddit.com/*'],
  });
  grants = ['https://*.reddit.com/*'];
  assert.equal((await siteAccess(permissions, origins)).allowed, true);
  for (const grant of ['https://*/*', '*://*.reddit.com/*', '<all_urls>']) {
    grants = [grant];
    const access = await siteAccess(permissions, origins);
    assert.equal(access.wider, true);
    assert.equal(access.allowed, true);
    assert.deepEqual(access.removable, []);
  }
  assert.equal(coversOrigin('https://*.google.com/*', 'https://docs.google.com/*'), true);
  assert.equal(coversOrigin('https://*.reddit.com/*', 'https://reddit.com.evil.test/*'), false);
  assert.equal(coversOrigin('http://*/*', 'https://reddit.com/*'), false);
});
