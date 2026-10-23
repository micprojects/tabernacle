import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import firefox from 'selenium-webdriver/firefox.js';
import { startFirefox } from './firefox-session.js';
import { previewServer } from './preview.js';
import { upgradeOrganisation } from '../test/helpers/upgrade-state.js';

// This checks a real same-ID update and extension reload. Temporary add-ons do
// not survive a whole Firefox restart; this suite makes no claim to cover that.
const run = promisify(execFile);
const addonId = 'tabernacle@michaelprojects.com';
const modelKey = 'tabernacle.model.v1';
const tabKey = 'tabernacle.membership.v1';
const viewKey = 'tabernacle.view.v1';
const moveKey = 'tabernacle.pending-move.v1';
const sentinelKey = 'tabernacle.upgrade-test-sentinel';
const releaseRef = 'v0.2.0';
const startedAt = new Date().toISOString();
const directory = resolve('test-results', 'memory', `upgrade-${startedAt.replaceAll(':', '-')}`);
const report = { startedAt, releaseRef, node: process.version, checks: [], passed: false };
let root, session, server, driver, uuid, probeHandle;

function checkpoint(message) {
  report.checks.push(message);
  console.log(`✓ ${message}`);
}

async function hashes(directory) {
  const result = {};

  async function visit(relative = '') {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else {
        assert(entry.isFile(), `Unexpected extension file type: ${path}`);
        result[path] = createHash('sha256')
          .update(await readFile(join(directory, path)))
          .digest('hex');
      }
    }
  }

  await visit();
  return result;
}

async function call(fn, ...args) {
  const result = await driver.executeAsyncScript(
    `const done=arguments[arguments.length-1];Promise.resolve().then(()=>(${fn.toString()})(...arguments[0])).then(value=>done({ok:true,value:value??null}),error=>done({ok:false,error:error.stack||error.message}));`,
    args,
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function send(type, args = {}) {
  return call(
    async (type, args) => {
      const windowId = (await browser.windows.getCurrent()).id;
      const response = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!response.ok) throw new Error(response.error);
      return response.data;
    },
    type,
    args,
  );
}

async function connect() {
  await driver.setContext(firefox.Context.CHROME);
  const currentUuid = await call(
    (id) => JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))[id],
    addonId,
  );
  if (uuid) assert.equal(currentUuid, uuid, 'The extension UUID must survive the update');
  uuid = currentUuid;
  await driver.setContext(firefox.Context.CONTENT);
  await driver.switchTo().window(probeHandle);
  // An internal page avoids creating a managed tab when reconnecting the driver.
  await driver.get(`moz-extension://${uuid}/settings.html`);
  await send('snapshot');
}

async function reload() {
  await driver.switchTo().window(probeHandle);
  await driver.get('about:blank');
  await driver.setContext(firefox.Context.CHROME);
  await call(async (id) => {
    const { AddonManager } = ChromeUtils.importESModule(
      'resource://gre/modules/AddonManager.sys.mjs',
    );
    await (await AddonManager.getAddonByID(id)).reload();
  }, addonId);
  await connect();
}

async function verifyInstalled(expected) {
  const installed = await call(async (paths) => {
    const result = {};
    for (const path of paths) {
      const response = await fetch(browser.runtime.getURL(path), { cache: 'reload' });
      if (!response.ok) throw new Error(`Cannot read installed resource: ${path}`);
      const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
      result[path] = [...new Uint8Array(digest)]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
    }
    return result;
  }, Object.keys(expected));
  assert.deepEqual(
    installed,
    expected,
    'The installed extension must contain the expected source bytes',
  );
}

async function capture(windowIds, treeIds) {
  const snapshots = [];
  for (const windowId of windowIds) snapshots.push(await send('snapshot', { windowId }));
  const raw = await call(
    async (keys, ids) => {
      const [modelKey, tabKey, viewKey, moveKey, sentinelKey] = keys;
      const storage = await browser.storage.local.get([modelKey, moveKey, sentinelKey]);
      const memberships = [];
      for (const tab of await browser.tabs.query({})) {
        const value = await browser.sessions.getTabValue(tab.id, tabKey);
        if (value?.treeId && ids.includes(value.treeId)) memberships.push({ id: tab.id, value });
      }
      const views = {};
      for (const win of await browser.windows.getAll())
        views[win.id] = (await browser.sessions.getWindowValue(win.id, viewKey)) ?? null;
      return {
        storage,
        memberships,
        views,
        containers: await browser.contextualIdentities.query({}),
      };
    },
    [modelKey, tabKey, viewKey, moveKey, sentinelKey],
    treeIds,
  );
  raw.memberships.sort((a, b) => a.id - b.id);
  raw.containers.sort((a, b) => a.cookieStoreId.localeCompare(b.cookieStoreId));
  return { organisation: upgradeOrganisation(snapshots, treeIds), raw, snapshots };
}

