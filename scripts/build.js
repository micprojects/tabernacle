import { cp, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import webExt from 'web-ext';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
if (pkg.version !== manifest.version) throw new Error('Package and manifest versions must match.');

// Include the root license without adding generated files to the source tree.
const staging = await mkdtemp(join(tmpdir(), 'tabernacle-build-'));
try {
  await cp('extension', staging, { recursive: true });
  await copyFile('LICENSE', join(staging, 'LICENSE'));
  const result = await webExt.cmd.build({
    sourceDir: staging,
    artifactsDir: resolve('dist'),
    overwriteDest: true,
  });
  console.log(`Unsigned extension: ${result.extensionPath}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
