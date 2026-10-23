import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentSource(source) {
  return (
    replaceSource(
      source,
      'function domain(url) {',
      'function domain(url) { window.faviconDomainCalls = (window.faviconDomainCalls || 0) + 1;',
    ) +
    '\nwindow.faviconLookupTest = (next) => { state = { ...next, newTab: normalizeNewTab(next.newTab) }; draft = undefined; window.faviconDomainCalls = 0; render(); return window.faviconDomainCalls; };'
  );
}
