import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentRows(source) {
  source = replaceSource(
    source,
    'function createGroupRow(group, container) {',
    'function createGroupRow(group, container) { window.viewportGroupBuilds = (window.viewportGroupBuilds || 0) + 1;',
  );
  source = replaceSource(
    source,
    "const item = el('div', 'new-tab-item');",
    "const item = el('div', 'new-tab-item'); window.viewportCreationBuilds = (window.viewportCreationBuilds || 0) + 1;",
  );
  return replaceSource(
    replaceSource(
      source,
      'function createTabRow(tab, expanded, stats) {',
      'function createTabRow(tab, expanded, stats) { window.viewportTabBuilds = (window.viewportTabBuilds || 0) + 1;',
    ),
    '  return {\n    prepareViewportRows,',
    `  window.sidebarRowsProbe = (keys = []) => ({
      wrappers: wrappers.size, pooled: leafPool.length, keys: keys.filter(key => rowCache.has(key)),
      totalPooled: pooledCount(),
    });
  return {
    prepareViewportRows,`,
  );
}
