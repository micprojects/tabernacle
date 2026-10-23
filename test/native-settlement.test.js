import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedSidebar,
  sidebarMatches,
  waitForStableObservation,
  measureSettledNative,
  validateNativeVariation,
  evaluateSidebarTarget,
  snapshotMatchesNative,
  completeNativePhase,
  sendNativeResult,
} from '../scripts/memory/native-settlement.js';

function fixture() {
  const tabs = [
    { id: 1, treeId: 'one', title: 'Parent', collapsed: true },
    { id: 2, treeId: 'two', title: 'Hidden child' },
    { id: 3, treeId: 'three', title: 'Folder tab' },
    { id: 4, treeId: 'four', title: 'Pinned', pinned: true },
    { id: 5, treeId: 'five', title: 'Home tab' },
  ];
  return {
    state: {
      tabs,
      pins: [{ kind: 'tab', id: 'four' }],
      view: { scopeId: null, collapsed: ['closed'] },
    },
    index: {
      roots: new Map([
        [null, [tabs[4]]],
        ['open', [tabs[0]]],
        ['closed', [tabs[2]]],
      ]),
      children: new Map([[1, [tabs[1]]]]),
      groupChildren: new Map([[null, [{ id: 'open' }, { id: 'closed' }]]]),
    },
  };
}

test('native expectation uses complete authority but honours rendered folder and tab folds', () => {
  const { state, index } = fixture();
  assert.deepEqual(
    expectedSidebar(state, index, () => {
      throw new Error('No search expected');
    }),
    {
      rows: [
        { id: 1, title: 'Parent' },
        { id: 5, title: 'Home tab' },
      ],
      pins: [{ id: 4, labelPrefix: 'Pinned, pinned' }],
    },
  );
  state.tabs[0].collapsed = false;
  state.view.collapsed = [];
  assert.deepEqual(
    expectedSidebar(state, index).rows.map((row) => row.id),
    [1, 2, 3, 5],
  );
  const expected = expectedSidebar(
    state,
    index,
    (snapshot, query) => {
      assert.equal(snapshot, state);
      assert.equal(query, 'hidden');
      return [1, 2];
    },
    ' HIDDEN ',
  );
  assert.deepEqual(expected.rows, [
    { id: 1, title: 'Parent' },
    { id: 2, title: 'Hidden child' },
  ]);
});

test('same row count cannot pass stale IDs, order, titles, missing pins or unfinished images', () => {
  const { state, index } = fixture();
  const expected = expectedSidebar(state, index);
  const observed = {
    ready: true,
    errorToast: null,
    pendingImages: 0,
    brokenImages: 0,
    fontsLoaded: true,
    rows: expected.rows,
    pins: [{ id: 4, label: 'Pinned, pinned, Container: Blue' }],
  };
  assert(sidebarMatches(observed, expected));
  for (const patch of [
    { rows: [...expected.rows].reverse() },
    { rows: [{ id: 99, title: 'Parent' }, expected.rows[1]] },
    { rows: [{ id: 1, title: 'Old title' }, expected.rows[1]] },
    { duplicateRows: [1] },
    { pins: [] },
    { pins: [{ id: 4, label: 'Old title, pinned' }] },
    { pendingImages: 1 },
    { brokenImages: 1 },
    { fontsLoaded: false },
    { errorToast: 'Failed to load state' },
    { ready: false },
  ])
    assert.equal(sidebarMatches({ ...observed, ...patch }, expected), false);
});

test('native settlement needs repeated matching stable samples and only host timers', async () => {
  let time = 0;
  const observations = [
    { hidden: false, rows: 0 },
    { hidden: true, rows: 2 },
    { hidden: true, rows: 3 },
    { hidden: true, rows: 3 },
    { hidden: true, rows: 3 },
  ];
  const waits = [];
  const result = await waitForStableObservation(async () => observations.shift(), {
    matches: (value) => value.hidden && value.rows === 3,
    now: () => time,

    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
  });
  assert.equal(result.samples, 5);
  assert.equal(result.stableSamples, 3);
  assert.equal(result.elapsedMs, 400);
  assert.deepEqual(waits, [100, 100, 100, 100]);
});

