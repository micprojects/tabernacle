import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { resolveMove, moveSource } from '../extension/src/move-plan.js';
import { memoryBrowser } from '../preview/browser.js';
import { PENDING_MOVE_KEY } from '../extension/src/move-recovery.js';
import { MODEL_KEY } from '../extension/src/model.js';

function fixture() {
  const api = memoryBrowser({
    events: true,
    groups: [{ id: 'work', parentId: null, name: 'Work' }],
    tabs: [
      { id: 1, windowId: 1, index: 0, title: 'Parent', pinned: true, active: true },
      { id: 2, windowId: 1, index: 1, title: 'Child', cookieStoreId: 'firefox-container-1' },
      { id: 3, windowId: 1, index: 2, title: 'Other', pinned: true },
    ],
    memberships: {
      1: { groupId: null, treeId: 'a', ancestors: [], order: 0 },
      2: { groupId: null, treeId: 'b', ancestors: ['a'], order: 0 },
      3: { groupId: null, treeId: 'c', ancestors: [], order: 1024 },
    },
  });
  let controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  return {
    api,
    send,

    restart() {
      controller.dispose();
      controller = createController(api);
    },

    async message(id, destination) {
      const state = await send('snapshot');
      const source = moveSource(state, 'tab', id);
      return {
        operationId: crypto.randomUUID(),
        source,
        destination,
        expected: resolveMove(state, source, destination).expected,
      };
    },
  };
}

test('unpin and move preserves the entire subtree, active page and container', async () => {
  const f = fixture();
  const message = await f.message(1, { kind: 'group', id: 'work' });
  const state = await f.send('moveItem', message);
  assert(state.moveResult.committed);
  assert.equal(state.tabs[0].pinned, false);
  assert.equal(state.tabs.find((tab) => tab.active).id, 1);
  assert.deepEqual(
    state.tabs.slice(0, 2).map((tab) => tab.groupId),
    ['work', 'work'],
  );
  assert.equal(state.tabs.find((tab) => tab.id === 2).parentTabId, 1);
  assert.equal(state.tabs.find((tab) => tab.id === 2).cookieStoreId, 'firefox-container-1');
});

test('pinning changes only the root and respects the mixed insertion slot', async () => {
  const f = fixture();
  await f.send('pinTab', { id: 1 });
  await f.send('setGroupPin', { id: 'work', action: 'open' });
  const before = await f.send('snapshot');
  const after = await f.send(
    'moveItem',
    await f.message(1, { kind: 'pins', before: { kind: 'tab', id: 'c' } }),
  );
  assert.deepEqual(
    after.pins.map((pin) => pin.id),
    ['a', 'c', 'work'],
  );
  assert.deepEqual(
    after.tabs.find((tab) => tab.id === 2),
    before.tabs.find((tab) => tab.id === 2),
  );
});

test('stale placements fail before unpinning or changing memberships', async () => {
  const f = fixture();
  const message = await f.message(1, { kind: 'group', id: 'work' });
  await f.send('moveTab', { id: 2, groupId: 'work' });
  await assert.rejects(f.send('moveItem', message), /source or destination has moved/);
  assert.equal((await f.send('snapshot')).tabs.find((tab) => tab.id === 1).pinned, true);
});

test('a native unpin failure rolls back memberships without losing the branch', async () => {
  const f = fixture();
  const message = await f.message(1, { kind: 'group', id: 'work' });
  const update = f.api.tabs.update;
  f.api.tabs.update = async (id, value) => {
    if (value.pinned === false) throw new Error('Unpin refused');
    return update(id, value);
  };
  await assert.rejects(f.send('moveItem', message), /Unpin refused/);
  const state = await f.send('snapshot');
  assert.deepEqual(
    state.tabs.map((tab) => tab.groupId),
    [null, null, null],
  );
  assert.equal(state.tabs.find((tab) => tab.id === 2).parentTabId, 1);
  assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
});

test('completion receipts survive restart and prevent a repeated move', async () => {
  const f = fixture();
  const message = await f.message(1, { kind: 'group', id: 'work' });
  await f.send('moveItem', message);
  f.restart();
  await f.send('moveTab', { id: 1, groupId: null });
  const repeated = await f.send('moveItem', message);
  assert(repeated.moveResult.committed);
  assert.equal(repeated.tabs.find((tab) => tab.id === 1).groupId, null);
});

test('a committed move survives failed cleanup and restart with its receipt', async () => {
  const f = fixture();
  const message = await f.message(1, { kind: 'group', id: 'work' });
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (value[PENDING_MOVE_KEY] === null) throw new Error('Cleanup refused');
    return set(value);
  };
  await assert.rejects(f.send('moveItem', message), /Cleanup refused/);
  f.api.storage.local.set = set;
  f.restart();
  const state = await f.send('moveItem', message);
  assert.equal(state.tabs.find((tab) => tab.id === 1).pinned, false);
  assert.equal(state.tabs.find((tab) => tab.id === 1).groupId, 'work');
  assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
});

