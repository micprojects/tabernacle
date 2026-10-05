import { normalizeLook } from './look.js';

// Storage namespace for the tabernacle@michaelprojects.com add-on identity.
export const MODEL_KEY = 'tabernacle.model.v1';
export const TAB_KEY = 'tabernacle.membership.v1';
export const VIEW_KEY = 'tabernacle.view.v1';

export function emptyModel() {
  return {
    version: 1,
    groups: [],
    look: normalizeLook(),
  };
}

export function groupById(model, id) {
  return model.groups.find((group) => group.id === id);
}

export function requireGroup(model, id) {
  if (id !== null && !groupById(model, id)) throw new Error('That folder no longer exists.');
  return id;
}

export function groupPath(model, id) {
  const result = [];
  const visited = new Set();
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    const group = groupById(model, id);
    if (!group) break;
    result.unshift(group);
    id = group.parentId;
  }
  return result;
}

// Missing/null settings inherit; firefox-default explicitly stops inheritance.
export function groupContainer(model, id) {
  return groupPath(model, id)
    .reverse()
    .find((group) => group.defaultCookieStoreId != null)?.defaultCookieStoreId;
}

export function isWithin(model, groupId, scopeId) {
  return scopeId === null || groupPath(model, groupId).some((group) => group.id === scopeId);
}

export function children(model, parentId) {
  return model.groups.filter((group) => group.parentId === parentId);
}

export function cleanName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('Give your folder a name.');
  if (name.length > 80) throw new Error('Use a name of 80 characters or fewer.');
  return name;
}

export function addGroup(model, name, parentId = null, id = crypto.randomUUID()) {
  requireGroup(model, parentId);
  const group = { id, name: cleanName(name), parentId };
  model.groups.push(group);
  return group;
}

export function moveGroup(model, id, parentId, beforeId = null) {
  const group = groupById(model, requireGroup(model, id));
  if (!group) throw new Error('Choose a folder to move.');
  requireGroup(model, parentId);
  if (isWithin(model, parentId, id))
    throw new Error('A folder cannot go inside itself or one of its subfolders.');
  if (beforeId === id) return;
  if (beforeId && groupById(model, beforeId)?.parentId !== parentId)
    throw new Error('The destination has changed. Try again.');
  model.groups = model.groups.filter((item) => item.id !== id);
  group.parentId = parentId;
  const index = beforeId
    ? model.groups.findIndex((item) => item.id === beforeId)
    : model.groups.length;
  model.groups.splice(index, 0, group);
}

// Remove the complete subtree after the controller has closed its tabs.
export function removeGroup(model, id) {
  const group = groupById(model, requireGroup(model, id));
  if (!group) throw new Error('Choose a folder to remove.');
  model.groups = model.groups.filter((item) => !isWithin(model, item.id, id));
  return group.parentId;
}

export function normalizeView(model, view = {}) {
  view ??= {};
  return {
    scopeId: groupById(model, view.scopeId) ? view.scopeId : null,
    collapsed: Array.isArray(view.collapsed)
      ? view.collapsed.filter((id) => groupById(model, id))
      : [],
  };
}

export function sortTabs(tabs) {
  return [...tabs].sort((a, b) => (a.order ?? a.index) - (b.order ?? b.index) || a.index - b.index);
}

// Leave room between neighbours; return null only when floating-point precision
// is exhausted (or old orders are tied), so the caller can rebalance that list.
export function insertionOrder(siblings, index) {
  const before = siblings[index - 1];
  const after = siblings[index];
  const low = before ? (before.order ?? before.index) : null;
  const high = after ? (after.order ?? after.index) : null;
  const order =
    low === null
      ? high === null
        ? 0
        : high - 1024
      : high === null
        ? low + 1024
        : low / 2 + high / 2;
  return Number.isFinite(order) && (low === null || order > low) && (high === null || order < high)
    ? order
    : null;
}

// Saved ancestry uses durable keys, never Firefox's session-local numeric IDs.
// Missing parents are skipped without deleting the saved relationship: closing a
// parent promotes its children, and restoring it reconnects them, in either order.
export function resolveTabTree(tabs) {
  const byKey = new Map(tabs.map((tab) => [tab.treeId, tab]));
  const parents = new Map();
  for (const tab of tabs) {
    let parent;
    for (const key of tab.ancestors) {
      const candidate = byKey.get(key);
      if (
        candidate &&
        candidate.id !== tab.id &&
        candidate.windowId === tab.windowId &&
        candidate.groupId === tab.groupId
      ) {
        parent = candidate;
        break;
      }
    }
    parents.set(tab.id, parent?.id ?? null);
  }
  // Defend against corrupt/old session data so every tab still has a visible root.
  const finished = new Set();
  for (const tab of tabs) {
    const seen = new Set();
    let id = tab.id;
    while (id != null && !finished.has(id)) {
      if (seen.has(id)) {
        parents.set(id, null);
        break;
      }
      seen.add(id);
      id = parents.get(id);
    }
    for (const id of seen) finished.add(id);
  }
  return tabs.map((tab) => ({ ...tab, parentTabId: parents.get(tab.id) }));
}

export function tabChildren(tabs, parentTabId) {
  return sortTabs(tabs.filter((tab) => tab.parentTabId === parentTabId));
}

// Pins live in a separate strip. Keep their children accessible in the list,
// without rewriting the saved tree: unpinning restores the original placement.
export function unpinnedTabTree(tabs) {
  const pinned = new Set(tabs.filter((tab) => tab.pinned).map((tab) => tab.id));
  return tabs
    .filter((tab) => !tab.pinned)
    .map((tab) => ({
      ...tab,
      parentTabId: pinned.has(tab.parentTabId) ? null : tab.parentTabId,
    }));
}

export function tabAncestors(tabs, id) {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const result = [];
  const seen = new Set([id]);
  let parent = byId.get(byId.get(id)?.parentTabId);
  while (parent && !seen.has(parent.id)) {
    result.push(parent);
    seen.add(parent.id);
    parent = byId.get(parent.parentTabId);
  }
  return result;
}

export function tabSubtree(tabs, id) {
  const root = tabs.find((tab) => tab.id === id);
  const children = new Map();
  for (const tab of sortTabs(tabs)) {
    if (!children.has(tab.parentTabId)) children.set(tab.parentTabId, []);
    children.get(tab.parentTabId).push(tab);
  }
  const result = [];
  const pending = root ? [root] : [];
  const seen = new Set();
  while (pending.length) {
    const tab = pending.pop();
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    result.push(tab);
    const descendants = children.get(tab.id) || [];
    for (let i = descendants.length - 1; i >= 0; i--) pending.push(descendants[i]);
  }
  return result;
}
