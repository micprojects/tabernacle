import { resolveTabTree, sortTabs, tabSubtree } from './model.js';

// Both the pending sidebar view and the durable close use the same promotion.
// This only computes changes; the controller owns their writes and recovery.
export function tabCloseUpdates(tabs, id) {
  const updates = new Map();
  if (!tabs.some((tab) => tab.parentTabId === id)) return updates;
  const [parent, first, ...rest] = tabSubtree(tabs, id);
  if (!first) return updates;
  const firstBranch = new Set(tabSubtree(tabs, first.id).map((tab) => tab.id));
  const descendants = [first, ...rest];
  let order = parent.order;
  // A shared preorder keeps both the promoted tree and an undone close in
  // the same visual order, even when the children were manually reordered.
  const fits = descendants.every(
    (_, index) =>
      Number.isFinite(order + index * 1024) &&
      (index === 0 || order + index * 1024 > order + (index - 1) * 1024),
  );
  if (!fits) {
    const peers = sortTabs(
      tabs.filter(
        (tab) => tab.groupId === parent.groupId && tab.parentTabId === parent.parentTabId,
      ),
    );
    for (const [index, tab] of peers.entries()) updates.set(tab.id, { order: index * 1024 });
    order = updates.get(id).order;
  }
  for (const [index, tab] of descendants.entries()) {
    const ancestors = [...tab.ancestors];
    // Keep the closed parent's key first: Undo reconnects its original children.
    if (!firstBranch.has(tab.id))
      ancestors.splice(ancestors.indexOf(parent.treeId) + 1, 0, first.treeId);
    updates.set(tab.id, { ancestors, order: order + index * 1024 });
  }
  return updates;
}

export function projectTabClose(tabs, { id, treeId }) {
  // A newer snapshot may already confirm removal, or contain a different owner.
  if (!tabs.some((tab) => tab.id === id && tab.treeId === treeId)) return tabs;
  const updates = tabCloseUpdates(tabs, id);
  const remaining = tabs.filter((tab) => tab.id !== id);
  return updates.size
    ? resolveTabTree(
        remaining.map((tab) => (updates.has(tab.id) ? { ...tab, ...updates.get(tab.id) } : tab)),
      )
    : remaining;
}
