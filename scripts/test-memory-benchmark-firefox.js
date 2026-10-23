import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Functional smoke coverage of the real-sidebar observer, off/on attribution,
// lower watchdog and report pipeline. A pilot is never a performance verdict.
if (process.platform !== 'darwin') {
  console.log('Inconclusive: the iteration memory watchdog requires macOS memory_pressure.');
  process.exitCode = 2;
} else {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./benchmark-optimisation.js', import.meta.url)), '--pilot'],
    { stdio: 'inherit' },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  process.exitCode = Number.isInteger(code) ? code : 1;
}