function preserved(before, after) {
  assert.deepEqual(after.organisation, before.organisation, 'Existing organisation must survive');
  assert.deepEqual(after.raw.memberships, before.raw.memberships, 'Saved tab values must survive');
  assert.deepEqual(after.raw.views, before.raw.views, 'Window views must survive');
  assert.deepEqual(after.raw.containers, before.raw.containers, 'Firefox containers must survive');
  assert.deepEqual(after.raw.storage[sentinelKey], before.raw.storage[sentinelKey]);
  assert.deepEqual(
    after.raw.storage[modelKey],
    before.raw.storage[modelKey],
    'Raw model must survive',
  );
}

async function interruptedMove(ids, groupId) {
  return call(
    async (ids, tabKey, moveKey, groupId) => {
      const changes = [];
      for (const id of ids) {
        const before = await browser.sessions.getTabValue(id, tabKey);
        changes.push({ treeId: before.treeId, before, after: { ...before, groupId } });
      }
      // The journal and first membership were durable when the background died.
      await browser.storage.local.set({
        [moveKey]: { version: 1, direction: 'after', changes, groups: null },
      });
      await browser.sessions.setTabValue(ids[0], tabKey, changes[0].after);
      return changes;
    },
    ids,
    tabKey,
    moveKey,
    groupId,
  );
}

function completedMove(before, changes, treeIds) {
  const expected = structuredClone(before);
  for (const change of changes) {
    const record = expected.raw.memberships.find(({ value }) => value.treeId === change.treeId);
    record.value = structuredClone(change.after);
    for (const state of expected.snapshots) {
      const tab = state.tabs.find((tab) => tab.treeId === change.treeId);
      if (tab) tab.groupId = change.after.groupId;
    }
  }
  expected.organisation = upgradeOrganisation(expected.snapshots, treeIds);
  return expected;
}

