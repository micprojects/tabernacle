import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY, TAB_KEY } from '../extension/src/model.js';
import { PENDING_MOVE_KEY } from '../extension/src/move-recovery.js';
import { memoryBrowser } from '../preview/browser.js';

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [
      { id: 'work', name: 'Work', parentId: null },
      { id: 'child', name: 'Child group', parentId: 'work' },
      { id: 'later', name: 'Later', parentId: null },
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, url: 'https://example.com/p', active: true },
      { id: 2, windowId: 1, index: 1, url: 'https://example.com/c', pinned: true },
      {
        id: 3,
        windowId: 1,
        index: 2,
        url: 'https://example.com/g',
        cookieStoreId: 'firefox-container-1',
      },
      { id: 4, windowId: 1, index: 3, url: 'https://example.com/home' },
    ],
    memberships: {
      1: { groupId: 'work', treeId: 'p', ancestors: [], order: 0 },
      2: { groupId: 'work', treeId: 'c', ancestors: ['p'], order: 1024 },
      3: { groupId: 'work', treeId: 'g', ancestors: ['c', 'p'], order: 2048 },
      4: { groupId: null, treeId: 'home', ancestors: [], order: 0 },
    },
  });
  let controller = createController(api);
  return {
    api,
    send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }),

    restart() {
      controller.dispose();
      controller = createController(api);
    },

    dispose: () => controller.dispose(),
  };
}

const move = (f, type = 'moveTab') =>
  f.send(type, { id: type === 'moveTab' ? 1 : 'work', groupId: 'later' });
const organisation = (state) => ({
  groups: state.groups,
  tabs: state.tabs
    .map(({ treeId, groupId, ancestors, order }) => ({ treeId, groupId, ancestors, order }))
    .sort((a, b) => a.treeId.localeCompare(b.treeId)),
});

for (const operation of ['read', 'repair']) {
  test(`a ${operation} failure for a live tab blocks deletion; confirmed closes are skipped`, async () => {
    for (const closed of [false, true]) {
      const f = fixture();
      const confirmed = await f.send('getGroupContents', { id: 'work' });
      if (operation === 'repair') delete f.api.testing.tabValues.get(2).order;
      f.restart();
      const method = operation === 'read' ? 'getTabValue' : 'setTabValue';
      const original = f.api.sessions[method];
      f.api.sessions[method] = async (id, ...args) => {
        if (id === 2) {
          if (closed) await f.api.tabs.remove(2);
          throw new Error('Session unavailable');
        }
        return original(id, ...args);
      };
      if (closed) {
        const state = await f.send('removeGroup', { id: 'work', ...confirmed });
        assert(!state.groups.some((g) => g.id === 'work'));
      } else {
        await assert.rejects(
          f.send('removeGroup', { id: 'work', ...confirmed }),
          /organisation.*Session unavailable/,
        );
        assert.equal((await f.api.tabs.query({})).length, 4);
        assert.equal(f.api.testing.saved[MODEL_KEY].groups.length, 3);
      }
      f.api.sessions[method] = original;
      await f.send('snapshot');
      f.dispose();
    }
  });
}

test('a failed native confirmation query never treats a live tab as closed', async () => {
  const f = fixture();
  const query = f.api.tabs.query;
  let queries = 0;
  f.api.tabs.query = async (...args) => {
    if (++queries > 1) throw new Error('Query unavailable');
    return query(...args);
  };
  f.api.sessions.getTabValue = async () => {
    throw new Error('Session unavailable');
  };
  await assert.rejects(f.send('getGroupContents', { id: 'work' }), /Query unavailable/);
  assert.equal((await query({})).length, 4);
  f.dispose();
});

test('snapshot failures settle migration writes before the next action', async () => {
  const f = fixture();
  delete f.api.testing.tabValues.get(1).order;
  let release, started;
  const held = new Promise((r) => {
    release = r;
  });
  const waiting = new Promise((r) => {
    started = r;
  });
  const save = f.api.sessions.setTabValue;
  f.api.sessions.setTabValue = async (...args) => {
    if (args[0] === 1) {
      started();
      await held;
    }
    return save(...args);
  };
  const getView = f.api.sessions.getWindowValue;
  f.api.sessions.getWindowValue = async () => {
    throw new Error('View unavailable');
  };
  let settled = false;
  const first = assert.rejects(f.send('snapshot'), /View unavailable/).then(() => {
    settled = true;
  });
  await waiting;
  f.api.sessions.getWindowValue = getView;
  const next = f.send('toggleTab', { id: 1 });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  release();
  await first;
  assert.equal((await next).tabs.find((t) => t.id === 1).collapsed, true);
  f.dispose();
});

