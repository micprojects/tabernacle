import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentSource(source) {
  return (
    replaceSource(
      source,
      'createTreeIndex(state, query)',
      '(window.audioIndexBuilds = (window.audioIndexBuilds || 0) + 1, createTreeIndex(state, query))',
    ) +
    `
window.audioSync = refresh;
window.audioParity = () => {
  treeMotion.finishAll();
  const markup = () => ['tree', 'pinned-tabs', 'scope-heading'].map(id => document.getElementById(id)?.outerHTML);
  const before = JSON.stringify(markup());
  previousRender = null;
  render();
  if (JSON.stringify(markup()) !== before) throw new Error('Audio patch differs from full rendering');
};`
  );
}
