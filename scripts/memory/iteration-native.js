import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FrameBrowser } from './frame-browser.js';
import { nativeMemory } from './native.js';
import { fingerprintSource, machineInfo } from './common.js';
import {
  expectedSidebar,
  observeSidebar,
  sidebarMatches,
  snapshotMatchesNative,
  waitForStableObservation,
} from './native-settlement.js';

const [sourceRoot, tabsText, windowsText] = process.argv.slice(2),
  tabs = Number(tabsText),
  windowCount = Number(windowsText);
const browser = new FrameBrowser(),
  source = await fingerprintSource(sourceRoot);
const { createTreeIndex } = await import(
  pathToFileURL(resolve(sourceRoot, 'extension/src/tree-index.js'))
);
let searchTabOrder;
try {
  ({ searchTabOrder } = await import(
    pathToFileURL(resolve(sourceRoot, 'extension/src/tab-collection.js'))
  ));
} catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (type, data = {}) => process.send?.({ type, ...data });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report = {
  kind: 'optimisation-native',
  status: 'running',
  source,
  environment: machineInfo(),
  fixture: {
    tabs,
    windows: windowCount,
    seed: 17,
    shape: 'existing unorganised discarded tabs, then common folder operations',
    control:
      'One fixed extension control page, no background script/timers. Keeps the shared extension process alive while Tabernacle is disabled.',
  },
  phases: [],
};
let nativeWindows,
  created = [],
  firstPanel,
  identities;

const cpuDelta = (before, after) => {
  const byPid = new Map(before.map((p) => [p.pid, p]));
  const missing = before.filter((p) => !after.some((q) => q.pid === p.pid));
  const deltas = after.map((p) => ({
    ...p,
    deltaMs: (p.cpuTimeNs - (byPid.get(p.pid)?.cpuTimeNs || 0)) / 1e6,
  }));
  return {
    extensionMs: deltas.filter((p) => p.type === 'extension').reduce((a, p) => a + p.deltaMs, 0),
    totalMs: deltas.reduce((a, p) => a + p.deltaMs, 0),
    exitedPids: missing.map((p) => p.pid),
    note: 'Cumulative process CPU time; exited processes may make the whole-browser total a lower bound.',
  };
};

async function phase(name, work, { memory = false } = {}) {
  emit('stage', { name });
  const before = await browser.cpu();
  const start = performance.now();
  const value = await work();
  const elapsedMs = performance.now() - start;
  const after = await browser.cpu();
  const result = { name, elapsedMs, cpu: cpuDelta(before, after), ...value };
  if (memory) {
    assert(await browser.noDebugger(), 'DevTools must not be attached');
    result.beforeCollection = await nativeMemory(browser, false);
    result.afterCollection = await nativeMemory(browser, true);
    if (value.sidebars) {
      const after = await settle();
      assert.deepEqual(
        after.sidebars.map((s) => [s.windowId, s.rowsHash, s.pins, s.nativeTabs]),
        value.sidebars.map((s) => [s.windowId, s.rowsHash, s.pins, s.nativeTabs]),
        'Sidebar content changed during memory collection',
      );
      result.verifiedAfterCollection = true;
    }
  }
  report.phases.push(result);
  emit('phase', { phase: result });
  return result;
}

async function authority(panel) {
  return browser.frame(panel, async () => {
    const windowId = (await browser.windows.getCurrent()).id;
    const response = await browser.runtime.sendMessage(
      clone({ type: 'tabernacle:snapshot', windowId }),
    );
    if (!response.ok) throw new Error(response.error);
    return {
      windowId,
      snapshot: response.data,
      nativeTabs: (await browser.tabs.query(clone({ windowId }))).map(
        ({ id, title, windowId }) => ({ id, title, windowId }),
      ),
      query: document.getElementById('search')?.value || '',
      uri: document.documentURI,
    };
  });
}

async function settle() {
  const panelsResult = await waitForStableObservation(() => browser.panels(), {
    matches: (panels) =>
      panels.length === windowCount &&
      panels.every((p) => p.isTarget && p.open && !p.hidden && !p.watched),
    timeoutMs: 30000,
    stableSamples: 1,
    label: 'all real sidebars',
  });
  const panels = panelsResult.observation,
    expected = new Map();
  firstPanel = panels[0].browserId;
  for (const panel of panels) {
    const { observation: data } = await waitForStableObservation(() => authority(panel.browserId), {
      matches: (data) => snapshotMatchesNative(data.snapshot, data.nativeTabs, data.windowId),
      timeoutMs: 30000,
      stableSamples: 1,
      label: 'authoritative native data',
    });
    expected.set(panel.browserId, {
      windowId: data.windowId,
      query: data.query,
      nativeCount: data.nativeTabs.length,
      ...expectedSidebar(
        data.snapshot,
        createTreeIndex(data.snapshot, data.query.trim().toLowerCase()),
        searchTabOrder,
        data.query,
      ),
    });
  }

  const read = async () => {
    const out = [];
    for (const panel of panels) {
      const value = await browser.frame(panel.browserId, observeSidebar, { traverse: true });
      out.push({ browserId: panel.browserId, ...value });
    }
    return out;
  };

  let settled;
  try {
    settled = await waitForStableObservation(read, {
      matches: (rows) => rows.every((row) => sidebarMatches(row, expected.get(row.browserId))),
      timeoutMs: 30000,
      stableSamples: 3,
      label: 'complete sidebar IDs/order/titles/pins',

      progress: (value) => {
        if (value.samples % 5 === 0) emit('progress', { name: 'settle', samples: value.samples });
      },
    });
  } catch (error) {
    error.expected = [...expected];
    throw error;
  }
  return {
    sidebars: settled.observation.map((row) => ({
      browserId: row.browserId,
      windowId: expected.get(row.browserId).windowId,
      rows: row.rows.length,
      pins: row.pins.length,
      elements: row.elements,
      mountedRows: row.tabRows,
      images: row.images,
      hidden: row.hidden,
      focused: row.focused,
      nativeTabs: expected.get(row.browserId).nativeCount,
      rowsHash: digest(row.rows),
    })),
    samples: settled.samples,
  };
}

