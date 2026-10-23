import { sourceFile } from '../instrumentation/source.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ScreenshotBrowser } from '../screenshot-browser.js';
import { performanceFixture } from '../../preview/performance-fixture.js';
import { fingerprintSource, machineInfo, percentile } from './common.js';
import {
  expectedSidebar,
  sidebarMatches,
  waitForStableObservation,
  sidebarTargets,
  evaluateSidebarTarget,
  observeSidebar,
  measureSettledNative,
  snapshotMatchesNative,
} from './native-settlement.js';

export async function fingerprintNativeHarness() {
  const files = [
    '../benchmark-memory-firefox.js',
    '../instrumentation/source.js',
    '../screenshot-browser.js',
    '../../preview/performance-fixture.js',
    './native.js',
    './native-settlement.js',
    './common.js',
    './guard.js',
    './preflight.js',
    './summary.js',
  ];
  const hash = createHash('sha256');
  for (const file of files) {
    const bytes = await readFile(new URL(file, import.meta.url));
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return { version: 2, sha256: hash.digest('hex'), files };
}

// Actual Firefox process reports, collected in the disposable browser's chrome.
// Reported process memory and OS RSS are separate metrics; do not add them.
export async function nativeMemory(browser, minimize = false) {
  return browser.chrome(async (minimize) => {
    const reports = await new Promise((resolve, reject) => {
      const totals = {};
      const timeout = setTimeout(
        () => reject(new Error('Firefox memory reporters did not finish within 30 seconds.')),
        30000,
      );
      const manager = Cc['@mozilla.org/memory-reporter-manager;1'].getService(
        Ci.nsIMemoryReporterManager,
      );
      manager.getReportsExtended(
        (process, path, _kind, units, amount) => {
          const key = process || 'Main process';
          const entry = (totals[key] ??= {
            explicitBytes: 0,
            selectedDomStyleBytes: 0,
            selectedImageBytes: 0,
            orphanDomBytes: null,
          });
          if (units === 0 && amount >= 0) {
            if (path.startsWith('explicit/')) entry.explicitBytes += amount;
            if (path.startsWith('explicit/') && /\/(dom|style)\//.test(path))
              entry.selectedDomStyleBytes += amount;
            if (path.startsWith('explicit/') && /\/(images|image)\//.test(path))
              entry.selectedImageBytes += amount;
            if (path.startsWith('explicit/') && path.endsWith('/dom/orphan-nodes'))
              entry.orphanDomBytes = (entry.orphanDomBytes ?? 0) + amount;
            if (
              [
                'resident',
                'resident-unique',
                'resident-phys-footprint',
                'heap-allocated',
                'js-main-runtime-gc-heap',
              ].includes(path)
            )
              entry[path] = amount;
          }
          if (path === 'ghost-windows') entry.ghostWindows = amount;
        },
        null,
        () => {
          clearTimeout(timeout);
          resolve(totals);
        },
        null,
        true,
        minimize,
        '',
      );
    });
    if (!Object.values(reports).some((report) => Number.isFinite(report.resident)))
      throw new Error('Firefox memory reporters returned no resident-memory sample.');
    const info = await ChromeUtils.requestProcInfo();
    const processes = [info, ...(info.children || [])].map(({ pid, type, memory }) => ({
      pid,
      type,
      reportedBytes: memory,
    }));
    return {
      minimized: minimize,
      processes,
      reports,
      processMetric: 'ChromeUtils.requestProcInfo.memory, sampled after memory reporters finish',
      categoryNote:
        'Selected DOM/style and image reporters are partial diagnostic categories, not complete ownership totals. Orphan DOM bytes sum explicit orphan-node reporters only. Absent optional reporters are unavailable, not zero.',
    };
  }, minimize);
}

async function attachCommands(browser) {
  await browser.chrome(async () => {
    await window.tabernacleScreenshotCommands?.destroy();
    const { require } = ChromeUtils.importESModule(
      'resource://devtools/shared/loader/Loader.sys.mjs',
    );
    const { CommandsFactory } = require('devtools/shared/commands/commands-factory');
    window.tabernacleScreenshotCommands = await CommandsFactory.forAddon(
      'tabernacle@michaelprojects.com',
    );
    await window.tabernacleScreenshotCommands.targetCommand.startListening();
  });
}

async function showSidebars(browser, command) {
  await browser.chrome(async (command) => {
    for (const win of Services.wm.getEnumerator('navigator:browser'))
      await win.SidebarController.show(command);
  }, command);
  await waitForStableObservation(() => sidebarTargets(browser), {
    matches: (targets) =>
      targets.length > 0 &&
      targets.every((target) => target.target && target.open && !target.hidden),
    label: 'all actual Firefox sidebars opening',
  });
}

async function reload(browser, command) {
  await browser.chrome(async () => {
    await window.tabernacleScreenshotCommands?.destroy();
    window.tabernacleScreenshotCommands = null;
    const { AddonManager } = ChromeUtils.importESModule(
      'resource://gre/modules/AddonManager.sys.mjs',
    );
    await (await AddonManager.getAddonByID('tabernacle@michaelprojects.com')).reload();
  });
  await showSidebars(browser, command);
  await attachCommands(browser);
}

const fixtureDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runNative(options, logPath) {
  const source = await fingerprintSource(options.sourceRoot);
  const fixture = performanceFixture(options);
  const browser = new ScreenshotBrowser();
  const phases = [];
  let created = 0;
  let interrupted = false;
  const previousCwd = process.cwd();
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><title>Memory fixture 0</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E"><script>let n=0;const timer=setInterval(()=>{document.title="Memory fixture "+ ++n;if(n===6)clearInterval(timer)},100)</script>',
    );
  });

  const stop = () => {
    interrupted = true;
    browser.close().catch(() => {});
  };

  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const progress = (value) => process.send?.({ type: 'progress', ...value });

  const stage = async (name, work) => {
    process.send?.({ type: 'stage', name, created });
    const start = performance.now();
    const value = await work();
    const phase = { name, elapsedMs: performance.now() - start, ...(value || {}) };
    phases.push(phase);
    process.send?.({ type: 'phase', phase });
    return value;
  };

  const state = (windowId) =>
    browser.evaluate(async (windowId) => {
      const response = await browser.runtime.sendMessage({ type: 'tabernacle:snapshot', windowId });
      if (!response.ok) throw new Error(response.error);
      return {
        tabs: response.data.tabs.length,
        revision: response.data.revision,
        groups: response.data.groups.length,
      };
    }, windowId);
  const { createTreeIndex } = await import(
    pathToFileURL(await sourceFile(options.sourceRoot, 'treeIndex'))
  );
  // Published v0.2.0 predates tab-collection.js. Its source index still owns
  // query matching; the expectation helper traverses that index directly.
  const collectionPath = resolve(options.sourceRoot, 'extension/src/tab-collection.js');
  const hasCollections = await access(collectionPath).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  const { searchTabOrder } = hasCollections ? await import(pathToFileURL(collectionPath)) : {};
  const expectedNativeIds = new Map();

  const settle = async (requiredSearch = null, requiredVisibility = null) => {
    const targets = await sidebarTargets(browser);
    assert.equal(targets.length, windowIds?.length || 1, 'Unexpected native window count.');
    assert(
      targets.every((target) => target.target && target.open && !target.hidden),
      'An actual Firefox sidebar is absent or closed.',
    );
    assert.equal(
      new Set(targets.map((target) => target.target)).size,
      targets.length,
      'Duplicate actual sidebar target IDs.',
    );
    const expected = new Map();
    const observedWindows = new Set();
    for (const target of targets) {
      const authority = await waitForStableObservation(
        () =>
          evaluateSidebarTarget(browser, target.target, async () => {
            const windowId = (await browser.windows.getCurrent()).id;
            const response = await browser.runtime.sendMessage({
              type: 'tabernacle:snapshot',
              windowId,
            });
            if (!response.ok) throw new Error(response.error);
            return {
              windowId,
              snapshot: response.data,
              nativeTabs: (await browser.tabs.query({ windowId })).map(
                ({ id, title, windowId }) => ({ id, title, windowId }),
              ),
              query: document.getElementById('search')?.value || '',
              uri: document.documentURI,
              expectedUri: browser.runtime.getURL('sidebar.html'),
            };
          }),
        {
          matches: (data) => snapshotMatchesNative(data.snapshot, data.nativeTabs, data.windowId),
          stableSamples: 1,
          timeoutMs: 30000,
          label: 'snapshot metadata catching up to native tabs',
          progress: (value) => progress({ name: 'settle-native-metadata', ...value }),
        },
      );
      const data = authority.observation;
      assert.equal(
        data.uri,
        data.expectedUri,
        'Target is not this add-on’s actual sidebar document.',
      );
      assert(data.expectedUri, 'Sidebar target did not report its extension URL.');
      assert(
        !observedWindows.has(data.windowId),
        'Multiple targets resolved to the same native window.',
      );
      observedWindows.add(data.windowId);
      const nativeIds = data.nativeTabs.map((tab) => tab.id).sort((a, b) => a - b);
      assert.deepEqual(
        data.snapshot.tabs.map((tab) => tab.id).sort((a, b) => a - b),
        nativeIds,
        'Snapshot does not cover every native tab.',
      );
      if (expectedNativeIds.has(data.windowId))
        assert.deepEqual(
          nativeIds,
          [...expectedNativeIds.get(data.windowId)].sort((a, b) => a - b),
          'Native tabs do not match the complete owned fixture.',
        );
      expected.set(target.target, {
        windowId: data.windowId,
        nativeTabs: nativeIds.length,
        query: data.query,
        ...(requiredVisibility?.windowId === data.windowId
          ? { visibility: requiredVisibility.values }
          : {}),
        ...expectedSidebar(
          data.snapshot,
          createTreeIndex(data.snapshot, data.query.trim().toLowerCase()),
          searchTabOrder,
          data.query,
        ),
      });
      if (requiredSearch && data.windowId === requiredSearch.windowId) {
        assert.equal(
          data.query,
          requiredSearch.query,
          'Search query did not reach its intended window.',
        );
        assert(
          expected.get(target.target).rows.some((row) => row.id === requiredSearch.tabId),
          'The intended offscreen search target is absent from authoritative results.',
        );
      }
      progress({ name: 'settle-sidebar-authority', windowId: data.windowId });
    }

    if (windowIds)
      assert.deepEqual(
        [...observedWindows].sort((a, b) => a - b),
        [...windowIds].sort((a, b) => a - b),
        'Sidebar targets do not cover every owned native window.',
      );

    const read = async () => {
      const current = await sidebarTargets(browser);
      const sidebars = [];
      for (const target of current) {
        if (!expected.has(target.target)) continue;
        sidebars.push({
          target: target.target,
          minimised: target.minimised,
          ...(await evaluateSidebarTarget(browser, target.target, observeSidebar)),
        });
        progress({ name: 'settle-sidebar-dom', windowId: expected.get(target.target).windowId });
      }
      return { targets: current, sidebars };
    };

    const matches = (observation) =>
      observation.targets.length === targets.length &&
      observation.targets.every(
        (target) => target.target && target.open && !target.hidden && expected.has(target.target),
      ) &&
      observation.sidebars.length === targets.length &&
      observation.sidebars.every((sidebar) =>
        sidebarMatches(sidebar, expected.get(sidebar.target)),
      );
    const result = await waitForStableObservation(read, {
      matches,
      timeoutMs: 30000,
      label: 'all actual sidebar IDs, order, titles and pins',
      progress: (value) => progress({ name: 'settle-sidebar-stability', ...value }),
    });
    const compact = (observation) =>
      observation.sidebars.map((sidebar) => {
        const { rows, pins, ...counts } = sidebar;
        const authority = expected.get(sidebar.target);
        return {
          ...counts,
          windowId: authority.windowId,
          nativeTabs: authority.nativeTabs,
          expectedTabRows: authority.rows.length,
          expectedPins: authority.pins.length,
          rowsSha256: fixtureDigest(rows),
          pinsSha256: fixtureDigest(pins),
        };
      });
    return {
      summary: {
        samples: result.samples,
        stableSamples: result.stableSamples,
        elapsedMs: result.elapsedMs,
        sidebars: compact(result.observation),
      },
      read,
      matches,
      compact,
    };
  };

  const measure = (visibility = null) =>
    measureSettledNative(
      () => settle(null, visibility),
      (minimize) => nativeMemory(browser, minimize),
    );
  let environment, command, windowIds, containerIds;
  const nativeIds = new Map();
  const report = {
    version: 1,
    kind: 'native-firefox',
    status: 'running',
    source,
    harness: await fingerprintNativeHarness(),
    fixture: {
      tabs: options.tabs,
      windows: options.windows,
      seed: fixture.seed,
      sha256: fixtureDigest({ tabs: fixture.tabs, memberships: [...fixture.memberships] }),
    },
    environment: machineInfo(),
    phases,
    limitations: [
      'Only a newly created isolated profile is used.',
      'DevTools attachment can affect MV3 event-page lifetime; addon reload checks restart behavior, not natural background sleep.',
      'Protocol byte estimates cover explicit measured requests; actual sidebar rendering is measured separately.',
      'The native fixture includes one about:blank control tab per window in addition to the requested discarded fixture tabs.',
      'Every settled memory sample verifies all actual sidebar IDs, order, titles and pins against authoritative snapshots, plus stable timer-separated DOM observations. Startup/guard peaks are separate from settled samples.',
    ],
  };
  try {
    process.chdir(options.sourceRoot);
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    environment = await stage('launch', async () =>
      browser.open(
        {
          window: { width: 1100, height: 850 },
          sidebarWidth: 330,
          capture: { sourceSize: { width: 330, height: 720 } },
        },
        logPath,
      ),
    );
    report.environment.firefox = environment.firefox;
    report.profile = environment.profile;
    command = await browser.chrome(() =>
      document.getElementById('sidebar-box').getAttribute('sidebarcommand'),
    );
    assert(command, 'The actual Firefox sidebar command is unavailable.');
    await stage('empty-sidebar', measure);
    const setup = await stage('windows-containers', async () =>
      browser.evaluate(
        async (count, containers) => {
          const windows = [(await browser.windows.getCurrent()).id];
          for (let i = 1; i < count; i++)
            windows.push((await browser.windows.create({ url: 'about:blank', focused: false })).id);
          const stores = {};
          for (const container of containers)
            stores[container.cookieStoreId] = (
              await browser.contextualIdentities.create({
                name: container.name,
                icon: container.icon,
                color: container.color,
              })
            ).cookieStoreId;
          const native = await Promise.all(
            windows.map(async (windowId) => [
              windowId,
              (await browser.tabs.query({ windowId })).map((tab) => tab.id),
            ]),
          );
          return { windows, stores, native };
        },
        options.windows,
        fixture.containers,
      ),
    );
    windowIds = setup.windows;
    containerIds = setup.stores;
    for (const [windowId, ids] of setup.native) expectedNativeIds.set(windowId, new Set(ids));
    await stage('create-discarded-tabs', async () => {
      for (let offset = 0; offset < fixture.tabs.length; offset += 25) {
        const rows = fixture.tabs.slice(offset, offset + 25).map((tab) => ({
          fixtureId: tab.id,
          windowId: windowIds[tab.windowId - 1],
          url: tab.url,
          title: tab.title,
          pinned: tab.pinned,
          cookieStoreId: containerIds[tab.cookieStoreId] || 'firefox-default',
        }));
        const ids = await browser.evaluate(
          async (rows) =>
            Promise.all(
              rows.map(async ({ fixtureId, pinned, ...tab }) => {
                // Firefox rejects pinned+discarded creation. Pin the already
                // discarded tab afterwards without navigating its fixture URL.
                const created = await browser.tabs.create({
                  ...tab,
                  discarded: true,
                  active: false,
                });
                if (pinned) await browser.tabs.update(created.id, { pinned: true });
                if (!(await browser.tabs.get(created.id)).discarded)
                  throw new Error('Fixture tab unexpectedly loaded while being created or pinned.');
                return { fixtureId, id: created.id };
              }),
            ),
          rows,
        );
        for (const { fixtureId, id } of ids) {
          nativeIds.set(fixtureId, id);
          expectedNativeIds.get(windowIds[fixture.tabs[fixtureId - 1].windowId - 1]).add(id);
        }
        created += ids.length;
        progress({ name: 'create-discarded-tabs', created, total: options.tabs });
      }
      // A snapshot is a queue barrier: all earlier onCreated placements finish
      // before fixture session values are written directly and the addon reloads.
      for (const windowId of windowIds) {
        await state(windowId);
        progress({ name: 'settle-created-tabs', windowId });
      }
      return { created };
    });
    await stage('seed-memberships', async () => {
      await browser.evaluate(
        async (groups, windowIds) => {
          await browser.storage.local.set({ 'tabernacle.model.v1': { version: 1, groups } });
          for (const id of windowIds)
            await browser.sessions.setWindowValue(id, 'tabernacle.view.v1', {
              scopeId: null,
              collapsed: [],
            });
        },
        fixture.groups,
        windowIds,
      );
      const values = [...fixture.memberships];
      for (let offset = 0; offset < values.length; offset += 32) {
        const rows = values
          .slice(offset, offset + 32)
          .map(([id, value]) => [nativeIds.get(id), value]);
        await browser.evaluate(
          async (rows) =>
            Promise.all(
              rows.map(([id, value]) =>
                browser.sessions.setTabValue(id, 'tabernacle.membership.v1', value),
              ),
            ).then(() => true),
          rows,
        );
        progress({ name: 'seed-memberships', saved: Math.min(offset + 32, values.length) });
      }
      await reload(browser, command);
      for (const windowId of windowIds) await state(windowId);
      return { created, ...(await measure()) };
    });
    await stage('warm-snapshots', async () => {
      const samples = await browser.evaluate(async (windowId) => {
        let token;
        const results = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          const result = await browser.runtime.sendMessage({
            type: 'tabernacle:snapshot',
            windowId,
            incremental: true,
            snapshotToken: token,
          });
          if (!result.ok) throw new Error(result.error);
          token = result.data.token;
          results.push({
            ms: performance.now() - start,
            bytes: new TextEncoder().encode(JSON.stringify(result)).length,
            delta: Boolean(result.data.baseToken),
          });
        }
        return results;
      }, windowIds[0]);
      return {
        samples,
        p95Ms: percentile(
          samples.map((sample) => sample.ms),
          0.95,
        ),
        ...(await measure()),
      };
    });
    await stage('search-and-clear', async () => {
      const searchable = fixture.tabs.findLast(
        (tab) =>
          tab.windowId === 1 && !tab.pinned && !fixture.memberships.get(tab.id).savedForLaterAt,
      );
      assert(searchable, 'Search diagnostic needs an unpinned, unsaved fixture tab.');
      await browser.evaluate(() => document.getElementById('search-toggle').click());
      const samples = [];
      for (const query of [searchable.title, 'Fixture', '']) {
        const start = performance.now();
        await browser.evaluate((query) => {
          const input = document.getElementById('search');
          input.value = query;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, query);
        const settled = await settle(
          query ? { windowId: windowIds[0], query, tabId: nativeIds.get(searchable.id) } : null,
        );
        samples.push({ query, ms: performance.now() - start, settled: settled.summary });
      }
      return { samples };
    });
    await stage('live-title-burst', async () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      const ids = await browser.evaluate(
        async (url, windowId) =>
          Promise.all(
            Array.from(
              { length: 4 },
              async (_, i) =>
                (await browser.tabs.create({ windowId, url: `${url}${i}`, active: false })).id,
            ),
          ),
        url,
        windowIds[0],
      );
      for (const id of ids) expectedNativeIds.get(windowIds[0]).add(id);
      await browser.driver.wait(
        () =>
          browser.evaluate(
            async (ids) =>
              (await Promise.all(ids.map((id) => browser.tabs.get(id)))).every(
                (tab) => tab.title === 'Memory fixture 6',
              ),
            ids,
          ),
        15000,
      );
      const result = await measure();
      await browser.evaluate(async (ids) => {
        await browser.tabs.remove(ids);
        return true;
      }, ids);
      for (const id of ids) expectedNativeIds.get(windowIds[0]).delete(id);
      await state(windowIds[0]);
      await settle();
      return result;
    });
    await stage('visible-unfocused', async () => {
      if (windowIds.length < 2)
        return { supported: false, reason: 'Requires two fixture windows.' };
      await browser.evaluate(async (windowId) => {
        await browser.windows.update(windowId, { focused: true });
        return true;
      }, windowIds[1]);
      try {
        const observed = await waitForStableObservation(
          () =>
            browser.evaluate(() => ({
              visibilityState: document.visibilityState,
              hidden: document.hidden,
              focused: document.hasFocus(),
            })),
          {
            matches: (value) =>
              value.visibilityState === 'visible' && !value.hidden && !value.focused,
            label: 'visible unfocused actual sidebar',
          },
        );
        return {
          observation: observed.observation,
          supported: true,
          ...(await measure({
            windowId: windowIds[0],
            values: { visibilityState: 'visible', hidden: false, focused: false },
          })),
        };
      } finally {
        await browser.evaluate(async (windowId) => {
          await browser.windows.update(windowId, { focused: true });
          return true;
        }, windowIds[0]);
      }
    });
    await stage('minimised-window', async () => {
      await browser.chrome(() => window.minimize());
      try {
        let transition;
        try {
          transition = await waitForStableObservation(
            async () => ({
              minimised: await browser.chrome(() => window.windowState === window.STATE_MINIMIZED),
              ...(await browser.evaluate(() => ({
                visibilityState: document.visibilityState,
                hidden: document.hidden,
                focused: document.hasFocus(),
              }))),
            }),
            {
              matches: (value) => value.minimised && value.hidden,
              timeoutMs: 5000,
              label: 'minimised actual sidebar visibility',
            },
          );
        } catch (error) {
          if (!error.observation) throw error;
          return {
            supported: false,
            reason:
              'Firefox did not establish a stable minimised, hidden sidebar within 5 seconds; no memory sample was taken.',
            observation: error.observation,
          };
        }
        return {
          observation: transition.observation,
          supported: true,
          minimised: true,
          ...(await measure({ windowId: windowIds[0], values: { minimised: true, hidden: true } })),
        };
      } finally {
        await browser.chrome(() => window.restore());
        await waitForStableObservation(
          () => browser.evaluate(() => ({ hidden: document.hidden })),
          { matches: (value) => !value.hidden, label: 'restored actual sidebar visibility' },
        );
      }
    });
    await stage('sidebars-closed', async () => {
      await browser.chrome(() => {
        for (const win of Services.wm.getEnumerator('navigator:browser'))
          win.SidebarController.hide();
      });
      const closed = await waitForStableObservation(() => sidebarTargets(browser), {
        matches: (targets) =>
          targets.length === windowIds.length &&
          targets.every((target) => !target.open && (target.hidden || !target.target)),
        label: 'all actual sidebars closed',
        progress: (value) => progress({ name: 'settle-sidebars-closed', ...value }),
      });
      const beforeCollection = await nativeMemory(browser);
      const afterCollection = await nativeMemory(browser, true);
      const after = await sidebarTargets(browser);
      assert(
        after.length === windowIds.length &&
          after.every((target) => !target.open && (target.hidden || !target.target)),
        'A sidebar reopened while closed-view memory reporters ran.',
      );
      return { settled: closed, beforeCollection, afterCollection, sidebars: after };
    });
    await stage('sidebars-reopened', async () => {
      await showSidebars(browser, command);
      return measure();
    });
    await stage('addon-reload', async () => {
      await reload(browser, command);
      for (const windowId of windowIds) {
        await state(windowId);
        progress({ name: 'reload-snapshot', windowId });
      }
      for (let offset = 0; offset < fixture.tabs.length; offset += 32) {
        const expected = fixture.tabs
          .slice(offset, offset + 32)
          .map((tab) => [nativeIds.get(tab.id), fixture.memberships.get(tab.id)]);
        const actual = await browser.evaluate(
          async (ids) =>
            Promise.all(
              ids.map(async (id) => [
                id,
                await browser.sessions.getTabValue(id, 'tabernacle.membership.v1'),
              ]),
            ),
          expected.map(([id]) => id),
        );
        assert.deepEqual(
          actual,
          expected,
          'Fixture memberships changed across native lifetime operations.',
        );
        progress({ name: 'verify-memberships', verified: Math.min(offset + 32, options.tabs) });
      }
      return { preservedMemberships: true, ...(await measure()) };
    });
    assert.equal(
      (await fingerprintSource(options.sourceRoot)).sha256,
      source.sha256,
      'Source changed during native measurement.',
    );
    report.harnessAfter = await fingerprintNativeHarness();
    assert.equal(
      report.harnessAfter.sha256,
      report.harness.sha256,
      'Native diagnostic harness changed during measurement.',
    );
    report.status = 'completed';
  } catch (error) {
    report.status = interrupted ? 'aborted' : 'failed';
    report.error = error.stack;
    if (error.observation) report.failedObservation = error.observation;
  } finally {
    report.created = created;
    progress({ name: 'teardown-browser' });
    await browser.close();
    progress({ name: 'teardown-server' });
    await new Promise((done) => server.close(done));
    progress({ name: 'teardown-complete' });
    process.chdir(previousCwd);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
  return report;
}
