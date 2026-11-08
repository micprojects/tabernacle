// Firefox owns bookmark identities, hierarchy and order. This is a temporary
// projection only; browsing and searching never write to the bookmark store.
export function bookmarkRows(tree, expanded, query = '', searchCollapsed = new Set()) {
  const needle = query.trim().toLocaleLowerCase();
  const entries = [];
  const stack = [...(tree[0]?.children || [])].reverse().map((node) => ({ node, depth: 1 }));
  const matching = new Set();
  const parents = new Map();
  while (stack.length) {
    const { node, depth, parentId, matchedParent = false } = stack.pop();
    if (node.type === 'separator') continue;
    const folder = node.type === 'folder' || Array.isArray(node.children);
    const title = node.title || node.url || 'Untitled folder';
    const matched =
      matchedParent || `${title}\n${node.url || ''}`.toLocaleLowerCase().includes(needle);
    parents.set(node.id, parentId);
    if (needle && matched) {
      let id = node.id;
      while (id && !matching.has(id)) {
        matching.add(id);
        id = parents.get(id);
      }
    }
    entries.push({ id: node.id, title, url: node.url, folder, depth, parentId });
    for (const child of [...(node.children || [])].reverse())
      stack.push({ node: child, depth: depth + 1, parentId: node.id, matchedParent: matched });
  }
  const visible = new Set();
  return entries.filter((entry) => {
    const show = needle
      ? matching.has(entry.id) &&
        (!entry.parentId || (visible.has(entry.parentId) && !searchCollapsed.has(entry.parentId)))
      : !entry.parentId || (visible.has(entry.parentId) && expanded.has(entry.parentId));
    if (show) visible.add(entry.id);
    entry.expanded =
      entry.folder && (needle ? !searchCollapsed.has(entry.id) : expanded.has(entry.id));
    return show;
  });
}

export function bookmarkUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('This bookmark has an invalid address.');
  }
  if (
    !['http:', 'https:', 'ftp:', 'file:'].includes(url.protocol) &&
    !/^about:(blank|home|newtab)([?#]|$)/.test(url.href)
  )
    throw new Error(
      'This bookmark cannot be opened as a tab. Open it from Firefox’s Bookmarks menu.',
    );
  return url.href;
}