async function send(type, args = {}) {
  return browser.frame(
    firstPanel,
    async (type, args) => {
      const windowId = (await browser.windows.getCurrent()).id;
      const response = await browser.runtime.sendMessage(
        clone({ type: 'tabernacle:' + type, windowId, ...args }),
      );
      if (!response.ok) throw new Error(response.error);
      return response.data;
    },
    type,
    args,
  );
}

async function identitiesNow() {
  const out = [];
  for (const p of await browser.panels()) {
    const data = await authority(p.browserId);
    out.push(
      ...data.snapshot.tabs.map(({ id, treeId, groupId, ancestors, order }) => ({
        id,
        treeId,
        groupId,
        ancestors,
        order,
      })),
    );
  }
  return out.sort((a, b) => a.id - b.id);
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(
    '<!doctype html><title>Memory update 0</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E"><script>let i=0;const t=setInterval(()=>{document.title="Memory update "+ ++i;if(i===6)clearInterval(t)},100)</script>',
  );
});
let closing = false;
process.once('SIGTERM', () => {
  closing = true;
  browser.close().catch(() => {});
});
try {
  report.environment = { ...report.environment, ...(await browser.open()) };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  nativeWindows = await browser.control(async (count) => {
    const ids = [(await browser.windows.getCurrent()).id];
    for (let i = 1; i < count; i++)
      ids.push((await browser.windows.create({ url: 'about:blank', focused: false })).id);
    return ids;
  }, windowCount);
  emit('stage', { name: 'create-existing-tabs' });
  for (let offset = 0; offset < tabs; offset += 25) {
    const rows = Array.from({ length: Math.min(25, tabs - offset) }, (_, j) => {
      const id = offset + j + 1;
      return {
        windowId: nativeWindows[(id - 1) % windowCount],
        url: `https://fixture-${(id + 17) % 23}.invalid/page/${id}?fixture=17`,
        title: `Fixture 17: tab ${String(id).padStart(6, '0')}`,
        active: false,
        discarded: true,
      };
    });
    const ids = await browser.control(async (rows) => {
      const result = await Promise.all(rows.map((row) => browser.tabs.create(row)));
      if (result.some((tab) => !tab.discarded))
        throw new Error('A fixture tab unexpectedly loaded');
      return result.map(({ id }) => id);
    }, rows);
    created.push(...ids);
    emit('progress', { name: 'created', created: created.length });
  }
  assert.equal(created.length, tabs);
  report.fixture.sha256 = digest({
    version: 1,
    tabs,
    windows: windowCount,
    seed: 17,
    livePages: 1,
    cycles: 3,
    idleMs: 1500,
  });
  await phase(
    'disabled-before',
    async () => {
      await wait(1500);
      const processes = await browser.cpu();
      assert(processes.some((p) => p.type === 'extension'));
      emit('extension-processes', {
        pids: processes.filter((p) => p.type === 'extension').map((p) => p.pid),
      });
      return { nativeCount: (await browser.control(() => browser.tabs.query({}))).length };
    },
    { memory: true },
  );
  await phase(
    'enabled-initial',
    async () => {
      await browser.install(sourceRoot);
      await browser.show();
      return await settle();
    },
    { memory: false },
  );
  await phase(
    'enabled-idle',
    async () => {
      await wait(1500);
      return await settle();
    },
    { memory: true },
  );
  identities = await identitiesNow();
  assert.equal(identities.length, tabs + windowCount);
  await phase('warm-snapshots', async () => {
    const windows = [];
    for (const p of await browser.panels())
      windows.push(
        await browser.frame(p.browserId, async () => {
          const windowId = (await browser.windows.getCurrent()).id;
          const samples = [];
          for (let reader = 0; reader < 2; reader++) {
            let token;
            for (let round = 0; round < 5; round++) {
              const start = performance.now();
              const response = await browser.runtime.sendMessage(
                clone({
                  type: 'tabernacle:snapshot',
                  windowId,
                  incremental: true,
                  snapshotToken: token,
                }),
              );
              if (!response.ok) throw new Error(response.error);
              token = response.data.token;
              samples.push({
                reader,
                round,
                ms: performance.now() - start,
                bytes: new TextEncoder().encode(JSON.stringify(response)).length,
                delta: !!response.data.baseToken,
              });
            }
          }
          return { windowId, samples };
        }),
      );
    return { windows, ...(await settle()) };
  });
  await phase('search', async () => {
    const samples = [];
    for (const query of ['000007', 'Fixture', '']) {
      const start = performance.now();
      const response = await browser.frame(
        firstPanel,
        async (query) => {
          const input = document.getElementById('search');
          const start = performance.now();
          input.value = query;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          // The input handler queues rendering in the first animation frame.
          // Measure the following frame separately from exhaustive correctness
          // traversal and the benchmark's stability-observation floor.
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
          document.getElementById('tree').getBoundingClientRect();
          const renderFrameMs = performance.now() - start;
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
          return { renderFrameMs, nextFrameMs: performance.now() - start };
        },
        query,
      );
      const settled = await settle();
      samples.push({ query, ms: performance.now() - start, response, settled });
    }
    return { samples };
  });
  await phase('title-burst', async () => {
    const ids = await browser.control(
      async (url, windowId) => {
        const ids = [];
        for (let i = 0; i < 1; i++)
          ids.push((await browser.tabs.create({ windowId, url: url + i, active: false })).id);
        return ids;
      },
      `http://127.0.0.1:${server.address().port}/`,
      nativeWindows[0],
    );
    await waitForStableObservation(
      () =>
        browser.control(
          async (ids) =>
            (await Promise.all(ids.map((id) => browser.tabs.get(id)))).map((tab) => tab.title),
          ids,
        ),
      {
        matches: (titles) => titles.every((t) => t === 'Memory update 6'),
        timeoutMs: 15000,
        stableSamples: 1,
        label: 'native title events',
      },
    );
    const settled = await settle();
    await browser.control(async (ids) => {
      await browser.tabs.remove(ids);
    }, ids);
    await settle();
    return { livePages: 1, titleChanges: 6, settled };
  });
  await phase('folder-actions', async () => {
    const state = await send('snapshot');
    const targets = state.tabs.filter((tab) => created.includes(tab.id)).slice(0, 8);
    assert(targets.length >= 3);
    const group = (await send('createGroup', { name: 'Benchmark folder' })).createdGroupId;
    const times = [];
    for (const tab of targets) {
      const start = performance.now();
      await send('moveTab', { id: tab.id, groupId: group });
      times.push({ action: 'move', ms: performance.now() - start });
    }
    await send('nestTab', { id: targets[1].id, parentTabId: targets[0].id });
    await send('enterGroup', { id: null });
    await settle();
    for (let i = 0; i < 1; i++)
      for (const action of ['collapse', 'expand']) {
        const start = performance.now();
        await send('toggleGroup', { id: group });
        const settled = await settle();
        times.push({
          action,
          ms: performance.now() - start,
          rows: settled.sidebars.map((s) => s.rows),
        });
      }
    return { actions: times, group, ...(await settle()) };
  });
  identities = await identitiesNow();
  await phase(
    'sidebars-closed',
    async () => {
      await browser.hide();
      await wait(1500);
      assert((await browser.panels()).every((p) => !p.open));
      return { closed: true };
    },
    { memory: true },
  );
  await phase('sidebars-reopened', async () => {
    await browser.show();
    return await settle();
  });
  await phase(
    'view-cycles',
    async () => {
      for (let i = 0; i < 3; i++) {
        await browser.hide();
        await wait(150);
        await browser.show();
        await settle();
        emit('progress', { name: 'view-cycle', cycle: i + 1 });
      }
      return await settle();
    },
    { memory: true },
  );
  assert.deepEqual(await identitiesNow(), identities, 'Organisation changed across view cycles');
  await phase(
    'disabled-final',
    async () => {
      await browser.toggle(false);
      await wait(1500);
      assert((await browser.panels()).every((p) => !p.isTarget || !p.open));
      assert.equal(
        (await browser.control(() => browser.tabs.query({}))).length,
        tabs + windowCount,
      );
      return { disabled: true, preservedNativeCount: tabs + windowCount };
    },
    { memory: true },
  );
  assert.equal((await fingerprintSource(sourceRoot)).sha256, source.sha256);
  report.status = 'completed';
} catch (error) {
  report.status = closing ? 'inconclusive' : 'failed';
  report.error = String(error) + '\n' + error.stack;
  report.errorObservation = error.observation;
  report.expected = error.expected;
  process.exitCode = 1;
} finally {
  emit('closing');
  try {
    await browser.close();
  } catch (error) {
    report.cleanupError = String(error);
    report.status = closing ? 'inconclusive' : 'failed';
    process.exitCode = 1;
  }
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve, reject) =>
    process.send
      ? process.send({ type: 'result', result: report }, (error) =>
          error ? reject(error) : resolve(),
        )
      : resolve(),
  );
  process.disconnect?.();
}
