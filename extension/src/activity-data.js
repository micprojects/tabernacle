import { groupPath, isWithin } from './model.js';
import { activityEntries } from './recent-history.js';

export const activityKinds = {
  viewed: { label: 'Viewed tabs', event: 'Viewed', action: 'Switch to tab', icon: 'globe' },
  closed: { label: 'Closed tabs', event: 'Closed', action: 'Reopen tab', icon: 'undo' },
  folder: { label: 'Folders', event: 'Opened', action: 'Open folder', icon: 'group' },
};

export function activityItems(state, { folderEvent = 'all', pageUrl = '' } = {}) {
  const isPage = (url) => pageUrl && url?.split(/[?#]/)[0] === pageUrl;
  return activityEntries(state, { folderEvent, pageUrl }).map((item) => {
    if (item.kind === 'folder')
      return {
        ...item,
        detail: item.detail || 'Top level',
        tabCount: (state.tabs ?? []).filter(
          (tab) => !tab.incognito && !isPage(tab.url) && isWithin(state, tab.groupId, item.id),
        ).length,
      };
    return {
      ...item,
      detail: item.detail.replace(/^www\./, ''),
      ...(item.kind === 'viewed'
        ? {
            path: groupPath(state, item.groupId)
              .map((group) => group.name)
              .join(' / '),
          }
        : {}),
    };
  });
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
