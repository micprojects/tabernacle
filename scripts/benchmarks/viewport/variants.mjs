import { replaceSource } from '../../instrumentation/source.js';

// Diagnostic-only source adaptation. The frozen copy is modified, never the
// working extension. Keep rejected experiments reproducible without shipping them.
export function withWrapperPool(source) {
  const renderer = source.includes('export function createSidebarRows(')
    ? 'getTreeRenderer()'
    : 'treeRenderer';
  const wrapperStart = [
    ...source.matchAll(
      /function wrapperFor\(kind, id, needsBranch = true(?:, recyclable = false)?\) \{\n +const key = `\$\{kind\}:\$\{id\}`;\n +usedWrappers.add\(key\);/g,
    ),
  ];
  if (wrapperStart.length !== 1)
    throw new Error('Unsupported wrapper-pool instrumentation layout: expected one wrapperFor');

  const replace = (before, after) => {
    source = replaceSource(source, before, after);
  };

  replace(
    'const wrappers = new Map();',
    'const wrappers = new Map();\nconst spareTabWrappers = [];',
  );
  replace(
    wrapperStart[0][0],
    `${wrapperStart[0][0]}
  if (!wrappers.has(key) && ${renderer}.virtual && kind === 'tab' && !needsBranch && spareTabWrappers.length)
    wrappers.set(key, spareTabWrappers.pop());`,
  );
  replace(
    'if (!usedWrappers.has(key) && !treeMotion.owns(wrapper.node)) wrappers.delete(key);',
    `if (!usedWrappers.has(key) && !treeMotion.owns(wrapper.node)) {
      wrappers.delete(key);
      if (${renderer}.virtual && !wrapper.branch && !wrapper.node.isConnected && spareTabWrappers.length < 64) {
        wrapper.node.replaceChildren();
        wrapper.node.removeAttribute('style');
        spareTabWrappers.push(wrapper);
      }
    }`,
  );
  replace('  wrappers.clear();', '  wrappers.clear();\n  spareTabWrappers.length = 0;');
  return source;
}