test('transient initialization failures retry, and invalid saved data is never reset', async () => {
  for (const key of [MODEL_KEY, PENDING_MOVE_KEY]) {
    const f = fixture();
    const get = f.api.storage.local.get;
    let failed = false;
    f.api.storage.local.get = async (requested) => {
      if (requested === key && !failed) {
        failed = true;
        throw new Error('Temporary read failure');
      }
      return get(requested);
    };
    await assert.rejects(f.send('snapshot'), /Temporary read failure/);
    assert.equal((await f.send('snapshot')).groups.length, 3);
    let reads = 0;
    f.api.storage.local.get = async (...args) => {
      reads++;
      return get(...args);
    };
    await f.send('snapshot');
    assert.equal(reads, 0);
    f.dispose();
  }
  const f = fixture();
  f.api.testing.saved[MODEL_KEY].version = 999;
  const before = structuredClone(f.api.testing.saved);
  await assert.rejects(f.send('createGroup', { name: 'No' }), /newer version/);
  await assert.rejects(f.send('snapshot'), /newer version/);
  assert.deepEqual(f.api.testing.saved, before);
  f.dispose();
});

test('legacy saved fields stay opaque and removed actions cannot affect them', async () => {
  const f = fixture();
  const legacy = { malformedButPreserved: ['https://example.com/saved'] };
  f.api.testing.saved[MODEL_KEY].stashes = legacy;
  const state = await f.send('renameGroup', { id: 'work', name: 'Renamed' });
  assert.deepEqual(f.api.testing.saved[MODEL_KEY].stashes, legacy);
  for (const field of ['stashCount', 'deletedStashCount', 'stashRevision'])
    assert(!(field in state));
  for (const type of [
    'prepareStash',
    'stashGroup',
    'restoreStash',
    'searchStashes',
    'getStash',
    'deleteStash',
    'recoverStash',
    'forgetStash',
  ])
    await assert.rejects(f.send(type, { id: 'work' }), /Unknown/);
  f.restart();
  assert.equal((await f.send('snapshot')).groups[0].name, 'Renamed');
  assert.deepEqual(f.api.testing.saved[MODEL_KEY].stashes, legacy);
  f.dispose();
});

test('group creation retries retain one identity after view, storage and response failures', async () => {
  for (const failure of ['view', 'storage', 'response']) {
    const f = fixture();
    const id = crypto.randomUUID();
    const getView = f.api.sessions.getWindowValue;
    const setView = f.api.sessions.setWindowValue;
    const setModel = f.api.storage.local.set;
    let reads = 0;
    if (failure === 'view')
      f.api.sessions.setWindowValue = async () => {
        throw new Error('View save failed');
      };
    if (failure === 'storage')
      f.api.storage.local.set = async () => {
        throw new Error('Storage failed');
      };
    if (failure === 'response')
      f.api.sessions.getWindowValue = async (...args) => {
        if (++reads === 2) throw new Error('Response snapshot failed');
        return getView(...args);
      };
    await assert.rejects(f.send('createGroup', { id, name: 'New' }), /failed/);
    assert.equal(
      f.api.testing.saved[MODEL_KEY].groups.filter((g) => g.id === id).length,
      failure === 'response' ? 1 : 0,
    );
    f.api.sessions.getWindowValue = getView;
    f.api.sessions.setWindowValue = setView;
    f.api.storage.local.set = setModel;
    f.restart();
    const created = await f.send('createGroup', { id, name: 'New' });
    assert.equal(created.createdGroupId, id);
    await f.send('renameGroup', { id, name: 'Later edit' });
    const retry = await f.send('createGroup', { id, name: 'New' });
    assert.equal(retry.groups.filter((g) => g.id === id).length, 1);
    assert.equal(retry.groups.find((g) => g.id === id).name, 'Later edit');
    f.dispose();
  }
});

