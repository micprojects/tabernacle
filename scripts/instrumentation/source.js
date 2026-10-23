import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

// Adapt only served test responses or frozen diagnostic sources. An outdated
// probe must fail instead of silently measuring an uninstrumented workload.
export function replaceSource(source, before, after, expected = 1) {
  if (typeof before !== 'string' || !before.length || !Number.isInteger(expected) || expected < 1)
    throw new TypeError('A nonempty source anchor and positive match count are required');
  const count = source.split(before).length - 1;
  if (count !== expected)
    throw new Error(`Expected ${expected} source match(es), found ${count}: ${before}`);
  return source.split(before).join(after);
}

const layouts = {
  treeIndex: ['extension/src/tree/index.js', 'extension/src/tree-index.js'],
  rows: ['extension/src/sidebar/rows.js', 'extension/src/sidebar.js'],
};

export async function sourceFile(root, name) {
  const candidates = layouts[name];
  if (!candidates) throw new Error(`Unknown source module: ${name}`);
  for (const file of candidates) {
    const target = resolve(root, file);
    try {
      await access(target);
      return target;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Unsupported source layout: missing ${name} (${candidates.join(', ')})`);
}
