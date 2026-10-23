import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceSource, sourceFile } from '../scripts/instrumentation/source.js';
import { withWrapperPool } from '../scripts/benchmarks/viewport/variants.mjs';

test('source adaptations reject absent, ambiguous and invalid anchors', () => {
  assert.equal(replaceSource('before anchor after', 'anchor', '$&'), 'before $& after');
  assert.throws(() => replaceSource('before', 'anchor', ''), /found 0/);
  assert.throws(() => replaceSource('anchor anchor', 'anchor', ''), /found 2/);
  assert.throws(() => replaceSource('source', '', ''), TypeError);
  assert.equal(replaceSource('anchor anchor', 'anchor', 'next', 2), 'next next');
});

test('diagnostic row variants support the historical and extracted factory layouts', async () => {
  const current = await readFile(
    new URL('../extension/src/sidebar/rows.js', import.meta.url),
    'utf8',
  );
  const adapted = withWrapperPool(current);
  assert.match(adapted, /getTreeRenderer\(\)\.virtual && !wrapper\.branch/);
  assert.match(adapted, /spareTabWrappers\.length = 0/);
  const historical = String.raw`
const wrappers = new Map();
function wrapperFor(kind, id, needsBranch = true) {
  const key = \`${'${kind}:${id}'}\`;
  usedWrappers.add(key);
}
function finishRows() {
  if (!usedWrappers.has(key) && !treeMotion.owns(wrapper.node)) wrappers.delete(key);
}
function releaseTree() {
  wrappers.clear();
}`.replaceAll('\\`', '`');
  assert.match(withWrapperPool(historical), /treeRenderer\.virtual && !wrapper\.branch/);
  assert.throws(() => withWrapperPool('unknown layout'), /Unsupported.*layout/);
  assert.throws(() => withWrapperPool(historical + historical), /expected one wrapperFor/);
  assert.throws(() => withWrapperPool(current + '\nconst wrappers = new Map();'), /found 2/);
});

test('benchmark resolution supports frozen old and new layouts without modifying them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tabernacle-source-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(sourceFile(root, 'treeIndex'), /Unsupported source layout/);
  await assert.rejects(sourceFile(root, 'unknown'), /Unknown source module/);
  await mkdir(join(root, 'extension/src'), { recursive: true });
  await writeFile(join(root, 'extension/src/tree-index.js'), 'old index');
  await writeFile(join(root, 'extension/src/sidebar.js'), 'old rows');
  assert.equal(await sourceFile(root, 'treeIndex'), join(root, 'extension/src/tree-index.js'));
  assert.equal(await sourceFile(root, 'rows'), join(root, 'extension/src/sidebar.js'));
  await mkdir(join(root, 'extension/src/tree'));
  await mkdir(join(root, 'extension/src/sidebar'));
  await writeFile(join(root, 'extension/src/tree/index.js'), 'new index');
  await writeFile(join(root, 'extension/src/sidebar/rows.js'), 'new rows');
  assert.equal(await sourceFile(root, 'treeIndex'), join(root, 'extension/src/tree/index.js'));
  assert.equal(await sourceFile(root, 'rows'), join(root, 'extension/src/sidebar/rows.js'));
});