for (const type of ['moveTab', 'moveGroupContents']) {
  test(`${type} completes after interruption at every durable write, including changed native IDs`, async () => {
    const baseline = fixture();
    let count = 0;
    for (const [api, method] of [
      [baseline.api.storage.local, 'set'],
      [baseline.api.sessions, 'setTabValue'],
    ]) {
      const original = api[method];
      api[method] = async (...args) => {
        count++;
        return original(...args);
      };
    }
    const expected = organisation(await move(baseline, type));
    baseline.dispose();
    for (let at = 1; at <= count; at++) {
      const f = fixture();
      const originals = [];
      let writes = 0,
        stopped;
      const interrupted = new Promise((r) => {
        stopped = r;
      });
      for (const [api, method] of [
        [f.api.storage.local, 'set'],
        [f.api.sessions, 'setTabValue'],
      ]) {
        const original = api[method];
        originals.push(() => {
          api[method] = original;
        });
        api[method] = async (...args) => {
          const result = await original(...args);
          if (++writes === at) {
            stopped();
            return new Promise(() => {});
          }
          return result;
        };
      }
      void move(f, type);
      await interrupted;
      for (const restore of originals) restore();
      // Firefox gives restored tabs new numeric IDs but retains their values.
      await f.api.tabs.remove([1, 2, 3]);
      await f.api.sessions.restore();
      await f.api.sessions.restore();
      await f.api.sessions.restore();
      f.restart();
      const state = await f.send('snapshot');
      assert.deepEqual(organisation(state), expected, `write ${at}`);
      assert.equal(state.tabs.find((t) => t.treeId === 'c').pinned, true);
      assert.equal(state.tabs.find((t) => t.treeId === 'g').cookieStoreId, 'firefox-container-1');
      assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
      f.restart();
      assert.deepEqual(organisation(await f.send('snapshot')), expected);
      f.dispose();
    }
  });
}

for (const failure of ['rollback-direction', 'rollback-write', 'rollback-cleanup']) {
  test(`recovery survives ${failure} failure and blocks subsequent changes until resolved`, async () => {
    const f = fixture();
    const before = organisation(await f.send('snapshot'));
    const save = f.api.sessions.setTabValue;
    const store = f.api.storage.local.set;
    let calls = 0;
    f.api.sessions.setTabValue = async (...args) => {
      calls++;
      if (calls === 2 || (failure === 'rollback-write' && calls === 3))
        throw new Error('Membership failed');
      return save(...args);
    };
    f.api.storage.local.set = async (value) => {
      if (
        (failure === 'rollback-direction' && value[PENDING_MOVE_KEY]?.direction === 'before') ||
        (failure === 'rollback-cleanup' && value[PENDING_MOVE_KEY] === null)
      )
        throw new Error('Recovery save failed');
      return store(value);
    };
    await assert.rejects(move(f), /recovery record/);
    assert(f.api.testing.saved[PENDING_MOVE_KEY]);
    f.api.sessions.setTabValue = save;
    f.api.storage.local.set = store;
    f.restart();
    const result = await f.send('snapshot');
    if (failure === 'rollback-direction')
      assert(result.tabs.filter((t) => t.treeId !== 'home').every((t) => t.groupId === 'later'));
    else assert.deepEqual(organisation(result), before);
    assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
    f.dispose();
  });
}

test('cleanup failures never undo committed group moves or let another move replace the record', async () => {
  const f = fixture();
  const store = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (value[PENDING_MOVE_KEY] === null) throw new Error('Cleanup failed');
    return store(value);
  };
  await assert.rejects(move(f, 'moveGroupContents'), /Cleanup failed/);
  const saved = structuredClone(f.api.testing.saved);
  const memberships = structuredClone(f.api.testing.tabValues);
  await assert.rejects(f.send('moveTab', { id: 1, groupId: null }), /Cleanup failed/);
  assert.deepEqual(f.api.testing.saved, saved);
  assert.deepEqual(f.api.testing.tabValues, memberships);
  f.api.storage.local.set = store;
  f.restart();
  const state = await f.send('snapshot');
  assert.equal(state.groups.find((g) => g.id === 'child').parentId, 'later');
  assert.equal(state.tabs.find((t) => t.id === 1).groupId, 'later');
  assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
  f.dispose();
});

test('a failed group commit rolls back memberships and keeps the original hierarchy', async () => {
  const f = fixture();
  const before = organisation(await f.send('snapshot'));
  const store = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (value[MODEL_KEY]) throw new Error('Model failed');
    return store(value);
  };
  await assert.rejects(move(f, 'moveGroupContents'), /Model failed/);
  assert.deepEqual(organisation(await f.send('snapshot')), before);
  assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
  f.dispose();
});

test('recovery skips confirmed closed tabs and keeps their surviving descendants reachable', async () => {
  const f = fixture();
  const store = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (value[PENDING_MOVE_KEY] === null) throw new Error('Cleanup failed');
    return store(value);
  };
  await assert.rejects(move(f), /Cleanup failed/);
  await f.api.tabs.remove(2);
  f.api.storage.local.set = store;
  f.restart();
  const state = await f.send('snapshot');
  assert.equal(state.tabs.length, 3);
  assert.equal(
    state.tabs.find((t) => t.treeId === 'g').parentTabId,
    state.tabs.find((t) => t.treeId === 'p').id,
  );
  f.dispose();
});

