import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeMemory } from '../scripts/memory/native.js';

async function report(t, rows, { origin = 'aaaa-bbbb', minimize = true } = {}) {
  const saved = new Map(['Cc', 'Ci', 'ChromeUtils'].map((name) => [name, globalThis[name]]));
  t.after(() => {
    for (const [name, value] of saved)
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
  });
  let flags;
  globalThis.Cc = {
    '@mozilla.org/memory-reporter-manager;1': {
      getService: () => ({
        getReportsExtended(callback, _data, done, _doneData, anonymized, minimized) {
          flags = { anonymized, minimized };
          for (const [process, path, units, amount] of rows)
            callback(process, path, 1, units, amount);
          done();
        },
      }),
    },
  };
  globalThis.Ci = { nsIMemoryReporterManager: {} };
  globalThis.ChromeUtils = {
    requestProcInfo: async () => ({
      pid: 1,
      type: 'browser',
      memory: 999,
      children: [{ pid: 77, type: 'extension', memory: 888 }],
    }),
  };
  const result = await nativeMemory(
    {
      ...(origin ? { sidebarUrl: `moz-extension://${origin}/sidebar.html` } : {}),
      chrome: async (fn, ...args) => fn(...args),
    },
    minimize,
  );
  return { result, flags };
}

test('direct attribution includes detached contexts and images without cross-cutting or foreign bytes', async (t) => {
  const process = 'extension (pid 77)';
  const rows = [
    [process, 'resident', 0, 1000],
    [
      process,
      String.raw`explicit/window-objects/top(moz-extension:\\aaaa-bbbb\sidebar.html)/active/dom/other`,
      0,
      100,
    ],
    [
      process,
      'explicit/window-objects/top(none)/detached/window(moz-extension://aaaa-bbbb/activity.html)/dom/other',
      0,
      50,
    ],
    [process, 'explicit/images/image(moz-extension://aaaa-bbbb/icon.svg)/source', 0, 25],
    [process, 'explicit/window-objects/moz-extension://aaaa-bbbb-extra/sidebar.html', 0, 10000],
    [process, 'explicit/window-objects/https://example.com/aaaa-bbbb', 0, 20000],
    [process, 'js-main-runtime-gc-buffers/moz-extension://aaaa-bbbb/free', 0, 30000],
    [process, 'explicit/window-objects/moz-extension://aaaa-bbbb/count', 1, 40000],
    ['other (pid 88)', 'explicit/window-objects/moz-extension://aaaa-bbbb/dom/other', 0, 99999],
  ];
  const { result, flags } = await report(t, rows);
  assert.deepEqual(flags, { anonymized: false, minimized: true });
  assert.equal(result.reports[process].attributedExplicitBytes, 175);
  assert.equal(result.reports[process].attributedExplicitReports, 3);
  assert.equal(result.reports['other (pid 88)'].attributedExplicitBytes, 99999);
  assert.equal(result.attribution.origin, 'aaaa-bbbb');
  assert(!JSON.stringify(result).includes('activity.html'), 'Full reporter paths are not retained');
});

test('unavailable origin stays unavailable and preserves anonymized reporting', async (t) => {
  const { result, flags } = await report(t, [['extension (pid 77)', 'resident', 0, 1000]], {
    origin: null,
    minimize: false,
  });
  assert.deepEqual(flags, { anonymized: true, minimized: false });
  assert.equal(result.attribution, null);
  assert.equal(result.reports['extension (pid 77)'].attributedExplicitBytes, undefined);
});

test('origin matching treats hostname punctuation literally', async (t) => {
  const process = 'extension (pid 77)';
  const { result } = await report(
    t,
    [
      [process, 'resident', 0, 1000],
      [process, 'explicit/window(moz-extension://aaaa.bbbb/sidebar.html)/other', 0, 10],
      [process, 'explicit/window(moz-extension://aaaaxbbbb/sidebar.html)/other', 0, 999],
    ],
    { origin: 'aaaa.bbbb' },
  );
  assert.equal(result.reports[process].attributedExplicitBytes, 10);
});

test('a known origin with no remaining reports is zero, while invalid byte reports stay unavailable', async (t) => {
  const { result } = await report(t, [
    ['extension (pid 77)', 'resident', 0, 1000],
    ['invalid (pid 88)', 'explicit/window(moz-extension://aaaa-bbbb/sidebar.html)/other', 0, -1],
    ['invalid (pid 88)', 'explicit/window(moz-extension://aaaa-bbbb/sidebar.html)/more', 0, 100],
  ]);
  assert.equal(result.reports['extension (pid 77)'].attributedExplicitBytes, 0);
  assert.equal(result.reports['extension (pid 77)'].attributedExplicitReports, 0);
  assert.equal(result.reports['invalid (pid 88)'].attributedExplicitBytes, null);
});
