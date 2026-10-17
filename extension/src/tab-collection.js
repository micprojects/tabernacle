import { isSavedForLater, isWithin } from './model.js';
import { matchesDomain } from './domain-filter.js';
import { createTreeIndex } from './tree-index.js';
import { sourceUrl, matchesText, httpUrl } from './tab-source.js';
import { laterResults } from './later.js';

export { sourceUrl, matchesText };

export function savedSearchResults(state, query, scopeId = state.view.scopeId) {
  if (!query.trim()) return [];
  return state.tabs
    .filter(
      (tab) =>
        isSavedForLater(tab) && isWithin(state, tab.groupId, scopeId) && matchesText(tab, query),
    )
    .sort((a, b) => b.savedForLaterAt - a.savedForLaterAt || a.index - b.index);
}

export function viewedAge(time, now = Date.now()) {
  if (!Number.isFinite(time) || time <= 0) return '';
  const days = Math.floor(Math.max(0, now - time) / 86_400_000);
  return days === 0 ? 'Viewed today' : `Last viewed ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function searchTabOrder(state, query, scopeId = state.view.scopeId) {
  const text = query.trim().toLowerCase();
  const index = createTreeIndex(state, text);
  const order = [];
  const pending = [{ groupId: scopeId, match: !text }];
  while (pending.length) {
    const item = pending.pop();
    if (item.tab) {
      const stats = index.tabStats.get(item.tab.id);
      if (!item.match && !stats.match && !stats.descendantMatch) continue;
      order.push(item.tab.id);
      for (const tab of [...(index.children.get(item.tab.id) || [])].reverse())
        pending.push({ tab, match: item.match || stats.match });
    } else {
      for (const tab of [...(index.roots.get(item.groupId) || [])].reverse())
        pending.push({ tab, match: item.match });
      for (const group of [...(index.groupChildren.get(item.groupId) || [])].reverse())
        if (item.match || index.groupStats.get(group.id)?.match)
          pending.push({
            groupId: group.id,
            match: item.match || group.name.toLowerCase().includes(text),
          });
    }
  }
  return [...order, ...savedSearchResults(state, query, scopeId).map((tab) => tab.id)];
}

export function folderCollection(state, scopeId) {
  const tabs = state.tabs.filter((tab) => isWithin(state, tab.groupId, scopeId));
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  return [
    ...tabs.filter((tab) => tab.pinned && !isSavedForLater(tab)).sort((a, b) => a.index - b.index),
    ...searchTabOrder(state, '', scopeId)
      .map((id) => byId.get(id))
      .filter(Boolean),
    ...tabs.filter(isSavedForLater).sort((a, b) => b.savedForLaterAt - a.savedForLaterAt),
  ];
}

export function captureTarget(tab) {
  return {
    id: tab.id,
    treeId: tab.treeId,
    url: sourceUrl(tab),
    groupId: tab.groupId,
    cookieStoreId: tab.cookieStoreId || 'firefox-default',
    savedForLaterAt: tab.savedForLaterAt || null,
  };
}

export function matchesTarget(tab, target) {
  return Boolean(
    tab &&
    target &&
    Object.entries(captureTarget(tab)).every(([key, value]) => value === target[key]),
  );
}

export function inCollection(state, tab, scope) {
  if (scope?.kind === 'window') return true;
  if (scope?.kind === 'folder')
    return (
      (scope.id === null || state.groups.some((group) => group.id === scope.id)) &&
      isWithin(state, tab.groupId, scope.id)
    );
  if (scope?.kind === 'domain')
    return !isSavedForLater(tab) && matchesDomain(tab, scope.domain, scope.query || '');
  if (scope?.kind === 'later') return laterResults([tab], scope).length === 1;
  return false;
}

export function duplicateKey(tab) {
  const url = httpUrl(tab.url);
  return url ? JSON.stringify([url, tab.cookieStoreId || 'firefox-default']) : null;
}

export function duplicateGroups(tabs) {
  const groups = new Map();
  for (const tab of tabs) {
    const key = duplicateKey(tab);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }
  return [...groups.values()].filter((tabs) => tabs.length > 1);
}

export function suggestedDuplicates(tabs) {
  const protectedTabs = tabs.filter((tab) => tab.pinned || tab.active || tab.audible);
  const keep = new Set(protectedTabs.map((tab) => tab.id));
  if (!keep.size) {
    const dated = (tab) =>
      Number.isFinite(tab.lastAccessed) && tab.lastAccessed > 0 ? tab.lastAccessed : 0;
    const first = [...tabs].sort((a, b) => dated(b) - dated(a) || a.index - b.index)[0];
    if (first) keep.add(first.id);
  }
  return tabs.filter((tab) => !keep.has(tab.id)).map((tab) => tab.id);
}