test('single writes, no-ops and warm snapshots do not write recovery records', async () => {
  const f = fixture();
  await f.send('snapshot');
  let writes = 0;
  const store = f.api.storage.local.set;
  f.api.storage.local.set = async (...args) => {
    writes++;
    return store(...args);
  };
  await f.send('snapshot');
  await f.send('moveTab', { id: 4, groupId: 'later' });
  await f.send('moveTab', { id: 4, groupId: 'later', beforeId: 4 });
  await f.send('newTab', { groupId: 'later' });
  assert.equal(writes, 0);
  f.dispose();
});

test('new-tab memberships without a group or ancestry survive interrupted expansion recovery', async () => {
  const f = fixture();
  await f.send('toggleTab', { id: 1 });
  const store = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (value[PENDING_MOVE_KEY] === null) throw new Error('Cleanup failed');
    return store(value);
  };
  await assert.rejects(f.send('newChildTab', { id: 1 }), /Cleanup failed/);
  f.api.storage.local.set = store;
  f.restart();
  const state = await f.send('snapshot');
  assert.equal(state.tabs.at(-1).parentTabId, 1);
  assert.equal(state.tabs.find((t) => t.id === 1).collapsed, false);
  f.dispose();
});

for (const type of ['moveTab', 'moveGroupContents']) {
  test(`${type} survives process interruption during compensation`, async () => {
    const successful = fixture();
    const after = organisation(await move(successful, type));
    successful.dispose();
    // Journal, first tab write, rollback intent, compensation, journal cleanup.
    for (let at = 1; at <= 5; at++) {
      const f = fixture();
      const before = organisation(await f.send('snapshot'));
      let writes = 0,
        tabCalls = 0,
        stopped;
      const interrupted = new Promise((r) => {
        stopped = r;
      });

      const pause = () => {
        if (++writes === at) {
          stopped();
          return new Promise(() => {});
        }
      };

      const store = f.api.storage.local.set;
      const save = f.api.sessions.setTabValue;
      f.api.storage.local.set = async (...args) => {
        await store(...args);
        await pause();
      };
      f.api.sessions.setTabValue = async (...args) => {
        if (++tabCalls === 2) throw new Error('Membership failed');
        await save(...args);
        await pause();
      };
      void move(f, type).catch(() => {});
      await interrupted;
      const direction = f.api.testing.saved[PENDING_MOVE_KEY]?.direction;
      f.api.storage.local.set = store;
      f.api.sessions.setTabValue = save;
      f.restart();
      assert.deepEqual(
        organisation(await f.send('snapshot')),
        direction === 'after' ? after : before,
      );
      assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
      f.dispose();
    }
  });
}

test('invalid recovery records are retained without modifying memberships or groups', async () => {
  for (const groups of [
    { before: [null], after: [] },
    { before: [], after: [{ id: 'cycle', name: 'Cycle', parentId: 'cycle' }] },
  ]) {
    const f = fixture();
    f.api.testing.saved[PENDING_MOVE_KEY] = { version: 1, direction: 'after', changes: [], groups };
    const saved = structuredClone(f.api.testing.saved);
    const values = structuredClone(f.api.testing.tabValues);
    await assert.rejects(f.send('snapshot'), /pending move could not be read/);
    assert.deepEqual(f.api.testing.saved, saved);
    assert.deepEqual(f.api.testing.tabValues, values);
    f.dispose();
  }
});

test('live read failures during recovery retain the record and can retry', async () => {
  const f = fixture();
  const store = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (value[PENDING_MOVE_KEY] === null) throw new Error('Cleanup failed');
    return store(value);
  };
  await assert.rejects(move(f), /Cleanup failed/);
  f.api.storage.local.set = store;
  f.restart();
  const get = f.api.sessions.getTabValue;
  f.api.sessions.getTabValue = async (id, ...args) => {
    if (id === 1) throw new Error('Unavailable');
    return get(id, ...args);
  };
  await assert.rejects(f.send('snapshot'), /organisation.*Unavailable/);
  assert(f.api.testing.saved[PENDING_MOVE_KEY]);
  f.api.sessions.getTabValue = get;
  assert(
    (await f.send('snapshot')).tabs
      .filter((t) => t.treeId !== 'home')
      .every((t) => t.groupId === 'later'),
  );
  assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
  f.dispose();
});
