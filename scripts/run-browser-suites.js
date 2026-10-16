import { spawnSync } from 'node:child_process';

export function runBrowserSuites(names) {
  for (const name of names) {
    const result = spawnSync(process.execPath, [`scripts/${name}.js`], {
      stdio: 'inherit',
      timeout: 180_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
