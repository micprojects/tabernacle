import assert from 'node:assert/strict';
import { exec, percentile } from './common.js';
import { waitForStableObservation } from './native-settlement.js';

export async function waitForIdleMemory(
  sample,
  policy,
  {
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    progress = () => {},
  } = {},
) {
  const started = now(),
    samples = [];
  while (true) {
    const rssBytes = await sample();
    assert(Number.isFinite(rssBytes) && rssBytes > 0, 'Missing idle RSS sample');
    const elapsedMs = now() - started;
    samples.push({ elapsedMs, rssBytes });
    progress({ elapsedMs, rssBytes });
    const start = samples.findLastIndex((s) => s.elapsedMs <= elapsedMs - policy.stableMs);
    const recent = samples.slice(Math.max(0, start));
    const values = recent.map((s) => s.rssBytes);
    const range = Math.max(...values) - Math.min(...values);
    if (
      elapsedMs >= policy.minQuietMs &&
      recent.at(-1).elapsedMs - recent[0].elapsedMs >= policy.stableMs &&
      range <= Math.max(policy.stableBytes, Math.min(...values) * policy.stableRatio)
    )
      return { elapsedMs, samples, rangeBytes: range, residentBytes: percentile(values, 0.5) };
    if (elapsedMs >= policy.maxQuietMs) {
      const error = new Error(
        'Idle resident memory did not settle within its bounded quiet period.',
      );
      error.code = 'IDLE_NOT_SETTLED';
      error.observation = { elapsedMs, samples };
      throw error;
    }
    await wait(Math.min(policy.sampleMs, policy.maxQuietMs - elapsedMs));
  }
}

// Ten folders per branch, all populated: a root, two children and seven
// grandchildren. Assignment is per window so every sidebar shows every folder.
export function idleFixture(tabs, folders, windows) {
  assert(Number.isInteger(folders) && folders >= 10 && folders % 10 === 0);
  assert(Number.isInteger(windows) && windows > 0);
  assert(Number.isInteger(tabs) && tabs >= folders * windows && tabs % windows === 0);
  const groups = Array.from({ length: folders }, (_, i) => ({
    id: `idle-folder-${i}`,
    name: `Folder ${i + 1}`,
    parentId:
      i % 10 === 0
        ? null
        : `idle-folder-${i - (i % 10) + ([1, 6].includes(i % 10) ? 0 : i % 10 < 6 ? 1 : 6)}`,
  }));
  const memberships = Array.from({ length: tabs }, (_, i) => ({
    treeId: `idle-tab-${i}`,
    groupId: groups[Math.floor(i / windows) % folders].id,
    order: Math.floor(i / windows) * 1024,
    ancestors: [],
    collapsed: false,
  }));
  return { groups, memberships };
}

export function verifyIdleSnapshot(snapshot, fixture, ids, windowIndex, windows) {
  assert(Number.isInteger(windowIndex) && windowIndex >= 0 && windowIndex < windows);
  assert.deepEqual(
    snapshot.groups.map(({ id, parentId }) => ({ id, parentId })),
    fixture.groups.map(({ id, parentId }) => ({ id, parentId })),
    'Idle folder hierarchy differs from the seeded fixture',
  );
  assert.equal(snapshot.view.scopeId, null);
  assert.deepEqual(snapshot.view.collapsed, [], 'Every idle folder must be expanded');
  const byId = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  for (let i = windowIndex; i < ids.length; i += windows) {
    const tab = byId.get(ids[i]);
    assert(tab, 'Missing idle fixture tab');
    for (const key of ['treeId', 'groupId', 'order', 'ancestors', 'collapsed'])
      assert.deepEqual(tab[key], fixture.memberships[i][key], `Idle membership differs: ${key}`);
    assert.equal(tab.discarded, true, 'Idle fixture pages must remain unloaded');
  }
  assert.equal(byId.size, ids.length / windows + 1, 'Unexpected idle native tab count');
}

