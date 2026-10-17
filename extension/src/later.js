import { isSavedForLater } from './model.js';
import { matchesText } from './tab-source.js';

export function laterResults(tabs, { query = '', sort = 'newest', tabIds } = {}) {
  const included = Array.isArray(tabIds) ? new Set(tabIds) : null;
  return tabs
    .filter(
      (tab) => isSavedForLater(tab) && (included ? included.has(tab.id) : matchesText(tab, query)),
    )
    .sort(
      (a, b) =>
        (a.savedForLaterAt - b.savedForLaterAt) * (sort === 'oldest' ? 1 : -1) ||
        (a.index ?? 0) - (b.index ?? 0) ||
        a.id - b.id,
    );
}
