import { groupPath } from './model.js';

function domain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const validTime = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

// Both screens use the same event times and stable newest-first order. In
// particular, tied closed tabs retain Firefox's newest-first session order.
export function activityEntries(state, { kind = 'all', folderEvent = 'all', pageUrl = '' } = {}) {
  const items = [];
  const isPage = (url) => pageUrl && url?.split(/[?#]/)[0] === pageUrl;
  if (kind === 'all' || kind === 'viewed')
    for (const tab of state.tabs ?? []) {
      if (tab.incognito || !validTime(tab.lastAccessed) || isPage(tab.url)) continue;
      items.push({
        ...tab,
        key: `viewed:${tab.id}`,
        kind: 'viewed',
        title: tab.title || tab.url || 'New tab',
        detail: domain(tab.url),
        timestamp: tab.lastAccessed,
      });
    }
  if (kind === 'all' || kind === 'folder') {
    const groups = new Map(state.groups.map((group) => [group.id, group]));
    const entered = new Map(
      (state.view?.recentFolders ?? []).map(({ id, enteredAt }) => [id, enteredAt]),
    );
    const expanded = new Map(
      (state.view?.recentExpandedFolders ?? []).map(({ id, expandedAt }) => [id, expandedAt]),
    );
    // Merge the saved newest-first records before deduplicating. Sidebar order
    // and older visits must not reorder expansions that share a timestamp.
    const folders = [
      ...(folderEvent === 'expanded'
        ? []
        : [...entered].map(([id, time]) => ({ id, timestamp: validTime(time), event: 'Opened' }))),
      ...(folderEvent === 'entered'
        ? []
        : [...expanded].map(([id, time]) => ({
            id,
            timestamp: validTime(time),
            event: 'Expanded',
          }))),
    ].sort((a, b) => b.timestamp - a.timestamp);
    const seen = new Set();
    for (const { id, timestamp, event } of folders) {
      const group = groups.get(id);
      if (!group || !timestamp || seen.has(id)) continue;
      seen.add(id);
      items.push({
        key: `folder:${group.id}`,
        kind: 'folder',
        id: group.id,
        title: group.name,
        detail: groupPath(state, group.parentId)
          .map((parent) => parent.name)
          .join(' / '),
        timestamp,
        enteredAt: validTime(entered.get(id)),
        expandedAt: validTime(expanded.get(id)),
        event,
      });
    }
  }
  if (kind === 'all' || kind === 'closed')
    for (const tab of state.recentlyClosed ?? []) {
      if (tab.incognito || isPage(tab.url)) continue;
      items.push({
        ...tab,
        key: `closed:${tab.sessionId}`,
        kind: 'closed',
        title: tab.title || tab.url || 'New tab',
        detail: domain(tab.url),
        timestamp: validTime(tab.closedAt),
      });
    }
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

export function recentItems(state, filter = 'all', query = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return activityEntries(state, { kind: filter }).filter((item) => {
    const text = `${item.title} ${item.detail} ${item.url ?? ''}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

// Each category contributes at most the displayed count to the merged preview.
// Sort native references first so older tabs need no copied record or URL parsing.
export function recentPreviewItems(state, filter = 'all', limit = 50) {
  const newest = (items, field, requireTime) =>
    (items ?? [])
      .filter((item) => !item.incognito && (!requireTime || validTime(item[field])))
      .sort((a, b) => validTime(b[field]) - validTime(a[field]))
      .slice(0, limit);
  return recentItems(
    {
      ...state,
      tabs: filter === 'all' || filter === 'viewed' ? newest(state.tabs, 'lastAccessed', true) : [],
      recentlyClosed:
        filter === 'all' || filter === 'closed'
          ? newest(state.recentlyClosed, 'closedAt', false)
          : [],
    },
    filter,
  ).slice(0, limit);
}

export function recentTime(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}
