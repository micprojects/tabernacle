// Firefox owns bookmark identities, hierarchy and order. This is a temporary
// projection only; browsing and searching never write to the bookmark store.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isFolder = (node) => node.type === 'folder' || Array.isArray(node.children);
const title = (node) => node.title || node.url || 'Untitled folder';

function sortedChildren(node) {
  return [...(node?.children || [])].sort(
    (a, b) => Number(isFolder(b)) - Number(isFolder(a)) || collator.compare(title(a), title(b)),
  );
}

export function bookmarkRoots(tree) {
  const names = new Map([
    ['menu________', 'Bookmarks'],
    ['toolbar_____', 'Toolbar'],
    ['unfiled_____', 'Other'],
    ['mobile______', 'Mobile'],
  ]);
  const order = [...names.keys()];
  return (
    (tree[0]?.children || [])
      .filter((node) => node.type === 'folder' || Array.isArray(node.children))
      // Firefox also exposes an empty Sync root that is normally absent from its Library.
      .filter((node) => node.id !== 'mobile______' || node.children?.length)
      .map((node) => ({
        id: node.id,
        label: names.get(node.id) || node.title || 'Untitled folder',
        title: node.title || names.get(node.id) || 'Untitled folder',
      }))
      .sort((a, b) => {
        const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
        return rank(a.id) - rank(b.id);
      })
  );
}

export function bookmarkRows(tree, expanded, query = '', searchCollapsed = new Set(), rootId) {
  const needle = query.trim().toLocaleLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  const entries = [];
  const root = rootId ? tree[0]?.children?.find((node) => node.id === rootId) : tree[0];
  const children = rootId ? sortedChildren(root) : [...(root?.children || [])];
  const stack = children.reverse().map((node) => ({ node, depth: 1 }));
  const matching = new Set();
  const parents = new Map();
  while (stack.length) {
    const { node, depth, parentId, matchedParent = false } = stack.pop();
    if (node.type === 'separator') continue;
    const folder = node.type === 'folder' || Array.isArray(node.children);
    const title = node.title || node.url || 'Untitled folder';
    const match = terms.every((term) =>
      `${title}\n${node.url || ''}`.toLocaleLowerCase().includes(term),
    );
    const matched = matchedParent || match;
    parents.set(node.id, parentId);
    if (needle && matched) {
      let id = node.id;
      while (id && !matching.has(id)) {
        matching.add(id);
        id = parents.get(id);
      }
    }
    entries.push({
      id: node.id,
      title,
      url: node.url,
      folder,
      depth,
      parentId,
      match,
      childCount: node.children?.length || 0,
    });
    for (const child of sortedChildren(node).reverse())
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

// Return text fragments; callers create text nodes rather than interpreting HTML.
export function bookmarkHighlights(text, query) {
  const value = text.toLocaleLowerCase();
  // Some letters lowercase into multiple code units (for example İ → i̇).
  // Map matches back to the original title instead of shifting the highlight.
  const offsets = [];
  if (value.length !== text.length) {
    let start = 0;
    for (const character of text) {
      for (let i = 0; i < character.toLocaleLowerCase().length; i++)
        offsets.push([start, start + character.length]);
      start += character.length;
    }
  }
  const ranges = [];
  for (const term of new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))) {
    let at = value.indexOf(term);
    while (at >= 0) {
      ranges.push(
        offsets.length
          ? [offsets[at][0], offsets[at + term.length - 1][1]]
          : [at, at + term.length],
      );
      at = value.indexOf(term, at + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  const parts = [];
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
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
