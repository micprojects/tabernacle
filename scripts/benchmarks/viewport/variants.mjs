import assert from 'node:assert/strict';

// Diagnostic-only source adaptation. The frozen copy is modified, never the
// working extension. Keep rejected experiments reproducible without shipping them.
export function withWrapperPool(source) {
  const replace = (before, after) => {
    assert(
      source.includes(before) && source.indexOf(before) === source.lastIndexOf(before),
      `Missing or ambiguous wrapper-pool adaptation: ${before}`,
    );
    source = source.replace(before, after);
  };

  replace(
    'const wrappers = new Map();',
    'const wrappers = new Map();\nconst spareTabWrappers = [];',
  );
  replace(
    '  usedWrappers.add(key);',
    `  usedWrappers.add(key);
  if (!wrappers.has(key) && treeRenderer.virtual && kind === 'tab' && !needsBranch && spareTabWrappers.length)
    wrappers.set(key, spareTabWrappers.pop());`,
  );
  replace(
    'if (!usedWrappers.has(key) && !treeMotion.owns(wrapper.node)) wrappers.delete(key);',
    `if (!usedWrappers.has(key) && !treeMotion.owns(wrapper.node)) {
      wrappers.delete(key);
      if (treeRenderer.virtual && !wrapper.branch && !wrapper.node.isConnected && spareTabWrappers.length < 64) {
        wrapper.node.replaceChildren();
        wrapper.node.removeAttribute('style');
        spareTabWrappers.push(wrapper);
      }
    }`,
  );
  replace('  wrappers.clear();', '  wrappers.clear();\n  spareTabWrappers.length = 0;');
  return source;
}
