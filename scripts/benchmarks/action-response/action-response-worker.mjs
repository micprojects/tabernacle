import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FrameBrowser } from '../../memory/frame-browser.js';
import { fingerprintSource } from '../../memory/common.js';

const [root, countText] = process.argv.slice(2),
  count = Number(countText);
assert([100, 1000].includes(count), 'Use a fixed 100- or 1,000-tab collection.');
assert(process.send, 'Run this worker through the guarded action-response runner.');
const browser = new FrameBrowser();
const emit = (type, data = {}) => process.send?.({ type, ...data });
const result = { status: 'running', source: await fingerprintSource(root), count };
const requests = new Map();
const server = createServer((request, response) => {
  requests.set(request.url, (requests.get(request.url) || 0) + 1);
  response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  response.end(
    '<!doctype html><title>Action response local fixture</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"><p>Live page retained during action-response</p>',
  );
});
process.once('SIGTERM', () => browser.close().catch(() => {}));
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  result.runtime = await browser.open();
  emit('stage', { name: 'create-fixtures' });
  for (let offset = 0; offset < count - 3; offset += 25) {
    await browser.control(
      async (offset, count) => {
        const tabs = await Promise.all(
          Array.from({ length: Math.min(25, count - 3 - offset) }, (_, j) =>
            browser.tabs.create({
              url: `https://independent.invalid/${offset + j}`,
              title: `Independent ${offset + j}`,
              discarded: true,
              active: false,
            }),
          ),
        );
        if (tabs.some((tab) => !tab.discarded)) throw new Error('Loaded discarded fixture');
      },
      offset,
      count,
    );
    emit('progress', { created: Math.min(offset + 25, count - 3) });
  }
  const live = await browser.control(async (url) => {
    const ids = [];
    for (let i = 0; i < 3; i++)
      ids.push((await browser.tabs.create({ url: url + i, index: i + 1, active: false })).id);
    return ids;
  }, `http://127.0.0.1:${server.address().port}/live/`);
  emit('stage', { name: 'install' });
  await browser.install(root);
  await browser.show();
  const deadline = Date.now() + 30000;
  let panel;
  while (Date.now() < deadline) {
    panel = (await browser.panels()).find((p) => p.isTarget && p.open && !p.hidden);
    if (
      panel &&
      (await browser.frame(
        panel.browserId,
        async (ids) => {
          const tabs = await Promise.all(ids.map((id) => browser.tabs.get(id)));
          return tabs.every(
            (tab) =>
              tab.status === 'complete' &&
              !tab.discarded &&
              document.querySelector(`#tree .tab-row[data-id="${tab.id}"]`),
          );
        },
        live,
      ))
    )
      break;
    panel = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(panel, 'Live action-response rows not ready');
  assert(await browser.noDebugger());
  const run = (rounds) =>
    browser.frame(
      panel.browserId,
      async (ids, rounds) => {
        const initial = await window.actionBenchmarkRequest('snapshot');
        const response = [],
          dom = [],
          frames = [];
        for (let i = 0; i < rounds; i++) {
          const id = ids[i % ids.length];
          const muted = !(await browser.tabs.get(id)).mutedInfo.muted;
          const start = performance.now();
          const next = await window.actionBenchmarkRequest('muteTab', clone({ id }));
          response.push(performance.now() - start);
          if (
            next.tabs.length !== initial.tabs.length ||
            next.tabs.find((tab) => tab.id === id)?.mutedInfo?.muted !== muted
          )
            throw new Error('Action response differs from expected native mute state');
          const deadline = performance.now() + 10000;

          const correct = () => {
            const row = document.querySelector(`#tree .tab-row[data-id="${id}"]`);
            const button = row?.querySelector('[data-row-action="mute-tab"]');
            return row && (muted ? button?.getAttribute('aria-label') === 'Unmute tab' : !button);
          };

          while (!correct() && performance.now() < deadline)
            await new Promise((resolve) => window.setTimeout(resolve, 1));
          if (!correct()) throw new Error('Sidebar failed to converge after action');
          dom.push(performance.now() - start);
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
          frames.push(performance.now() - start);
        }
        return { response, dom, frames, rounds };
      },
      live,
      rounds,
    );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  emit('stage', { name: 'warmup' });
  await run(9);
  const identities = () =>
    browser.frame(panel.browserId, async () => {
      const windowId = (await browser.windows.getCurrent()).id;
      const response = await browser.runtime.sendMessage(
        clone({ type: 'tabernacle:snapshot', windowId }),
      );
      if (!response.ok) throw new Error(response.error);
      const native = await browser.tabs.query(clone({ windowId }));
      return {
        identities: response.data.tabs.map(
          ({ id, treeId, groupId, order, pinned, cookieStoreId }) => ({
            id,
            treeId,
            groupId,
            order,
            pinned,
            cookieStoreId,
          }),
        ),
        active: response.data.tabs
          .filter((tab) => tab.active)
          .map((tab) => ({ id: tab.id, lastAccessed: tab.lastAccessed })),
        nativeActive: native.filter((tab) => tab.active).map((tab) => tab.id),
        nativeCount: native.length,
      };
    });
  const beforeIdentity = await identities();
  emit('stage', { name: 'action-response' });
  const before = await browser.cpu(),
    started = performance.now();
  result.observation = await run(90);
  result.elapsedMs = performance.now() - started;
  const after = await browser.cpu();
  const prior = new Map(before.map((p) => [p.pid, p]));
  const extensions = after.filter((p) => p.type === 'extension');
  assert(
    extensions.length && extensions.every((p) => prior.has(p.pid)),
    'Extension process changed',
  );
  result.cpuMs = extensions.reduce(
    (sum, p) => sum + (p.cpuTimeNs - prior.get(p.pid).cpuTimeNs) / 1e6,
    0,
  );
  result.after = await identities();
  assert.deepEqual(result.after.identities, beforeIdentity.identities);
  assert.equal(result.after.nativeCount, count + 1);
  assert.deepEqual(result.after.nativeActive, beforeIdentity.nativeActive);
  assert.deepEqual(
    result.after.active.map((tab) => tab.id),
    result.after.nativeActive,
  );
  assert(result.after.active.every((tab) => Number.isFinite(tab.lastAccessed)));
  result.muted = await browser.frame(
    panel.browserId,
    async (ids) => {
      const windowId = (await browser.windows.getCurrent()).id;
      const response = await browser.runtime.sendMessage(
        clone({ type: 'tabernacle:snapshot', windowId }),
      );
      if (!response.ok) throw new Error(response.error);
      return Promise.all(
        ids.map(async (id) => ({
          id,
          native: (await browser.tabs.get(id)).mutedInfo.muted,
          sidebar: response.data.tabs.find((tab) => tab.id === id).mutedInfo?.muted,
        })),
      );
    },
    live,
  );
  assert(result.muted.every((tab) => tab.native === tab.sidebar));
  result.requests = Object.fromEntries(requests);
  assert.equal(requests.size, 3);
  assert(
    [...requests.values()].every((count) => count === 1),
    'A live page reloaded',
  );
  assert(await browser.noDebugger());
  result.status = 'completed';
} catch (error) {
  result.status = 'failed';
  result.error = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  emit('stage', { name: 'closing' });
  try {
    await browser.close();
  } catch (error) {
    result.cleanupError = error.stack;
    result.status = 'failed';
    process.exitCode = 1;
  }
  await new Promise((resolve) => server.close(resolve));
  emit('result', { result });
  console.log(JSON.stringify(result));
}