export async function runIdleFixture({
  browser,
  sourceRoot,
  tabs,
  folders,
  windows,
  created,
  nativeWindows,
  settle,
  authority,
  phase,
  emit,
  policy,
}) {
  const fixture = idleFixture(tabs, folders, windows);
  emit('stage', { name: 'seed-idle-folders' });
  await browser.install(sourceRoot);
  await browser.show();
  // A snapshot is a queue barrier before writing an isolated fixture. The
  // temporary, unorganised tree is not the measured workload: traverse and
  // verify the complete populated tree after reloading the seeded state.
  const { observation: panels } = await waitForStableObservation(() => browser.panels(), {
    matches: (panels) => panels.length === windows && panels.every((p) => p.isTarget && p.open),
    stableSamples: 1,
    timeoutMs: 30000,
    label: 'idle fixture sidebars',
  });
  for (const panel of panels) await authority(panel.browserId);
  const panel = panels[0].browserId;
  await browser.frame(
    panel,
    async (groups, windowIds) => {
      await browser.storage.local.set(clone({ 'tabernacle.model.v1': { version: 1, groups } }));
      for (const id of windowIds)
        await browser.sessions.setWindowValue(
          id,
          'tabernacle.view.v1',
          clone({ scopeId: null, collapsed: [] }),
        );
    },
    fixture.groups,
    nativeWindows,
  );
  for (let offset = 0; offset < tabs; offset += 32) {
    await browser.frame(
      panel,
      async (rows) => {
        await Promise.all(
          rows.map(([id, value]) =>
            browser.sessions.setTabValue(id, 'tabernacle.membership.v1', value),
          ),
        );
      },
      created.slice(offset, offset + 32).map((id, j) => [id, fixture.memberships[offset + j]]),
    );
    emit('progress', { name: 'seed-idle-folders', saved: Math.min(tabs, offset + 32) });
  }
  await browser.toggle(false);
  const nativeIds = async () =>
    (await browser.control(async () => (await browser.tabs.query({})).map(({ id }) => id))).sort(
      (a, b) => a - b,
    );
  const originalIds = await nativeIds();
  assert.equal(originalIds.length, tabs + windows);

  async function disabled() {
    assert((await browser.panels()).every((p) => !p.isTarget || !p.open));
    assert.deepEqual(await nativeIds(), originalIds, 'Disabling changed native tabs');
  }

  async function verify() {
    for (const panel of await browser.panels()) {
      const { snapshot, windowId } = await authority(panel.browserId);
      verifyIdleSnapshot(snapshot, fixture, created, nativeWindows.indexOf(windowId), windows);
    }
  }

  async function quiet(name, state = {}) {
    // All authority/DOM verification finishes BEFORE the quiet period. Memory
    // reporters run after it, with no forced GC/CC anywhere in this worker.
    return phase(
      name,
      async () => {
        const idle = await waitForIdleMemory(
          async () => {
            const { stdout } = await exec('/bin/ps', ['-o', 'rss=', '-p', String(pid)]);
            return Number(stdout.trim()) * 1024;
          },
          policy,
          { progress: (value) => emit('progress', { name, ...value }) },
        );
        return { ...state, idle };
      },
      { memory: 'unforced' },
    );
  }

  await disabled();
  const processes = await browser.cpu();
  const pids = processes.filter((p) => p.type === 'extension').map((p) => p.pid);
  assert.equal(pids.length, 1, 'Idle attribution requires one shared extension process');
  const [pid] = pids;
  emit('extension-processes', { pids });
  emit('stage', { name: 'open-idle-folders' });
  await browser.toggle(true);
  await browser.show();
  const settled = await settle();
  await verify();
  await quiet('enabled-idle', settled);
  await verify();
  emit('stage', { name: 'disable-idle-folders' });
  await browser.toggle(false);
  await disabled();
  await quiet('disabled-final');
  await disabled();
}
