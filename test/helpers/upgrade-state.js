// Compare organisation while excluding volatile browser metadata and unrelated
// test-driver tabs. Keep native IDs too: an add-on update must not recreate tabs.
export function upgradeOrganisation(snapshots, treeIds) {
  const included = new Set(treeIds);
  return snapshots.map((state) => {
    const byId = new Map(state.tabs.map((tab) => [tab.id, tab.treeId]));
    const tabs = state.tabs.filter((tab) => included.has(tab.treeId));
    return {
      groups: state.groups,
      folderPins: state.folderPins,
      look: state.look,
      view: state.view,
      pins: state.pins.filter((item) => item.kind === 'group' || included.has(item.id)),
      nativeOrder: [...tabs].sort((a, b) => a.index - b.index).map((tab) => tab.treeId),
      tabs: tabs
        .map((tab) => ({
          id: tab.id,
          windowId: tab.windowId,
          treeId: tab.treeId,
          groupId: tab.groupId,
          ancestors: tab.ancestors,
          parentTreeId: byId.get(tab.parentTabId) ?? null,
          order: tab.order,
          collapsed: tab.collapsed,
          cookieStoreId: tab.cookieStoreId,
          pinned: tab.pinned,
          muted: Boolean(tab.mutedInfo?.muted),
          url: tab.url,
        }))
        .sort((a, b) => a.treeId.localeCompare(b.treeId)),
    };
  });
}
