import { setTimeout } from 'node:timers/promises';
import { memoryGuard, readPressure } from './common.js';

// A recently closed Firefox process can leave macOS pressure in its warning
// state briefly. Wait only before launch; never restart an aborted native run.
export async function waitForPreflight({
  timeoutMs = 120000,
  intervalMs = 5000,
  pressure = readPressure,
  wait = setTimeout,
  now = Date.now,
  onReading = () => {},
} = {}) {
  const started = now();
  const readings = [];
  while (true) {
    const reading = await pressure();
    const reason = memoryGuard(
      {
        pressurePercent: reading.percent,
        pressureLevel: reading.level,
        rssBytes: 0,
        elapsedMs: 0,
      },
      { start: true },
    );
    const elapsedMs = now() - started;
    const observation = { elapsedMs, ...reading, reason };
    readings.push(observation);
    await onReading(observation);
    if (!reason || elapsedMs >= timeoutMs)
      return { status: reason ? 'timed-out' : 'ready', elapsedMs, readings };
    await wait(Math.min(intervalMs, timeoutMs - elapsedMs));
  }
}
