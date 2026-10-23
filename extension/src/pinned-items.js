export const pinActionLabels = { open: 'Open folder', reveal: 'Show in tree' };

export const pinKey = (item) => `${item.kind}:${item.id}`;

export function normalizeFolderPins(groups, value) {
  const valid = new Set(groups.map((group) => group.id));
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    if (!valid.has(item?.id) || seen.has(item.id)) return [];
    seen.add(item.id);
    return [
      { id: item.id, action: Object.hasOwn(pinActionLabels, item.action) ? item.action : 'open' },
    ];
  });
}

export function normalizePinLayout(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    if (!item || !['group', 'tab'].includes(item.kind) || typeof item.id !== 'string' || !item.id)
      return [];
    const key = pinKey(item);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ kind: item.kind, id: item.id }];
  });
}

// The slots belong to the window; each kind's order has its own authority.
// Keep absent tab identities in saved slots until a close/detach is observed:
// Firefox may restore a window's session values before all its tabs arrive.
export function reconcilePins(saved, folders, tabs, forgotten = new Set()) {
  const groups = folders.map(({ id }) => ({ kind: 'group', id }));
  const pinned = tabs.filter((tab) => tab.pinned).sort((a, b) => a.index - b.index);
  const tabItems = pinned.map((tab) => ({ kind: 'tab', id: tab.treeId }));
  const groupIds = new Set(groups.map((item) => item.id));
  const tabIds = new Set(tabItems.map((item) => item.id));
  const savedLayout = normalizePinLayout(saved);
  // Only saved tab slots need unpinned identities. Ordinary tab-only snapshots
  // otherwise allocate a set containing almost every open tab on each read.
  const unpinned = savedLayout.some((item) => item.kind === 'tab')
    ? new Set(tabs.filter((tab) => !tab.pinned).map((tab) => tab.treeId))
    : null;
  const layout = savedLayout.filter((item) =>
    item.kind === 'group'
      ? groupIds.has(item.id)
      : !unpinned.has(item.id) && !forgotten.has(item.id),
  );
  const existing = new Set(layout.map(pinKey));
  for (const item of [...tabItems, ...groups]) if (!existing.has(pinKey(item))) layout.push(item);
  let groupIndex = 0,
    tabIndex = 0;
  const ordered = layout.map((item) =>
    item.kind === 'group'
      ? groups[groupIndex++]
      : tabIds.has(item.id)
        ? tabItems[tabIndex++]
        : item,
  );
  return {
    layout: ordered,
    items: ordered.filter((item) => item.kind === 'group' || tabIds.has(item.id)),
  };
}

export function movePin(items, source, before = null) {
  const key = pinKey(source ?? {});
  if (!items.some((item) => pinKey(item) === key))
    throw new Error('That item is no longer pinned.');
  if (before != null && !items.some((item) => pinKey(item) === pinKey(before)))
    throw new Error('The destination pin has moved or closed.');
  if (before && pinKey(before) === key) return items;
  const result = items.filter((item) => pinKey(item) !== key);
  const position =
    before == null ? result.length : result.findIndex((item) => pinKey(item) === pinKey(before));
  result.splice(
    position,
    0,
    items.find((item) => pinKey(item) === key),
  );
  return result;
}
