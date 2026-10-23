import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performanceFixture, performanceBrowser } from '../../preview/performance-fixture.js';
import { fingerprintSource, percentile, machineInfo } from './common.js';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runSynthetic(options) {
  const source = await fingerprintSource(options.sourceRoot);
  const { createController } = await import(
    pathToFileURL(resolve(options.sourceRoot, 'extension/src/controller.js'))
  );
  let transport;
  try {
    transport = await import(
      pathToFileURL(resolve(options.sourceRoot, 'extension/src/snapshot-transfer.js'))
    );
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  let fixture = performanceFixture(options);
  const seed = fixture.seed;
  const fixtureFingerprint = digest({
    config: { tabs: options.tabs, windows: options.windows, seed: fixture.seed },
    tabs: fixture.tabs,
    memberships: [...fixture.memberships],
  });
  let memorySamples = [];

  const sampleMemory = (outstandingReads = 0) => {
    const sample = {
      outstandingReads,
      heapUsed: process.memoryUsage().heapUsed,
      rss: process.memoryUsage().rss,
    };
    memorySamples.push(sample);
    return sample;
  };

  const f = performanceBrowser(fixture, { onReadConcurrency: sampleMemory });
  const windowIds = fixture.windows;
  fixture = null;
  const originalMembership = digest([...f.memberships]);
  const originalModel = digest(f.saved);
  let controller;
  let immutableTransport = false;
  let encoder;
  let readers = [];
  const phases = [];
  let messages;
  let pendingCreations = [];
  const created = (tab) => pendingCreations.push(controller.created(tab));
  f.api.tabs.onCreated.addListener(created);

  const startController = () => {
    controller = createController(f.api);
    immutableTransport = Boolean(controller.requestForTransport);
    encoder = transport?.createSnapshotEncoder();
  };

  const heap = () => {
    globalThis.gc?.();
    const { heapUsed, heapTotal, rss, external } = process.memoryUsage();
    return { heapUsed, heapTotal, rss, external, gcRequested: Boolean(globalThis.gc) };
  };

  const send = async (windowId, token) => {
    const state = await (controller.requestForTransport ?? controller.request)({
      type: 'snapshot',
      windowId,
    });
    const encoded = encoder ? encoder.encode(windowId, state, token) : state;
    messages.bytes += Buffer.byteLength(JSON.stringify(encoded));
    messages[encoded.baseToken ? 'deltas' : 'fulls']++;
    messages.changedTabs += encoded.changes?.length || 0;
    // Model the message copy explicitly. This is still Node, not Firefox IPC.
    return structuredClone(encoded);
  };

  const openReaders = () => {
    readers = windowIds.flatMap((windowId) =>
      Array.from({ length: options.readers }, () => ({
        windowId,
        read: transport
          ? transport.createSnapshotReader((token) => send(windowId, token))
          : () => send(windowId),
      })),
    );
  };

  const readAll = async (latencies) => {
    for (const reader of readers) {
      const started = performance.now();
      const state = await reader.read();
      reader.displayedState = state;
      assert(state.tabs.every((tab) => tab.windowId === reader.windowId));
      assert.equal(state.tabs.length, f.tabCount(reader.windowId));
      latencies.push(performance.now() - started);
    }
  };

  const phase = async (name, work) => {
    f.resetStats();
    messages = { bytes: 0, fulls: 0, deltas: 0, changedTabs: 0 };
    const latencies = [];
    memorySamples = [];
    sampleMemory();
    const started = performance.now();
    await work(latencies);
    sampleMemory();
    const result = {
      name,
      elapsedMs: performance.now() - started,
      requestMs: {
        count: latencies.length,
        median: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.length ? Math.max(...latencies) : null,
      },
      api: f.stats(),
      messages: { ...messages },
      memory: heap(),
      displayedSnapshots: readers.filter((reader) => reader.displayedState).length,
      displayedTabReferences: readers.reduce(
        (sum, reader) => sum + (reader.displayedState?.tabs.length || 0),
        0,
      ),
      sampledMemory: {
        maxHeapUsed: Math.max(...memorySamples.map((sample) => sample.heapUsed)),
        maxRss: Math.max(...memorySamples.map((sample) => sample.rss)),
        samples: memorySamples,
        exactPeak: false,
      },
    };
    assert.equal(result.displayedSnapshots, readers.length);
    assert.equal(
      result.displayedTabReferences,
      readers.length ? options.tabs * options.readers : 0,
    );
    phases.push(result);
    process.send?.({ type: 'progress', phase: name, elapsedMs: result.elapsedMs });
  };

  const baselineMemory = heap();
  try {
    startController();
    openReaders();
    await phase('cold-readers', readAll);
    await phase('warm-readers', readAll);
    await phase('metadata-burst', async (latencies) => {
      const targets = [...f.native.values()].filter((tab) => tab.windowId === 1).slice(0, 50);
      for (let round = 0; round < 2; round++)
        for (const tab of targets)
          await f.api.tabs.update(tab.id, { title: `${tab.title} changed ${round}` });
      await readAll(latencies);
    });
    await phase('create-close-burst', async (latencies) => {
      const added = [];
      for (let i = 0; i < Math.min(options.tabs, 100); i++)
        added.push(
          (
            await f.api.tabs.create({
              windowId: 1,
              url: `https://created.invalid/${i}`,
              title: `Created ${i}`,
              discarded: true,
            })
          ).id,
        );
      await Promise.all(pendingCreations);
      pendingCreations = [];
      await f.api.tabs.remove(added);
      await readAll(latencies);
    });
    await phase('readers-closed', async () => {
      readers = [];
    });
    await phase('readers-reopened', async (latencies) => {
      openReaders();
      await readAll(latencies);
    });
    await phase('background-restart', async (latencies) => {
      controller.dispose();
      startController();
      // Keep frontend tokens so the real generation/full-fallback path is exercised.
      await readAll(latencies);
    });
    assert.equal(
      digest([...f.memberships]),
      originalMembership,
      'Original memberships changed during diagnostics',
    );
    assert.equal(digest(f.saved), originalModel, 'Saved model changed during diagnostics');
    await phase('disposed', async () => {
      f.api.tabs.onCreated.removeListener(created);
      readers = [];
      encoder = null;
      controller.dispose();
      controller = null;
    });
  } finally {
    controller?.dispose();
    f.api.tabs.onCreated.removeListener(created);
  }
  const after = await fingerprintSource(options.sourceRoot);
  assert.equal(after.sha256, source.sha256, 'Source changed during the benchmark');
  return {
    version: 1,
    kind: 'synthetic',
    readerRetention:
      'Every reader retains its displayed snapshot across GC, including legacy full-response readers.',
    status: 'completed',
    recordedAt: new Date().toISOString(),
    source,
    fixture: {
      tabs: options.tabs,
      windows: options.windows,
      readersPerWindow: options.readers,
      seed,
      sha256: fixtureFingerprint,
    },
    environment: machineInfo(),
    capabilities: {
      incremental: Boolean(transport),
      immutableTransport,
    },
    limitations: [
      'Node heap and JSON byte estimates do not measure Firefox RSS, DOM, native IPC, image decoding or actual sidebar lifetime.',
      'Latency diagnostics include fixture validation and message-copy measurement; there are no machine-dependent timing pass thresholds.',
    ],
    baselineMemory,
    phases,
    preservedMemberships: true,
  };
}