try {
  console.log('Preparing published-source upgrade fixture…');
  await mkdir(directory, { recursive: true });
  root = await mkdtemp(join(tmpdir(), 'tabernacle-upgrade-'));
  report.releaseCommit = (await run('git', ['rev-parse', `${releaseRef}^{commit}`])).stdout.trim();
  report.candidateCommit = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  report.workingTree = (await run('git', ['status', '--short'])).stdout.trim();
  const archive = join(root, 'release.tar');
  await run('git', [
    'archive',
    '--format=tar',
    '--output',
    archive,
    report.releaseCommit,
    'extension',
  ]);
  await run('tar', ['-xf', archive, '-C', root]);
  const released = join(root, 'extension');
  const candidate = join(root, 'candidate');
  const initialHashes = await hashes(resolve('extension'));
  await cp(resolve('extension'), candidate, { recursive: true });
  report.releaseHashes = await hashes(released);
  report.candidateHashes = await hashes(candidate);
  assert.deepEqual(
    report.candidateHashes,
    initialHashes,
    'Candidate changed during fixture copying',
  );
  const releaseManifest = JSON.parse(await readFile(join(released, 'manifest.json'), 'utf8'));
  const candidateManifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'));
  assert.equal(releaseManifest.browser_specific_settings.gecko.id, addonId);
  assert.equal(candidateManifest.browser_specific_settings.gecko.id, addonId);
  report.versions = { released: releaseManifest.version, candidate: candidateManifest.version };
  assert.equal(
    candidateManifest.version,
    releaseManifest.version,
    'This fixture checks a same-version update',
  );
  checkpoint('release and candidate source fingerprints captured');
  server = await previewServer(0);
  const url = `http://127.0.0.1:${server.address().port}/preview/index.html`;
  session = await startFirefox();
  driver = session.driver;
  report.firefox = session.version;
  report.profile = session.profile;
  checkpoint(`isolated Firefox ${session.version} profile verified`);
  await driver.manage().setTimeouts({ script: 30000, pageLoad: 30000 });
  probeHandle = await driver.getWindowHandle();
  assert.equal(await driver.installAddon(released, true), addonId);
  await connect();
  await verifyInstalled(report.releaseHashes);
  checkpoint('installed release bytes match the published tag');
  const firstWindow = await call(async () => (await browser.windows.getCurrent()).id);
  const container = (
    await send('createContainer', { name: 'Upgrade work', color: 'purple', icon: 'briefcase' })
  ).createdCookieStoreId;
  const work = (
    await send('createGroup', {
      name: 'Work',
      cookieStoreId: container,
      appearance: { icon: 'briefcase', color: 'purple' },
    })
  ).createdGroupId;
  const nested = (await send('createGroup', { name: 'Research', parentId: work })).createdGroupId;
  const destination = (
    await send('createGroup', { name: 'Regular', cookieStoreId: 'firefox-default' })
  ).createdGroupId;
  const second = await call(async (url) => browser.windows.create({ url, focused: false }), url);
  const windowIds = [firstWindow, second.id];
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const tab = await call(
      async (windowId, url, index, store) =>
        browser.tabs.create({
          windowId,
          url: `${url}?upgrade=${index}`,
          title: `Upgrade ${index}`,
          active: false,
          discarded: true,
          cookieStoreId: store,
        }),
      i < 6 ? firstWindow : second.id,
      url,
      i,
      i % 2 ? 'firefox-default' : container,
    );
    ids.push(tab.id);
    await send('moveTab', { id: tab.id, groupId: i === 3 ? null : nested, windowId: tab.windowId });
  }
  await send('nestTab', { id: ids[1], parentTabId: ids[0] });
  await send('nestTab', { id: ids[2], parentTabId: ids[1] });
  await send('nestTab', { id: ids[5], parentTabId: ids[4] });
  await send('toggleTab', { id: ids[0] });
  await send('pinTab', { id: ids[3] });
  await send('pinTab', { id: ids[7], windowId: second.id });
  await send('muteTab', { id: ids[3] });
  await send('setGroupPin', { id: work, action: 'open' });
  await send('setGroupPin', { id: nested, action: 'reveal' });
  await send('enterGroup', { id: work });
  await send('enterGroup', { id: nested, windowId: second.id });
  await send('toggleGroup', { id: nested });
  await send('toggleGroup', { id: work, windowId: second.id });
  await send('setLook', {
    value: {
      colorScheme: 'dark',
      connectingLines: true,
      domains: true,
      folderCounts: true,
      animations: false,
      tintFavicons: true,
    },
  });
  const all = (await capture(windowIds, [])).snapshots.flatMap((state) => state.tabs);
  const treeIds = ids.map((id) => all.find((tab) => tab.id === id).treeId);
  const delayed = all.find((tab) => tab.id === ids[4]);
  const delayedValue = await call(
    async (id, key) => browser.sessions.getTabValue(id, key),
    delayed.id,
    tabKey,
  );
  await call(async (id) => browser.tabs.remove(id), delayed.id);
  const closed = await call(
    async (url) =>
      (await browser.sessions.getRecentlyClosed()).find((entry) => entry.tab?.url === url)?.tab,
    delayed.url,
  );
  assert(closed?.sessionId, 'The release must leave a native restorable tab');
  const sentinel = {
    token: `upgrade-${startedAt}`,
    opaque: { version: 99, values: ['untouched', { data: true }] },
  };
  await call(
    async (modelKey, sentinelKey, value) => {
      const model = (await browser.storage.local.get(modelKey))[modelKey];
      model.stashes = value.opaque;
      model.upgradeOpaque = value.opaque;
      await browser.storage.local.set({ [modelKey]: model, [sentinelKey]: value });
    },
    modelKey,
    sentinelKey,
    sentinel,
  );
  await reload();
  const before = await capture(windowIds, treeIds);
  assert.deepEqual(before.raw.storage[modelKey].upgradeOpaque, sentinel.opaque);
  checkpoint('published-source fixture, distinct window views and opaque storage created');
  const upgradeChanges = await interruptedMove(ids.slice(0, 3), destination);
  const expectedUpgrade = completedMove(before, upgradeChanges, treeIds);
  console.log('Replacing the published extension with the candidate while a move is pending…');
  await driver.get('about:blank');
  assert.equal(await driver.installAddon(candidate, true), addonId);
  await connect();
  await verifyInstalled(report.candidateHashes);
  const upgraded = await capture(windowIds, treeIds);
  preserved(expectedUpgrade, upgraded);
  assert.equal(upgraded.raw.storage[moveKey], null);
  checkpoint(
    'same-ID same-version update completes the pending move and preserves unrelated state',
  );
  await reload();
  preserved(upgraded, await capture(windowIds, treeIds));
  checkpoint('candidate extension reload preserves organisation');
  // Restore only after the candidate has fully initialised and reloaded. The
  // new native ID must reconnect to the waiting child's durable ancestry.
  const restoreStartedAt = Date.now();
  const restored = await call(async (id) => browser.sessions.restore(id), closed.sessionId);
  assert(restored.tab && restored.tab.id !== delayed.id);
  await driver.switchTo().window(probeHandle);
  // sessions.restore can resolve while the replacement still shows about:blank.
  // Capture the preserved state only after both native and controller views have
  // the known fixture URL; never omit URL preservation from the later comparison.
  await driver.wait(
    () =>
      call(
        async (id, url) => {
          const tab = await browser.tabs.get(id);
          if (tab.url !== url || tab.status !== 'complete') return false;
          const response = await browser.runtime.sendMessage({
            type: 'tabernacle:snapshot',
            windowId: tab.windowId,
          });
          if (!response.ok) throw new Error(response.error);
          return response.data.tabs.find((item) => item.id === id)?.url === url;
        },
        restored.tab.id,
        delayed.url,
      ),
    15000,
    'Restored fixture URL did not settle in native and controller state',
  );
  const afterRestore = await capture(windowIds, treeIds);
  const restoredTab = afterRestore.snapshots
    .flatMap((state) => state.tabs)
    .find((tab) => tab.treeId === delayed.treeId);
  assert.equal(restoredTab.id, restored.tab.id);
  assert.equal(restoredTab.cookieStoreId, delayed.cookieStoreId);
  const restoredValue = afterRestore.raw.memberships.find(({ id }) => id === restored.tab.id).value;
  // v0.2.0 predates openedAt. Current creation handling records an observed
  // restore when that field was absent; every existing field must remain exact.
  const expectedRestoredValue = { ...delayedValue };
  if (!Object.hasOwn(delayedValue, 'openedAt')) {
    assert(Number.isFinite(restoredValue.openedAt));
    assert(restoredValue.openedAt >= restoreStartedAt && restoredValue.openedAt <= Date.now());
    expectedRestoredValue.openedAt = restoredValue.openedAt;
  }
  assert.deepEqual(restoredValue, expectedRestoredValue);
  assert.equal(
    afterRestore.snapshots[0].tabs.find((tab) => tab.id === ids[5]).parentTabId,
    restored.tab.id,
  );
  checkpoint('delayed native restore keeps membership and reconnects ancestry');
  await send('renameGroup', { id: destination, name: 'Regular renamed' });
  const beforeRecovery = await capture(windowIds, treeIds);
  assert.deepEqual(beforeRecovery.raw.storage[modelKey].upgradeOpaque, sentinel.opaque);
  assert.deepEqual(beforeRecovery.raw.storage[modelKey].stashes, sentinel.opaque);
  const changes = await interruptedMove(ids.slice(0, 3), nested);
  console.log('Reloading the candidate after another interrupted move…');
  await reload();
  const recovered = await capture(windowIds, treeIds);
  preserved(completedMove(beforeRecovery, changes, treeIds), recovered);
  for (const change of changes) {
    const record = recovered.raw.memberships.find(({ value }) => value.treeId === change.treeId);
    assert.deepEqual(record.value, change.after);
  }
  for (const record of beforeRecovery.raw.memberships)
    if (!changes.some((change) => change.treeId === record.value.treeId))
      assert.deepEqual(
        recovered.raw.memberships.find(({ id }) => id === record.id),
        record,
      );
  assert.equal(recovered.raw.storage[moveKey], null);
  assert.deepEqual(recovered.raw.storage[modelKey], beforeRecovery.raw.storage[modelKey]);
  assert.deepEqual(recovered.raw.storage[sentinelKey], sentinel);
  await reload();
  preserved(recovered, await capture(windowIds, treeIds));
  checkpoint('interrupted move completes after reload and subsequent retry is stable');
  assert.deepEqual(
    await hashes(resolve('extension')),
    initialHashes,
    'Working extension changed during the test',
  );
  report.passed = true;
  console.log(
    'Firefox upgrade checks passed: published source → same-version candidate, delayed restore and recovery.',
  );
} catch (error) {
  report.error = error.stack || error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Upgrade evidence: ${join(directory, 'results.json')}`);
  } finally {
    try {
      await session?.close();
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
}
