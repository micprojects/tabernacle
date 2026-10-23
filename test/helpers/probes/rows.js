import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentRows(source) {
  return replaceSource(
    replaceSource(
      source,
      'function createTabRow(tab, expanded, stats) {',
      'function createTabRow(tab, expanded, stats) { window.viewportTabBuilds = (window.viewportTabBuilds || 0) + 1;',
    ),
    '  return {\n    prepareViewportRows,',
    `  window.sidebarRowsProbe = (keys = []) => ({
      wrappers: wrappers.size, pooled: leafPool.length, keys: keys.filter(key => rowCache.has(key)),
    });
  return {
    prepareViewportRows,`,
  );
}
