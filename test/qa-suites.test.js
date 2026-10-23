import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { uiSuites, firefoxSuites, suiteFile } from '../scripts/qa-suites.js';

test('the release gate includes every maintained UI and native Firefox regression suite', async () => {
  const registered = [...uiSuites, ...firefoxSuites];
  assert.equal(new Set(registered).size, registered.length);
  for (const [directory, names] of [
    ['ui', uiSuites],
    ['firefox', firefoxSuites],
  ]) {
    const entries = await readdir(new URL(`./${directory}/`, import.meta.url), {
      withFileTypes: true,
    });
    assert(entries.every((entry) => entry.isFile() && /^test-.*\.js$/.test(entry.name)));
    const maintained = entries.map((entry) => `test/${directory}/${entry.name}`).sort();
    assert.deepEqual(names.map(suiteFile).sort(), maintained);
  }
  const scripts = await readdir(new URL('../scripts/', import.meta.url));
  assert(!scripts.some((name) => /^test-(?:.*-)?(?:ui|firefox)\.js$/.test(name)));
});

test('suite paths preserve stress routing and reject unknown identifiers', () => {
  assert.equal(suiteFile('stress-firefox'), 'scripts/stress-firefox.js');
  assert.throws(() => suiteFile('../unregistered'), /Unknown browser suite/);
});
