import { createFolderIndex } from '../folder-index.js';
import { matchesText } from '../tab-source.js';
import { isSavedForLater, sortTabs, unpinnedTabTree } from '../model.js';

function indexTabs(tabs) {
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

// Build the summaries together. Filtering and individual row updates then use
// constant-time lookups instead of repeatedly walking whole subtrees.
export function createTreeIndex(state, query = '') {
  state = { ...state, tabs: state.tabs.filter((tab) => !isSavedForLater(tab)) };
  const tabs = unpinnedTabTree(state.tabs);
  const visible = indexTabs(tabs);
  const all = indexTabs(state.tabs);
  const tabStats = new Map(
    tabs.map((tab) => [
      tab.id,
      {
        descendants: 0,
        active: Boolean(tab.active),
        match: Boolean(query) && matchesText(tab, query),
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
  const folders = createFolderIndex(state);
  const groups = folders.byId;
  const groupChildren = folders.children;
  const groupStats = new Map();
  for (const group of state.groups) {
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
  for (const group of folders.order.slice().reverse()) {
    const parent = groupStats.get(folders.parents.get(group.id));
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
    folders,
    groupChildren,
    tabStats,
    groupStats,
    audio,
  };
}

// The caller verifies unchanged topology and supplies the previous playing state.
// Validate every path and count before publishing any summary changes.
export function updateTreeAudio(index, changes) {
  const tabs = new Map();
  const groups = new Map();

  const add = (map, id, delta) => map.set(id, (map.get(id) || 0) + delta);

  for (const { tab, wasPlaying } of changes) {
    if (isSavedForLater(tab)) continue;
    if (typeof wasPlaying !== 'boolean' || !index.audio.has(tab.id)) return null;
    const delta = Number(Boolean(tab.audible && !tab.mutedInfo?.muted)) - Number(wasPlaying);
    if (!delta) continue;
    let id = tab.id;
    const visitedTabs = new Set();
    while (id != null && index.audio.has(id)) {
      if (visitedTabs.has(id) || !index.byId.has(id)) return null;
      visitedTabs.add(id);
      add(tabs, id, delta);
      id = index.byId.get(id).parentTabId;
    }
    if (id != null && index.byId.has(id) && !isSavedForLater(index.byId.get(id))) return null;
    id = tab.groupId;
    const visitedGroups = new Set();
    while (id != null && index.groupStats.has(id)) {
      if (visitedGroups.has(id)) return null;
      visitedGroups.add(id);
      add(groups, id, delta);
      id = index.folders.parents.get(id);
    }
    if (id != null && index.groups.has(id)) return null;
  }
  for (const [id, delta] of tabs) {
    const count = index.audio.get(id) + delta;
    if (!Number.isInteger(count) || count < 0 || count > index.audio.size) return null;
  }
  for (const [id, delta] of groups) {
    const count = index.groupStats.get(id).audio + delta;
    if (!Number.isInteger(count) || count < 0 || count > index.audio.size) return null;
  }
  const affected = { tabs: new Set(), groups: new Set() };
  for (const [id, delta] of tabs) {
    if (!delta) continue;
    index.audio.set(id, index.audio.get(id) + delta);
    affected.tabs.add(id);
  }
  for (const [id, delta] of groups) {
    if (!delta) continue;
    index.groupStats.get(id).audio += delta;
    affected.groups.add(id);
  }
  return affected;
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
