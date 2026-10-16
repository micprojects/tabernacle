import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createYouTubeService,
  youtubeVideoId,
  normaliseVideoData,
  videoTime,
  videoInProgress,
} from '../extension/src/youtube.js';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { closeFallback } from '../extension/src/close-selection.js';

const videoId = 'OakDesk0001';
const url = `https://www.youtube.com/watch?v=${videoId}`;

test('YouTube IDs match supported video routes, ignoring timestamps but rejecting lookalikes', () => {
  for (const value of [
    url,
    `${url}&t=100`,
    `https://m.youtube.com/shorts/${videoId}`,
    `https://youtube.com/live/${videoId}`,
    `https://youtu.be/${videoId}?t=5`,
  ])
    assert.equal(youtubeVideoId(value), videoId);
  for (const value of [
    'https://youtube.com/playlist?list=test',
    'https://youtube.com/watch?v=bad',
    `https://youtube.com.evil.test/watch?v=${videoId}`,
    `https://example.test/?v=${videoId}`,
    `file://youtube.com/watch?v=${videoId}`,
  ])
    assert.equal(youtubeVideoId(value), null);
});

test('unknown, live and finished positions do not become misleading progress', () => {
  assert.equal(videoTime(3723), '1:02:03');
  assert.equal(videoTime(Infinity), '');
  assert.equal(normaliseVideoData({ videoId: 'Other000001' }, videoId), null);
  const data = normaliseVideoData({ videoId, position: 90, duration: 60, paused: false }, videoId);
  assert.equal(data.position, 60);
  assert.equal(videoInProgress(data), false);
  assert.equal(videoInProgress({ position: 12, duration: 60 }), true);
  assert.equal(videoInProgress({ position: 0, duration: 60 }), false);
  assert.equal(videoInProgress({ position: 12, duration: 60, live: true }), false);
  assert.equal(
    normaliseVideoData({ videoId, position: NaN, duration: Infinity }, videoId).position,
    null,
  );
});

function serviceFixture() {
  const tabs = new Map([
    [1, { id: 1, url }],
    [2, { id: 2, url, discarded: true }],
  ]);
  const sessions = new Map();
  const calls = { scripts: [], requests: [] };
  let grant = true;
  let player = { videoId, channel: 'Bench Notes', duration: 1122, position: 750, paused: true };
  const api = {
    permissions: { contains: async () => grant, request: async () => (grant = true) },
    tabs: { get: async (id) => tabs.get(id) },
    scripting: {
      executeScript: async ({ target }) => {
        calls.scripts.push(target.tabId);
        return [{ result: player }];
      },
    },
    sessions: {
      getTabValue: async (id) => sessions.get(id),
      setTabValue: async (id, key, value) => sessions.set(id, value),
    },
  };

  const fetcher = async (url, options) => {
    calls.requests.push({ url, options });
    return { ok: true, json: async () => ({ author_name: 'Public channel' }) };
  };

  return {
    api,
    tabs,
    sessions,
    calls,
    fetcher,
    setPlayer: (value) => (player = value),
    revoke: () => (grant = false),
  };
}

test('player observations stay per tab, survive sidebar reopening, and never wake discarded tabs', async () => {
  const f = serviceFixture();
  const service = createYouTubeService(f);
  await service.permission();
  service.setActive(true);
  await service.read(f.tabs.get(1));
  await service.read(f.tabs.get(2));
  assert.deepEqual(f.calls.scripts, [1]);
  assert.equal(service.peek(f.tabs.get(1)).position, 750);
  assert.equal(service.peek(f.tabs.get(2)).position, undefined);
  assert.equal(service.peek(f.tabs.get(2)).channel, 'Bench Notes');
  assert.equal(service.peek(f.tabs.get(2)).duration, 1122);
  assert.equal(f.calls.requests.length, 0);
  const reopened = createYouTubeService(f);
  await reopened.hydrate(f.tabs.get(1));
  assert.equal(reopened.peek(f.tabs.get(1)).position, 750);
  assert.equal(reopened.peek(f.tabs.get(1)).paused, true);
});

