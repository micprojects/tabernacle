import { groupPath } from './model.js';

function domain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function recentItems(state, filter = 'all', query = '') {
  const items = [];
  if (filter === 'all' || filter === 'viewed')
    for (const tab of state.tabs ?? []) {
      if (tab.incognito || !Number.isFinite(tab.lastAccessed) || tab.lastAccessed <= 0) continue;
      items.push({
        ...tab,
        key: `viewed:${tab.id}`,
        kind: 'viewed',
        title: tab.title || tab.url || 'New tab',
        detail: domain(tab.url),
        timestamp: tab.lastAccessed,
      });
    }
  if (filter === 'all' || filter === 'folder') {
    const groups = new Map(state.groups.map((group) => [group.id, group]));
    for (const entry of state.view?.recentFolders ?? []) {
      const group = groups.get(entry.id);
      if (!group) continue;
      items.push({
        key: `folder:${group.id}`,
        kind: 'folder',
        id: group.id,
        title: group.name,
        detail: groupPath(state, group.parentId)
          .map((parent) => parent.name)
          .join(' / '),
        timestamp: entry.enteredAt,
      });
    }
  }
  if (filter === 'all' || filter === 'closed')
    for (const tab of state.recentlyClosed ?? [])
      items.push({
        ...tab,
        key: `closed:${tab.sessionId}`,
        kind: 'closed',
        detail: domain(tab.url),
        timestamp: tab.closedAt,
      });
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter((item) => {
      const text = `${item.title} ${item.detail} ${item.url ?? ''}`.toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function recentDay(timestamp, now = Date.now()) {
  if (!timestamp) return 'Earlier';
  const date = new Date(timestamp);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function recentTime(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}