for (const direction of ['pin', 'unpin']) {
  test(`${direction} recovers after interruption at every native or storage write`, async () => {
    async function prepare() {
      const f = fixture();
      await f.send('setGroupPin', { id: 'work', action: 'open' });
      if (direction === 'pin') await f.send('pinTab', { id: 1 });
      const destination =
        direction === 'pin'
          ? { kind: 'pins', before: { kind: 'group', id: 'work' } }
          : { kind: 'group', id: 'work' };
      return { f, message: await f.message(1, destination) };
    }

    function intercept(f, afterWrite) {
      const restore = [];
      for (const [object, name] of [
        [f.api.storage.local, 'set'],
        [f.api.sessions, 'setTabValue'],
        [f.api.sessions, 'setWindowValue'],
        [f.api.tabs, 'update'],
        [f.api.tabs, 'move'],
      ]) {
        const original = object[name];
        object[name] = async (...args) => {
          const result = await original(...args);
          await afterWrite();
          return result;
        };
        restore.push(() => {
          object[name] = original;
        });
      }
      return () => restore.forEach((restore) => restore());
    }

    const baseline = await prepare();
    let writes = 0;
    intercept(baseline.f, () => {
      writes++;
    });
    const expected = await baseline.f.send('moveItem', baseline.message);
    const organisation = (state) => ({
      tabs: state.tabs.map(({ treeId, groupId, ancestors, pinned, cookieStoreId }) => ({
        treeId,
        groupId,
        ancestors,
        pinned,
        cookieStoreId,
      })),
      pins: state.pins,
    });
    for (let boundary = 1; boundary <= writes; boundary++) {
      const { f, message } = await prepare();
      let calls = 0,
        interrupted;
      const reached = new Promise((resolve) => {
        interrupted = resolve;
      });
      const restore = intercept(f, () => {
        if (++calls !== boundary) return;
        interrupted();
        return new Promise(() => {});
      });
      void f.send('moveItem', message).catch(() => {});
      await reached;
      restore();
      f.restart();
      const recovered = await f.send('moveItem', message);
      assert.deepEqual(organisation(recovered), organisation(expected), `write ${boundary}`);
      assert.equal(f.api.testing.saved[PENDING_MOVE_KEY], null);
      assert(recovered.moveResult.committed);
    }
  });
}

test('a failed layout save restores native pins, tree placement and mixed slots', async () => {
  const f = fixture();
  await f.send('setGroupPin', { id: 'work', action: 'reveal' });
  const before = await f.send('snapshot');
  const message = await f.message(1, { kind: 'group', id: 'work' });
  const save = f.api.sessions.setWindowValue;
  let once = true;
  f.api.sessions.setWindowValue = async (...args) => {
    if (once) {
      once = false;
      throw new Error('Layout unavailable');
    }
    return save(...args);
  };
  await assert.rejects(f.send('moveItem', message), /Layout unavailable/);
  const after = await f.send('snapshot');
  assert.deepEqual(after.pins, before.pins);
  assert.equal(after.tabs.find((tab) => tab.id === 1).pinned, true);
  assert.equal(after.tabs.find((tab) => tab.id === 2).parentTabId, 1);
  assert(after.tabs.every((tab) => tab.groupId === null));
});

test('reveal failures report a committed move and can be retried without moving again', async () => {
  const f = fixture();
  await f.send('pinTab', { id: 1 });
  const message = await f.message(1, { kind: 'group', id: 'work' });
  const save = f.api.sessions.setWindowValue;
  f.api.sessions.setWindowValue = async () => {
    throw new Error('View unavailable');
  };
  const moved = await f.send('moveItem', message);
  assert(moved.moveResult.committed);
  assert.match(moved.moveResult.revealError, /View unavailable/);
  assert.equal(moved.tabs.find((tab) => tab.id === 1).groupId, 'work');
  f.api.sessions.setWindowValue = save;
  const revealed = await f.send('revealItem', { source: moved.moveResult.source });
  assert.equal(revealed.revealedItem.id, 1);
});

test('folder recovery changes only placement and retains independent folder edits', async () => {
  const f = fixture();
  const created = await f.send('createGroup', { name: 'Source' });
  const source = moveSource(created, 'group', created.createdGroupId);
  const destination = { kind: 'group', id: 'work' };
  const message = {
    operationId: crypto.randomUUID(),
    source,
    destination,
    expected: resolveMove(created, source, destination).expected,
  };
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    if (value[PENDING_MOVE_KEY] === null) throw new Error('Cleanup refused');
    return set(value);
  };
  await assert.rejects(f.send('moveItem', message), /Cleanup refused/);
  f.api.storage.local.set = set;
  const saved = f.api.testing.saved[MODEL_KEY];
  saved.groups.find((group) => group.id === source.id).name = 'Renamed independently';
  saved.groups.find((group) => group.id === 'work').appearance = { icon: 'star', color: 'blue' };
  saved.groups.push({ id: 'unrelated', name: 'New folder', parentId: null });
  f.restart();
  const recovered = await f.send('moveItem', message);
  assert.equal(
    recovered.groups.find((group) => group.id === source.id).name,
    'Renamed independently',
  );
  assert.equal(recovered.groups.find((group) => group.id === source.id).parentId, 'work');
  assert.deepEqual(recovered.groups.find((group) => group.id === 'work').appearance, {
    icon: 'star',
    color: 'blue',
  });
  assert(recovered.groups.some((group) => group.id === 'unrelated'));
});
