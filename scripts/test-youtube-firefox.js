import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ScreenshotBrowser } from './screenshot-browser.js';
import { YOUTUBE_ORIGINS } from '../extension/src/youtube.js';

// Only an isolated temporary profile is used. The page/player fixture lives in
// a fresh public YouTube tab, with a tiny local silent video replacing its body.
const browser = new ScreenshotBrowser();
const size = { width: 320, height: 760 };
try {
  await mkdir('test-results', { recursive: true });
  await browser.open(
    {
      window: { width: 1100, height: 980 },
      sidebarWidth: size.width,
      capture: { sourceSize: size },
    },
    'test-results/firefox-youtube.log',
  );
  await browser.chrome(async (origins) => {
    const { ExtensionPermissions } = ChromeUtils.importESModule(
      'resource://gre/modules/ExtensionPermissions.sys.mjs',
    );
    const extension = WebExtensionPolicy.getByID('tabernacle@michaelprojects.com').extension;
    await ExtensionPermissions.add(
      'tabernacle@michaelprojects.com',
      { permissions: [], origins },
      extension,
    );
  }, YOUTUBE_ORIGINS);
  assert.equal(
    await browser.evaluate((origins) => browser.permissions.contains({ origins }), YOUTUBE_ORIGINS),
    true,
  );
  const fixture = await browser.evaluate(async () => {
    const { id: windowId } = await browser.windows.getCurrent();
    const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    const loaded = await browser.tabs.create({ windowId, url, active: true });
    const sleeping = await browser.tabs.create({
      windowId,
      url: `${url}&t=4`,
      title: 'Sleeping duplicate - YouTube',
      active: false,
      discarded: true,
    });
    return { windowId, loaded: loaded.id, sleeping: sleeping.id };
  });
  await browser.driver.wait(
    () =>
      browser.evaluate(
        async (id) => (await browser.tabs.get(id)).status === 'complete',
        fixture.loaded,
      ),
    30000,
  );
  const clip = (await readFile('scripts/fixtures/youtube-player.webm')).toString('base64');
  await browser.evaluate(
    async (id, clip) => {
      await browser.scripting.executeScript({
        target: { tabId: id },
        args: [clip],

        func: async (clip) => {
          window.stop();
          document.body.replaceChildren();
          document.title = 'Local playback fixture - YouTube';
          const owner = document.createElement('div');
          owner.id = 'owner';
          const channel = document.createElement('ytd-channel-name');
          const link = document.createElement('a');
          link.textContent = 'Local test channel';
          channel.append(link);
          owner.append(channel);
          const video = document.createElement('video');
          video.className = 'html5-main-video';
          video.controls = true;
          video.muted = true;
          const bytes = Uint8Array.from(atob(clip), (value) => value.charCodeAt(0));
          video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
          const player = document.createElement('div');
          player.className = 'html5-video-player';
          const liveBadge = document.createElement('button');
          liveBadge.className = 'ytp-live-badge';
          liveBadge.hidden = true;
          player.append(video, liveBadge);
          document.body.append(owner, player);
          await new Promise((resolve, reject) => {
            video.addEventListener('loadedmetadata', resolve, { once: true });
            video.addEventListener('error', () => reject(new Error('Fixture video failed')), {
              once: true,
            });
          });
          video.currentTime = 5;
        },
      });
    },
    fixture.loaded,
    clip,
  );
  const wait = (fn, ...args) => browser.driver.wait(() => browser.evaluate(fn, ...args), 15000);
  await wait(
    (id) => Boolean(document.querySelector(`#tree [data-key="tab:${id}"]`)),
    fixture.loaded,
  );
  await browser.evaluate((id) => {
    document
      .querySelector(`#tree [data-key="tab:${id}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 120 }));
    [...document.querySelectorAll('#menu button')]
      .find((button) => button.textContent === 'Filter by domain')
      .click();
  }, fixture.loaded);
  await wait(
    (id) =>
      document.querySelector(`[data-key="tab:${id}"] .youtube-position`)?.textContent ===
      '0:05 / 0:20',
    fixture.loaded,
  );
  assert.equal(
    await browser.evaluate(
      (id) => document.querySelector(`[data-key="tab:${id}"] .youtube-progress`).hidden,
      fixture.loaded,
    ),
    false,
  );
  assert.equal(
    await browser.evaluate(
      (id) => document.querySelector(`[data-key="tab:${id}"] .youtube-position`).hidden,
      fixture.sleeping,
    ),
    true,
  );
  assert.equal(
    await browser.evaluate(async (id) => (await browser.tabs.get(id)).discarded, fixture.sleeping),
    true,
  );
  await browser.evaluate(async (id) => {
    await browser.scripting.executeScript({
      target: { tabId: id },

      func: () => {
        document.querySelector('video').currentTime = 10;
      },
    });
  }, fixture.loaded);
  await wait((id) => {
    const progress = document.querySelector(`[data-key="tab:${id}"] .youtube-progress`);
    return progress && !progress.hidden && progress.value === 10 && progress.max === 20;
  }, fixture.loaded);
  await writeFile(
    'test-results/youtube-mode-firefox.png',
    await browser.screenshot({ sourceSize: size, scale: 2 }),
  );
  await browser.evaluate(() => document.getElementById('youtube-mode').click());
  await wait(
    () => document.getElementById('youtube-mode').getAttribute('aria-checked') === 'false',
  );
  await browser.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  await wait(() => Boolean(document.querySelector('#tree .tab-row')));
  await browser.evaluate((id) => {
    document
      .querySelector(`#tree [data-key="tab:${id}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 120 }));
    [...document.querySelectorAll('#menu button')]
      .find((button) => button.textContent === 'Filter by domain')
      .click();
  }, fixture.loaded);
  assert.equal(
    await browser.evaluate(() =>
      document.getElementById('youtube-mode').getAttribute('aria-checked'),
    ),
    'false',
  );
  assert.equal(await browser.evaluate(() => document.querySelectorAll('.youtube-row').length), 0);
  await browser.evaluate(() => document.getElementById('youtube-mode').click());
  await wait(
    (id) =>
      document.querySelector(`[data-key="tab:${id}"] .youtube-position`)?.textContent ===
      '0:10 / 0:20',
    fixture.loaded,
  );
  await browser.evaluate(
    async (ids) => {
      const { id: windowId } = await browser.windows.getCurrent();
      for (const id of ids) {
        const response = await browser.runtime.sendMessage({
          type: 'tabernacle:saveForLater',
          windowId,
          id,
        });
        if (!response.ok) throw new Error(response.error);
      }
      document.getElementById('later-toggle').click();
    },
    [fixture.loaded, fixture.sleeping],
  );
  await wait(
    (id) =>
      document.querySelector(`#later-view .later-row[data-id="${id}"] .youtube-position`)
        ?.textContent === '0:10 / 0:20',
    fixture.loaded,
  );
  assert.equal(
    await browser.evaluate(async (id) => (await browser.tabs.get(id)).discarded, fixture.sleeping),
    true,
  );
  await browser.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  await wait(() => document.getElementById('later-toggle')?.disabled === false);
  await browser.evaluate(() => document.getElementById('later-toggle').click());
  await wait(
    (id) =>
      document.querySelector(`#later-view .later-row[data-id="${id}"] .youtube-position`)
        ?.textContent === '0:10 / 0:20',
    fixture.loaded,
  );
  await writeFile(
    'test-results/later-youtube-firefox.png',
    await browser.screenshot({ sourceSize: size, scale: 2 }),
  );
  await browser.evaluate(async () => {
    const { id: windowId } = await browser.windows.getCurrent();
    await browser.runtime.sendMessage({
      type: 'tabernacle:setSiteEnhancementsEnabled',
      windowId,
      enabled: false,
    });
  });
  await wait(() => document.querySelectorAll('#later-view .youtube-row').length === 0);
  assert.equal(
    await browser.evaluate(async (id) => (await browser.tabs.get(id)).discarded, fixture.sleeping),
    true,
  );
  console.log(
    '✓ Native Firefox: optional site access, real media properties, unknown sleeping-tab progress, persisted YouTube Mode, and saved-video observations across sidebar reloads',
  );
} finally {
  await browser.close();
}