test('mode off and denied access do not read pages or fetch metadata', async () => {
  const f = serviceFixture();
  const service = createYouTubeService(f);
  await service.permission();
  await service.read(f.tabs.get(1));
  assert.deepEqual(f.calls.scripts, []);
  f.revoke();
  await service.permission();
  service.setActive(true);
  await service.read(f.tabs.get(1));
  assert.deepEqual(f.calls.scripts, []);
  assert.deepEqual(f.calls.requests, []);
});

test('a native duplicate cannot inherit another tab’s saved playback position', async () => {
  const f = serviceFixture();
  f.sessions.set(1, { videoId, treeId: 'source', duration: 100, position: 75 });
  f.sessions.set(2, { videoId, treeId: 'source', duration: 100, position: 75 });
  f.tabs.get(1).treeId = 'source';
  f.tabs.get(2).treeId = 'duplicate';
  const service = createYouTubeService(f);
  await service.hydrate(f.tabs.get(1));
  await service.hydrate(f.tabs.get(2));
  assert.equal(service.peek(f.tabs.get(1)).position, 75);
  assert.equal(service.peek(f.tabs.get(2)).position, undefined);
});

test('duplicate metadata requests are shared; navigation rejects a stale player response', async () => {
  const f = serviceFixture();
  f.tabs.get(1).discarded = true;
  const service = createYouTubeService(f);
  await service.permission();
  service.setActive(true);
  await Promise.all([service.read(f.tabs.get(1)), service.read(f.tabs.get(2))]);
  assert.equal(f.calls.requests.length, 1);
  assert.equal(f.calls.requests[0].options.credentials, 'omit');
  f.tabs.get(1).discarded = false;
  f.api.scripting.executeScript = async () => {
    f.tabs.get(1).url = 'https://www.youtube.com/watch?v=Changed0001';
    return [{ result: { videoId, position: 20, duration: 40 } }];
  };
  await service.read({ id: 1, url });
  service.prune([...f.tabs.values()]);
  assert.equal(service.peek(f.tabs.get(1)).position, undefined);
});

test('YouTube Mode defaults on, persists off across controllers, and notifies other windows', async () => {
  const api = memoryBrowser();
  const notices = [];
  const first = createController(api, (notice) => notices.push(notice));
  assert.equal((await first.request({ type: 'snapshot', windowId: 1 })).youtubeMode, true);
  await first.request({ type: 'setYouTubeMode', windowId: 1, enabled: false });
  assert.equal(notices.at(-1).windowId, undefined);
  const reopened = createController(api);
  assert.equal((await reopened.request({ type: 'snapshot', windowId: 1 })).youtubeMode, false);
  await assert.rejects(reopened.request({ type: 'setYouTubeMode', windowId: 1, enabled: 'yes' }));
});

test('turning the mode off rejects a late player observation and prevents metadata requests', async () => {
  const f = serviceFixture();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let finish;
  f.api.scripting.executeScript = () => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const service = createYouTubeService(f);
  await service.permission();
  service.setActive(true);
  const work = service.read(f.tabs.get(1));
  await ready;
  service.setActive(false);
  finish([{ result: { videoId, duration: 100, position: 75 } }]);
  await work;
  assert.equal(service.peek(f.tabs.get(1)).position, undefined);
  assert.equal(f.calls.requests.length, 0);
});

test('filtered YouTube closes choose the visible neighbour above, then below', () => {
  const before = {
    groups: [],
    view: { scopeId: null, collapsed: [] },
    tabs: [1, 2, 3, 4].map((id, index) => ({
      id,
      index,
      url,
      active: id === 3,
      groupId: null,
      parentTabId: null,
    })),
  };
  const after = {
    ...before,
    tabs: before.tabs
      .filter((tab) => tab.id !== 3)
      .map((tab) => ({ ...tab, active: tab.id === 2 })),
  };
  assert.equal(
    closeFallback(before, after, 3, { domain: 'youtube.com', sort: 'tree', tabIds: [1, 3, 4] }),
    1,
  );
  assert.equal(
    closeFallback(before, after, 3, { domain: 'youtube.com', sort: 'tree', tabIds: [3, 4] }),
    4,
  );
});
