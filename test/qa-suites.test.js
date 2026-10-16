import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { uiSuites, firefoxSuites } from '../scripts/qa-suites.js';

test('the release gate includes every maintained UI and native Firefox regression suite', async () => {
  const scripts = await readdir(new URL('../scripts/', import.meta.url));
  const maintained = scripts
    .filter((name) => /^test-(?:.*-)?(?:ui|firefox)\.js$/.test(name))
    .map((name) => name.slice(0, -3));
  const registered = [...uiSuites, ...firefoxSuites];
  assert.equal(new Set(registered).size, registered.length);
  assert.deepEqual(registered.sort(), maintained.sort());
});
