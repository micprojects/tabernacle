import { createFolderIndex } from './folder-index.js';
import { activityEntries } from './recent-history.js';

export const activityKinds = {
  viewed: { label: 'Viewed tabs', event: 'Viewed', action: 'Switch to tab', icon: 'globe' },
  closed: { label: 'Closed tabs', event: 'Closed', action: 'Reopen tab', icon: 'undo' },
  folder: { label: 'Folders', event: 'Opened', action: 'Open folder', icon: 'group' },
};

export function activityItems(state, { folderEvent = 'all', pageUrl = '' } = {}) {
  const isPage = (url) => pageUrl && url?.split(/[?#]/)[0] === pageUrl;
  const folders = createFolderIndex(state);
  const counts = new Map();
  for (const tab of state.tabs ?? [])
    if (!tab.incognito && !isPage(tab.url))
      counts.set(tab.groupId, (counts.get(tab.groupId) || 0) + 1);
  for (const group of folders.order.slice().reverse()) {
    const parent = folders.parents.get(group.id);
    counts.set(parent, (counts.get(parent) || 0) + (counts.get(group.id) || 0));
  }
  const paths = new Map();

  const path = (id) => {
    if (!paths.has(id))
      paths.set(
        id,
        folders
          .path(id)
          .map((group) => group.name)
          .join(' / '),
      );
    return paths.get(id);
  };

  const items = activityEntries(state, { folderEvent, pageUrl });
  // activityEntries creates these records for this call; enrich them in place.
  for (const item of items) {
    if (item.kind === 'folder') {
      item.detail ||= 'Top level';
      item.tabCount = counts.get(item.id) || 0;
    } else {
      item.detail = item.detail.replace(/^www\./, '');
      if (item.kind === 'viewed') item.path = path(item.groupId);
    }
  }
  return items;
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