test('stable but stale native content times out with its last observation', async () => {
  let time = 0;
  await assert.rejects(
    waitForStableObservation(async () => ({ rows: [1], hidden: true }), {
      matches: (value) => value.rows.length === 2,
      timeoutMs: 300,
      now: () => time,

      wait: async (ms) => {
        time += ms;
      },

      label: 'window 2 title burst',
    }),
    (error) => {
      assert.match(error.message, /window 2 title burst/);
      assert.deepEqual(error.observation, { rows: [1], hidden: true });
      return true;
    },
  );
});

test('native memory reporters run only after settlement and recheck the measured DOM afterwards', async () => {
  const calls = [];
  const result = await measureSettledNative(
    async () => {
      calls.push('settle');
      return {
        summary: { stableSamples: 3 },

        read: async () => {
          calls.push('recheck');
          return { rows: 4 };
        },

        matches: (value) => value.rows === 4,
        compact: (value) => [value],
      };
    },
    async (minimize) => {
      calls.push(minimize ? 'after-gc' : 'before-gc');
      return { minimized: minimize };
    },
  );
  assert.deepEqual(calls, ['settle', 'before-gc', 'after-gc', 'recheck']);
  assert.deepEqual(result.dom, [{ rows: 4 }]);
  let reports = 0;
  await assert.rejects(
    measureSettledNative(
      async () => {
        throw new Error('Stale DOM');
      },
      async () => {
        reports++;
      },
    ),
    /Stale DOM/,
  );
  assert.equal(reports, 0);
  await assert.rejects(
    measureSettledNative(
      async () => ({
        read: async () => ({ rows: 1 }),
        matches: () => false,
      }),
      async () => ({}),
    ),
    /changed while memory reporters ran/,
  );
});

test('native comparisons reject incomplete pairs and mismatched source, runtime or harness', () => {
  const options = {
    sourceSha256: 'source',
    harnessSha256: 'harness',
    fixture: { tabs: 100, windows: 2, seed: 17 },
    environment: { node: '24', cpu: 'test' },
  };
  const report = {
    status: 'completed',
    kind: 'native-comparison',
    harness: { sha256: 'harness' },
    fixture: options.fixture,
    environment: options.environment,
    runs: Array.from({ length: 10 }, (_, i) => ({
      pair: Math.floor(i / 2) + 1,
      role: i % 2 ? 'candidate' : 'baseline',
      source: { sha256: 'source' },
      guard: { status: 'completed' },
      result: {
        status: 'completed',
        source: { sha256: 'source' },
        harness: { sha256: 'harness' },
        fixture: { sha256: 'fixture' },
        environment: { firefox: '158' },
      },
    })),
  };
  assert.deepEqual(validateNativeVariation(report, options), {
    fixtureSha256: 'fixture',
    firefox: '158',
  });
  for (const alter of [
    (value) => value.runs.splice(0, 2),
    (value) => {
      value.runs[0].source.sha256 = 'changed';
    },
    (value) => {
      value.runs[0].role = 'candidate';
    },
    (value) => {
      value.runs[0].guard.status = 'aborted';
    },
    (value) => {
      value.runs[0].result.harness.sha256 = 'old';
    },
    (value) => {
      value.runs[0].result.fixture.sha256 = 'changed';
    },
    (value) => {
      value.runs[0].result.environment.firefox = '159';
    },
    (value) => {
      value.environment.node = '25';
    },
  ]) {
    const broken = structuredClone(report);
    alter(broken);
    assert.throws(() => validateNativeVariation(broken, options), /Invalid native A\/A baseline/);
  }
});

