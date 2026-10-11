// The page experiment deliberately does not import the slide-up panel's helpers.
import { groupPath, isWithin } from './model.js';

export const activityKinds = {
  viewed: { label: 'Viewed tabs', event: 'Viewed', action: 'Switch to tab', icon: 'globe' },
  closed: { label: 'Closed tabs', event: 'Closed', action: 'Reopen tab', icon: 'undo' },
  folder: { label: 'Folders', event: 'Entered', action: 'Enter folder', icon: 'group' },
};

function domain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function activityItems(state, { folderEvent = 'all', pageUrl = '' } = {}) {
  const items = [];
  const isPage = (url) => pageUrl && url?.split(/[?#]/)[0] === pageUrl;
  for (const tab of state.tabs ?? []) {
    if (tab.incognito || !(tab.lastAccessed > 0) || isPage(tab.url)) continue;
    items.push({
      ...tab,
      key: `viewed:${tab.id}`,
      kind: 'viewed',
      timestamp: tab.lastAccessed,
      title: tab.title || tab.url || 'New tab',
      detail: domain(tab.url),
      path: groupPath(state, tab.groupId)
        .map((group) => group.name)
        .join(' / '),
    });
  }
  for (const tab of state.recentlyClosed ?? []) {
    if (tab.incognito || isPage(tab.url)) continue;
    items.push({
      ...tab,
      key: `closed:${tab.sessionId}`,
      kind: 'closed',
      timestamp: tab.closedAt || 0,
      title: tab.title || tab.url || 'New tab',
      detail: domain(tab.url),
    });
  }
  const entered = new Map(
    (state.view?.recentFolders ?? []).map((entry) => [entry.id, entry.enteredAt]),
  );
  const expanded = new Map(
    (state.view?.recentExpandedFolders ?? []).map((entry) => [entry.id, entry.expandedAt]),
  );
  for (const group of state.groups) {
    const enteredAt = entered.get(group.id) || 0;
    const expandedAt = expanded.get(group.id) || 0;
    const timestamp =
      folderEvent === 'entered'
        ? enteredAt
        : folderEvent === 'expanded'
          ? expandedAt
          : Math.max(enteredAt, expandedAt);
    if (!timestamp) continue;
    const event =
      folderEvent === 'all'
        ? expandedAt > enteredAt
          ? 'Expanded'
          : 'Entered'
        : folderEvent === 'expanded'
          ? 'Expanded'
          : 'Entered';
    items.push({
      key: `folder:${group.id}`,
      id: group.id,
      kind: 'folder',
      title: group.name,
      detail:
        groupPath(state, group.parentId)
          .map((parent) => parent.name)
          .join(' / ') || 'Top level',
      timestamp,
      enteredAt,
      expandedAt,
      event,
      tabCount: (state.tabs ?? []).filter(
        (tab) => !tab.incognito && !isPage(tab.url) && isWithin(state, tab.groupId, group.id),
      ).length,
    });
  }
  return items.sort((a, b) => b.timestamp - a.timestamp || a.key.localeCompare(b.key));
}

export function filterActivity(
  items,
  { kind = 'all', query = '', period = 'all', now = Date.now() } = {},
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  if (period === 'yesterday') start.setDate(start.getDate() - 1);
  if (period === 'week') start.setDate(start.getDate() - 6);
  return items.filter((item) => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (period !== 'all' && item.timestamp < start.getTime()) return false;
    if (period === 'yesterday' && item.timestamp >= today.getTime()) return false;
    const text =
      `${item.title} ${item.detail} ${item.path || ''} ${item.url || ''}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function activityDay(timestamp, now = Date.now()) {
  if (!timestamp) return 'Earlier';
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (timestamp >= today.getTime()) return 'Today';
  if (timestamp >= yesterday.getTime()) return 'Yesterday';
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    ...(new Date(timestamp).getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function activityTime(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  if (!minutes) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
