import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
assert(input && output, 'Usage: node summarise-profile.mjs PROFILE_JSON SUMMARY_JSON');
const profile = JSON.parse(await readFile(input, 'utf8'));

function threads(process) {
  return [...(process.threads || []), ...(process.processes || []).flatMap(threads)];
}

const thread = threads(profile).find(
  (t) => t.processName === 'WebExtensions' && t.name === 'GeckoMain',
);
assert(thread, 'No WebExtensions main thread');
const { schema, data } = thread.markers;
const markers = data.map((row) => ({
  name: thread.stringTable[row[schema.name]],
  start: row[schema.startTime],
  end: row[schema.endTime],
  data: row[schema.data],
}));
const start = markers.find((m) => m.data?.name === 'viewport-profile-start')?.start;
const end = markers.find((m) => m.data?.name === 'viewport-profile-end')?.start;
assert(Number.isFinite(start) && end > start, 'Missing workload bounds');
const within = markers.filter((m) => m.start >= start && m.start <= end);
const normalise = (name) => name.replace(/moz-extension:\/\/[^/]+/g, 'moz-extension://fixture');

function frames(index) {
  const names = [];
  while (index !== null && index !== undefined) {
    const row = thread.stackTable.data[index];
    const frame = thread.frameTable.data[row[thread.stackTable.schema.frame]];
    names.push(normalise(thread.stringTable[frame[thread.frameTable.schema.location]]));
    index = row[thread.stackTable.schema.prefix];
  }
  return names;
}

function add(map, name, size) {
  const item = map.get(name) || { name, count: 0, bytes: 0 };
  item.count++;
  item.bytes += size;
  map.set(name, item);
}

const allocationFrames = new Map(),
  allocationClasses = new Map(),
  sampleFrames = new Map();
let threadCpu = 0;
for (const marker of within.filter((m) => m.name === 'JS allocation')) {
  const stack = marker.data.stack;
  const index = stack?.samples.data[0]?.[stack.samples.schema.stack];
  const frame =
    frames(index).find((name) => name.includes('moz-extension://')) || '(outside extension script)';
  add(allocationFrames, frame, marker.data.size);
  add(allocationClasses, marker.data.className || marker.data.typeName, marker.data.size);
}
for (const sample of thread.samples.data) {
  const time = sample[thread.samples.schema.time];
  if (time < start || time > end) continue;
  threadCpu += sample[thread.samples.schema.threadCPUDelta] || 0;
  const frame = frames(sample[thread.samples.schema.stack]).find((name) =>
    name.includes('moz-extension://'),
  );
  if (frame) add(sampleFrames, frame, 0);
}
const gc = within.filter((m) => /^(GCMinor|GCMajor|GCSlice|CC)$/.test(m.name));
// A major collection may contain slice intervals; count overlapping time once.
let gcDurationMs = 0,
  gcEnd = -Infinity;
for (const marker of [...gc].sort((a, b) => a.start - b.start)) {
  if (marker.end > marker.start) {
    gcDurationMs += Math.max(0, marker.end - Math.max(marker.start, gcEnd));
    gcEnd = Math.max(gcEnd, marker.end);
  }
}
const cpuScale = { µs: 1000, ns: 1e6, ms: 1 }[profile.meta.sampleUnits?.threadCPUDelta];
const summary = {
  note: 'One instrumented Firefox recording. Allocation markers are sampled, not total allocated bytes; profiling changes timing/GC behaviour. No performance verdict.',
  elapsedMs: end - start,
  sampledThreadCpuMs: cpuScale ? threadCpu / cpuScale : null,
  sampledAllocations: [...allocationClasses.values()].reduce((sum, item) => sum + item.count, 0),
  sampledAllocationBytes: [...allocationClasses.values()].reduce(
    (sum, item) => sum + item.bytes,
    0,
  ),
  allocationClasses: [...allocationClasses.values()].sort((a, b) => b.bytes - a.bytes),
  allocationFrames: [...allocationFrames.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 25),
  extensionSampleFrames: [...sampleFrames.values()].sort((a, b) => b.count - a.count).slice(0, 25),
  gc: gc.map((m) => ({ kind: m.name, durationMs: m.end - m.start, ...m.data })),
  gcDurationMs,
  completedNurseryBytes: gc.reduce((sum, m) => sum + (m.data?.nursery?.bytes_used || 0), 0),
  styleFlushMarkers: within.filter((m) => m.name === 'Styles').length,
  reflowMarkers: within.filter((m) => m.name === 'Reflow (sync)').length,
};
await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(
  JSON.stringify(
    { ...summary, gc: summary.gc.map((m) => ({ kind: m.kind, durationMs: m.durationMs })) },
    null,
    2,
  ),
);