for (const failRead of [false, true])
  test(`native target releases its long-string and promise fronts when reading ${failRead ? 'fails' : 'succeeds'}`, async () => {
    const calls = [];
    const value = {
      string: async () => {
        if (failRead) throw new Error('String failed');
        return JSON.stringify({ ok: true, value: { rows: 4 } });
      },

      release: async () => {
        calls.push('string');
      },
    };
    const promise = {
      getPromiseState: async () => ({ promiseState: { state: 'fulfilled', value } }),

      release: async () => {
        calls.push('promise');
      },
    };
    const previousWindow = globalThis.window;
    globalThis.window = {
      tabernacleScreenshotCommands: {
        scriptCommand: { execute: async () => ({ result: promise }) },
      },
    };
    try {
      const browser = { chrome: async (fn, ...args) => fn(...args) };
      const result = evaluateSidebarTarget(browser, 123, () => null);
      if (failRead) await assert.rejects(result, /String failed/);
      else assert.deepEqual(await result, { rows: 4 });
      assert.deepEqual(calls, ['string', 'promise']);
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  });

test('native title authority rejects a stale controller even when its rendered DOM would agree', () => {
  const native = [{ id: 1, title: 'Memory fixture 6', windowId: 2 }];
  assert(snapshotMatchesNative({ tabs: native }, native, 2));
  assert(
    !snapshotMatchesNative({ tabs: [{ ...native[0], title: 'Memory fixture 5' }] }, native, 2),
  );
  assert(!snapshotMatchesNative({ tabs: native }, native, 1));
  assert(
    !snapshotMatchesNative(
      { tabs: [native[0], native[0]] },
      [native[0], { ...native[0], id: 2 }],
      2,
    ),
  );
});

test('native DOM verification keeps query and visibility constraints through the memory sample', () => {
  const expected = {
    rows: [],
    pins: [],
    query: 'needle',
    visibility: { hidden: false, focused: false, minimised: false },
  };
  const observed = {
    ready: true,
    errorToast: null,
    pendingImages: 0,
    brokenImages: 0,
    fontsLoaded: true,
    rows: [],
    pins: [],
    query: 'needle',
    hidden: false,
    focused: false,
    minimised: false,
  };
  assert(sidebarMatches(observed, expected));
  for (const patch of [{ query: '' }, { hidden: true }, { focused: true }, { minimised: true }])
    assert(!sidebarMatches({ ...observed, ...patch }, expected));
});

test('native comparisons do not score a partial or unsupported phase as reassuring', () => {
  const metric = (phase) => phase.memory;
  const runs = Array.from({ length: 5 }, () => ({
    guard: { status: 'completed' },
    result: { status: 'completed' },
    phases: [{ name: 'minimised', memory: 100, supported: true }],
  }));
  assert(completeNativePhase(runs, 'minimised', 5, metric));
  runs[4].guard.status = 'aborted';
  assert(!completeNativePhase(runs, 'minimised', 5, metric));
  runs[4].guard.status = 'completed';
  runs[4].result.status = 'failed';
  assert(!completeNativePhase(runs, 'minimised', 5, metric));
  runs[4].result.status = 'completed';
  assert(!completeNativePhase(runs.slice(1), 'minimised', 5, metric));
  runs[0].phases[0].supported = false;
  assert(!completeNativePhase(runs, 'minimised', 5, metric));
  runs[0].phases[0].supported = true;
  delete runs[0].phases[0].memory;
  assert(!completeNativePhase(runs, 'minimised', 5, metric));
});

test('published-source search fallback uses its own index match rules and expands folded paths', () => {
  const { state, index } = fixture();
  index.groupChildren.set(null, [
    { id: 'open', name: 'Open' },
    { id: 'closed', name: 'Closed' },
  ]);
  index.groupStats = new Map([
    ['open', { match: true }],
    ['closed', { match: false }],
  ]);
  index.tabStats = new Map([
    [1, { match: false, descendantMatch: true }],
    [2, { match: true }],
    [5, { match: false, descendantMatch: false }],
  ]);
  assert.deepEqual(
    expectedSidebar(state, index, undefined, 'hidden').rows.map((row) => row.id),
    [1, 2],
  );
});

test('native worker waits for result delivery and surfaces IPC failure', async () => {
  let complete;
  let settled = false;
  const result = { status: 'completed', large: 'x'.repeat(300000) };
  const delivered = sendNativeResult(result, (message, callback) => {
    assert.equal(message.result, result);
    complete = callback;
  }).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  complete();
  await delivered;
  assert.equal(settled, true);
  await assert.rejects(
    sendNativeResult(result, (_message, callback) => callback(new Error('Channel closed'))),
    /Channel closed/,
  );
});
