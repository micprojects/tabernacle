import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createRefreshScheduler } from '../extension/src/refresh-scheduler.js';

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = { state: { generation: 'a', revision: 1 }, calls: 0, visible: true };
  f.scheduler = createRefreshScheduler({
    delay: 10,
    getState: () => f.state,
    getWindowId: () => 1,
    canRefresh: () => f.visible,

    refresh: async () => {
      f.calls++;
    },

    ...options,
  });
  f.tick = async (ms = 10) => {
    t.mock.timers.tick(ms);
    await setImmediate();
  };
  t.after(() => f.scheduler.dispose());
  return f;
}

test('coalesces notifications without postponing a continuous stream', async (t) => {
  const f = fixture(t);
  f.scheduler.schedule({ revision: 2, generation: 'a' });
  await f.tick(5);
  f.scheduler.schedule({ revision: 3, generation: 'a' });
  await f.tick(5);
  assert.equal(f.calls, 1);
  await f.tick();
  assert.equal(f.calls, 1);
});

test('ignores other windows and revisions already included in an action response', async (t) => {
  const f = fixture(t);
  f.scheduler.schedule({ windowIds: [2], revision: 2 });
  f.scheduler.schedule({ windowId: 2, revision: 3 });
  f.scheduler.schedule({ windowIds: [1], revision: 1, generation: 'a' });
  await f.tick();
  assert.equal(f.calls, 0);
  f.scheduler.schedule({ windowIds: [1, 2], revision: 4, generation: 'a' });
  f.state.revision = 4;
  await f.tick();
  assert.equal(f.calls, 0);
  f.scheduler.schedule({ windowIds: null, revision: 5, generation: 'a' });
  await f.tick();
  assert.equal(f.calls, 1);
});

test('global-only views ignore window events but accept a restarted generation', async (t) => {
  const f = fixture(t, { globalOnly: true });
  f.state.revision = 100;
  f.scheduler.schedule({ windowIds: [1], revision: 101, generation: 'a' });
  await f.tick();
  assert.equal(f.calls, 0);
  f.scheduler.schedule({ revision: 0, generation: 'b' });
  await f.tick();
  assert.equal(f.calls, 1);
});

test('paused views defer work and resume once with the newest notification', async (t) => {
  const f = fixture(t);
  f.visible = false;
  for (let revision = 2; revision < 50; revision++) f.scheduler.schedule({ revision });
  await f.tick(1000);
  assert.equal(f.calls, 0);
  f.visible = true;
  f.scheduler.resume();
  await f.tick();
  assert.equal(f.calls, 1);
});

test('in-flight reads never overlap and obsolete follow-ups are suppressed', async (t) => {
  let release;
  const f = fixture(t, {
    refresh: async () => {
      f.calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  f.scheduler.schedule();
  await f.tick();
  f.scheduler.schedule({ revision: 2 });
  f.scheduler.schedule({ revision: 3 });
  await f.tick();
  assert.equal(f.calls, 1);
  f.state.revision = 3;
  release();
  await setImmediate();
  await f.tick();
  assert.equal(f.calls, 1);
  f.scheduler.schedule();
  await f.tick();
  f.scheduler.schedule({ revision: 4 });
  release();
  await setImmediate();
  await f.tick();
  assert.equal(f.calls, 3);
  release();
});

test('a rejected read does not spin or prevent a later retry', async (t) => {
  const errors = [];
  const f = fixture(t, {
    refresh: async () => {
      throw new Error('Offline');
    },

    onError: (e) => errors.push(e.message),
  });
  f.scheduler.schedule();
  await f.tick();
  await f.tick(1000);
  assert.deepEqual(errors, ['Offline']);
  f.scheduler.schedule();
  await f.tick();
  assert.deepEqual(errors, ['Offline', 'Offline']);
});

test('disposing cancels pending work, including after an in-flight read', async (t) => {
  let release;
  const f = fixture(t, {
    refresh: async () => {
      f.calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  f.scheduler.schedule();
  await f.tick();
  f.scheduler.schedule();
  f.scheduler.dispose();
  release();
  await setImmediate();
  await f.tick();
  await f.scheduler.now();
  assert.equal(f.calls, 1);
});
