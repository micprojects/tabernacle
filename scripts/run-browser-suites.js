import { spawnSync } from 'node:child_process';
import { suiteFile } from './qa-suites.js';

export function runBrowserSuites(names) {
  for (const name of names) {
    const result = spawnSync(process.execPath, [suiteFile(name)], {
      stdio: 'inherit',
      timeout: 180_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
