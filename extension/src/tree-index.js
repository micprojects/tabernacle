import { sortTabs, unpinnedTabTree } from './model.js';

export function indexTabs(tabs) {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const children = new Map();
  for (const tab of sortTabs(tabs)) {
    const parent = byId.has(tab.parentTabId) ? tab.parentTabId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(tab);
  }
  return { byId, children };
}

// Iterative traversal avoids a stack limit for long chains of opener tabs.
function descendantsFirst(roots, children) {
  const order = [];
  const pending = [...roots];
  const seen = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    order.push(node);
    pending.push(...(children.get(node.id) || []));
  }
  return order.reverse();
}

// All summaries are built once per render. Filtering and individual row updates
// then use constant-time lookups instead of repeatedly walking whole subtrees.
export function createTreeIndex(state, query = '') {
  const tabs = unpinnedTabTree(state.tabs);
  const visible = indexTabs(tabs);
  const all = indexTabs(state.tabs);
  const tabStats = new Map(
    tabs.map((tab) => [
      tab.id,
      {
        descendants: 0,
        active: Boolean(tab.active),
        match:
          Boolean(query) && `${tab.title || ''} ${tab.url || ''}`.toLowerCase().includes(query),
        descendantMatch: false,
      },
    ]),
  );
  for (const tab of descendantsFirst(visible.children.get(null) || [], visible.children)) {
    const parent = tabStats.get(tab.parentTabId);
    if (!parent) continue;
    const stats = tabStats.get(tab.id);
    parent.descendants += stats.descendants + 1;
    parent.active ||= stats.active;
    parent.descendantMatch ||= stats.match || stats.descendantMatch;
  }
  const audio = new Map(
    state.tabs.map((tab) => [tab.id, Number(Boolean(tab.audible && !tab.mutedInfo?.muted))]),
  );
  for (const tab of descendantsFirst(all.children.get(null) || [], all.children)) {
    if (all.byId.has(tab.parentTabId))
      audio.set(tab.parentTabId, audio.get(tab.parentTabId) + audio.get(tab.id));
  }
  const groups = new Map(state.groups.map((group) => [group.id, group]));
  const groupChildren = new Map();
  const groupStats = new Map();
  for (const group of state.groups) {
    const parent = groups.has(group.parentId) ? group.parentId : null;
    if (!groupChildren.has(parent)) groupChildren.set(parent, []);
    groupChildren.get(parent).push(group);
    groupStats.set(group.id, {
      count: 0,
      audio: 0,
      match: Boolean(query) && group.name.toLowerCase().includes(query),
    });
  }
  const roots = new Map();
  for (const tab of tabs) {
    const stats = groupStats.get(tab.groupId);
    if (stats) {
      stats.count++;
      stats.match ||= tabStats.get(tab.id).match;
    }
  }
  for (const tab of visible.children.get(null) || []) {
    if (!roots.has(tab.groupId)) roots.set(tab.groupId, []);
    roots.get(tab.groupId).push(tab);
  }
  for (const tab of state.tabs) {
    const stats = groupStats.get(tab.groupId);
    if (stats && tab.audible && !tab.mutedInfo?.muted) stats.audio++;
  }
  for (const group of descendantsFirst(groupChildren.get(null) || [], groupChildren)) {
    const parent = groupStats.get(group.parentId);
    if (!parent) continue;
    const stats = groupStats.get(group.id);
    parent.count += stats.count;
    parent.audio += stats.audio;
    parent.match ||= stats.match;
  }
  return {
    tabs,
    byId: all.byId,
    children: visible.children,
    roots,
    groups,
    groupChildren,
    tabStats,
    groupStats,
    audio,
  };
}

// Include hidden descendants in bulk changes, but choose the next action from
// the visible roots: an open branch inside a closed group is already folded away.
export function scopeBranches(index, { scopeId, collapsed }) {
  const groupIds = new Set();
  const roots = index.groupChildren.get(scopeId) || [];
  const pending = [...roots];
  while (pending.length) {
    const group = pending.pop();
    if (group.id === scopeId || groupIds.has(group.id)) continue;
    groupIds.add(group.id);
    pending.push(...(index.groupChildren.get(group.id) || []));
  }
  const tabs = index.tabs.filter(
    (tab) =>
      (tab.groupId === scopeId || groupIds.has(tab.groupId)) && index.children.get(tab.id)?.length,
  );
  const closed = new Set(collapsed);
  const expanded =
    roots.some((group) => !closed.has(group.id)) ||
    (index.roots.get(scopeId) || []).some(
      (tab) => index.children.get(tab.id)?.length && !tab.collapsed,
    );
  return { groupIds, tabs, expanded };
}
