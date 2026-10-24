import test from 'node:test';
import assert from 'node:assert/strict';
import {
  idleFixture,
  verifyIdleSnapshot,
  waitForIdleMemory,
} from '../scripts/memory/idle-fixture.js';
import {
  iterationFixture,
  iterationOptions,
  iterationWorkload,
} from '../scripts/memory/iteration-policy.js';
import { nativeMetrics } from '../scripts/memory/iteration-report.js';

test('idle fixtures populate every expanded folder in both windows, three levels deep', () => {
  for (const [tabs, folders] of [
    [1000, 100],
    [5000, 500],
  ]) {
    const fixture = idleFixture(tabs, folders, 2);
    const groups = new Map(fixture.groups.map((g) => [g.id, g]));
    const depths = fixture.groups.map((g) => {
      let depth = 1;
      while (g.parentId) {
        g = groups.get(g.parentId);
        depth++;
      }
      return depth;
    });
    assert.equal(Math.max(...depths), 3);
    assert.equal(depths.filter((d) => d === 1).length, folders / 10);
    const ids = Array.from({ length: tabs }, (_, i) => i + 1);
    for (let window = 0; window < 2; window++) {
      const members = fixture.memberships.flatMap((m, i) =>
        i % 2 === window ? [{ ...m, id: ids[i], discarded: true }] : [],
      );
      assert.equal(new Set(members.map((m) => m.groupId)).size, folders);
      const snapshot = {
        groups: fixture.groups,
        tabs: [...members, { id: tabs + window + 1 }],
        view: { scopeId: null, collapsed: [] },
      };
      verifyIdleSnapshot(snapshot, fixture, ids, window, 2);
      snapshot.view.collapsed.push(fixture.groups[0].id);
      assert.throws(() => verifyIdleSnapshot(snapshot, fixture, ids, window, 2), /expanded/);
      snapshot.view.collapsed = [];
      snapshot.tabs[0].groupId = 'wrong';
      assert.throws(() => verifyIdleSnapshot(snapshot, fixture, ids, window, 2), /membership/);
    }
  }
  assert.throws(() => idleFixture(100, 100, 2));
  assert.throws(() => idleFixture(1000, 101, 2));
});

test('idle waits for startup memory release and a full stable window, without forced collection', async () => {
  let time = 0;
  const policy = iterationFixture.idle;
  const result = await waitForIdleMemory(
    () => (time < 36000 ? 100e6 - time * 1000 : 50e6),
    policy,
    {
      now: () => time,

      wait: async (ms) => {
        time += ms;
      },
    },
  );
  assert.equal(result.elapsedMs, 46000);
  assert.equal(result.rangeBytes, 0);
  assert.equal(result.residentBytes, 50e6);
  time = 0;
  const stable = await waitForIdleMemory(() => 50e6, policy, {
    now: () => time,

    wait: async (ms) => {
      time += ms;
    },
  });
  assert.equal(stable.elapsedMs, 30000, 'Early plateaus must still allow startup cleanup');
  time = 0;
  await assert.rejects(
    waitForIdleMemory(() => 100e6 + time * 1000, policy, {
      now: () => time,

      wait: async (ms) => {
        time += ms;
      },
    }),
    (error) => error.code === 'IDLE_NOT_SETTLED' && error.observation.elapsedMs === 60000,
  );
  await assert.rejects(
    waitForIdleMemory(() => NaN, policy),
    /Missing idle RSS/,
  );
});

test('idle attribution accepts natural samples only and preserves disabled drift and negative estimates', () => {
  const phase = (name, resident, pid = 7) => ({
    name,
    elapsedMs: 30000,
    cpu: { extensionMs: 1, totalMs: 2 },
    beforeCollection: {
      processes: [{ pid, type: 'extension' }],
      reports: {
        [`WebExtensions (pid ${pid})`]: {
          resident,
          'resident-unique': resident / 2,
          'heap-allocated': 10,
        },
      },
    },
  });
  const result = {
    phases: [
      phase('disabled-before', 100),
      phase('enabled-idle', 90),
      phase('disabled-final', 105),
    ],
  };
  const metrics = nativeMetrics(result, { peakRssBytes: 1000 });
  assert.equal(metrics['Firefox/enabled-idle/unforced/added-resident.bytes'], -10);
  assert.equal(metrics['Firefox/disabled-final/unforced/added-resident.bytes'], 5);
  assert(!Object.keys(metrics).some((name) => name.includes('/collected/')));
  result.phases[2] = phase('disabled-final', 100, 8);
  assert.throws(() => nativeMetrics(result, { peakRssBytes: 1000 }), /process restarted/);
});

test('settled headline uses undisturbed OS samples and the explicit disabled control', () => {
  const phase = (name, resident, sampled) => ({
    name,
    elapsedMs: 30000,
    cpu: { extensionMs: 1, totalMs: 2 },
    idle: { residentBytes: sampled },
    beforeCollection: {
      processes: [{ pid: 7, type: 'extension' }],
      reports: {
        'WebExtensions (pid 7)': {
          resident,
          'resident-unique': resident / 2,
          'heap-allocated': 10,
        },
      },
    },
  });
  const result = {
    memoryBaselinePhase: 'disabled-final',
    phases: [phase('enabled-idle', 190, 120), phase('disabled-final', 105, 100)],
  };
  const metrics = nativeMetrics(result, { peakRssBytes: 1000 });
  assert.equal(metrics['Firefox/enabled-idle/settled-added-resident.bytes'], 20);
  assert.equal(metrics['Firefox/enabled-idle/unforced/added-resident.bytes'], 85);
  assert.equal(metrics['Firefox/disabled-final/settled-resident.bytes'], 100);
  result.phases[1].idle.residentBytes = NaN;
  assert.throws(() => nativeMetrics(result, { peakRssBytes: 1000 }), /Missing settled/);
});

test('routine idle work is bounded and the larger scaling fixture is explicit', () => {
  assert.deepEqual(iterationFixture.idle.sizes, [{ tabs: 1000, folders: 100 }]);
  assert(!iterationOptions([]).idleScaling);
  assert(iterationOptions(['--idle-scaling']).idleScaling);
  assert.throws(() => iterationOptions(['--idle-scaling', '--synthetic-only']), /native Firefox/);
  const ordinary = iterationWorkload(iterationOptions([]));
  const heavy = iterationWorkload(iterationOptions(['--idle-scaling']));
  assert.equal(ordinary.native.tabs, 1000);
  assert.equal(ordinary.synthetic.length, 3);
  assert.equal(heavy.native, null);
  assert.deepEqual(heavy.synthetic, []);
  assert.deepEqual(heavy.idle.sizes, [{ tabs: 5000, folders: 500 }]);
  assert.equal(heavy.idle.minQuietMs, ordinary.idle.minQuietMs);
  assert.deepEqual(iterationFixture.idle.sizes, [{ tabs: 1000, folders: 100 }]);
});
