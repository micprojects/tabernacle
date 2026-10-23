import test from 'node:test';
import assert from 'node:assert/strict';
import { mapSettledBounded } from '../extension/src/bounded-settled.js';
import { createController } from '../extension/src/controller.js';
import { performanceFixture, performanceBrowser } from '../preview/performance-fixture.js';

test('bounded workers preserve input order and settle all items after failures', async () => {
  const items = Array.from({ length: 105 }, (_, i) => i);
  let active = 0;
  let peak = 0;
  const completed = [];
  const results = await mapSettledBounded(items, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(setImmediate);
    active--;
    completed.push(item);
    if (item % 13 === 0) throw new Error(`Failed ${item}`);
    return item * 2;
  });
  assert.equal(peak, 32);
  assert.equal(active, 0);
  assert.equal(completed.length, items.length);
  for (const [index, result] of results.entries()) {
    if (index % 13 === 0) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.message, `Failed ${index}`);
    } else assert.deepEqual(result, { status: 'fulfilled', value: index * 2 });
  }
  assert.deepEqual(await mapSettledBounded([], () => assert.fail()), []);
  await assert.rejects(
    mapSettledBounded(items, () => {}, 0),
    /positive integer/,
  );
});

test('controller cold reads are bounded and warm snapshots perform no membership reads', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 1000, windows: 2 }));
  const controller = createController(f.api);
  try {
    const first = await controller.request({ type: 'snapshot', windowId: 1 });
    assert.equal(first.tabs.length, 500);
    assert.equal(f.stats().reads, 1000);
    assert.equal(f.stats().peakReads, 32);
    f.resetStats();
    assert.deepEqual(await controller.request({ type: 'snapshot', windowId: 1 }), first);
    assert.equal(f.stats().reads, 0);
  } finally {
    controller.dispose();
  }
});

test('a failed read waits for every worker before the controller queue advances', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 1 }));
  const controller = createController(f.api);
  const get = f.api.sessions.getTabValue;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const seen = new Set();
  f.api.sessions.getTabValue = async (id, key) => {
    seen.add(id);
    if (id === 1) throw new Error('Read unavailable');
    if (id === 100) {
      started();
      await held;
    }
    return get(id, key);
  };
  try {
    let failed = false;
    const first = assert
      .rejects(controller.request({ type: 'snapshot', windowId: 1 }), /Read unavailable/)
      .then(() => {
        failed = true;
      });
    await waiting;
    let advanced = false;
    const second = controller.request({ type: 'snapshot', windowId: 1 }).then(() => {
      advanced = true;
    });
    await new Promise(setImmediate);
    assert.equal(failed, false);
    assert.equal(advanced, false);
    assert.equal(seen.size, 100);
    f.api.sessions.getTabValue = get;
    release();
    await first;
    await second;
    assert.equal(advanced, true);
  } finally {
    release();
    controller.dispose();
  }
});

test('closing a tab during a bounded read is confirmed without losing surviving records', async () => {
  const f = performanceBrowser(performanceFixture({ tabs: 100, windows: 1 }));
  const controller = createController(f.api);
  const get = f.api.sessions.getTabValue;
  let removed = false;
  f.api.sessions.getTabValue = async (id, key) => {
    if (id === 50 && !removed) {
      removed = true;
      await f.api.tabs.remove(id);
    }
    return get(id, key);
  };
  try {
    const state = await controller.request({ type: 'snapshot', windowId: 1 });
    assert.equal(state.tabs.length, 99);
    assert.equal(
      state.tabs.some((tab) => tab.id === 50),
      false,
    );
    assert.equal(new Set(state.tabs.map((tab) => tab.treeId)).size, 99);
    assert(f.stats().peakReads <= 32);
  } finally {
    controller.dispose();
  }
});
