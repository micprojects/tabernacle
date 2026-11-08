export function indexBookmarks(tree) {
  if (!Array.isArray(tree) || tree.length !== 1 || !Array.isArray(tree[0]?.children))
    throw new Error('Firefox returned an unreadable bookmark tree.');
  const byId = new Map();
  const rootId = tree[0].id;
  const stack = [{ node: tree[0], parentId: null, index: 0 }];
  while (stack.length) {
    const { node, parentId, index } = stack.pop();
    if (!node || typeof node.id !== 'string' || byId.has(node.id))
      throw new Error('Firefox returned an unreadable bookmark tree.');
    const entry = {
      ...node,
      parentId,
      index,
      type: node.type || (node.children ? 'folder' : 'bookmark'),
    };
    byId.set(entry.id, entry);
    for (let i = (node.children?.length || 0) - 1; i >= 0; i--)
      stack.push({ node: node.children[i], parentId: node.id, index: i });
  }
  return { byId, rootId };
}

export function bookmarkRecord(node) {
  return {
    id: node.id,
    parentId: node.parentId,
    type: node.type,
    title: node.title || '',
    ...(node.url !== undefined ? { url: node.url } : {}),
  };
}

export function bookmarkSubtree(index, id) {
  const result = [];
  const stack = [id];
  while (stack.length) {
    const node = index.byId.get(stack.pop());
    if (!node) throw new Error('That bookmark no longer exists.');
    result.push(bookmarkRecord(node));
    for (const child of [...(node.children || [])].reverse()) stack.push(child.id);
  }
  return result;
}

export function bookmarkEditable(index, id) {
  const node = index.byId.get(id);
  return Boolean(
    node && node.id !== index.rootId && node.parentId !== index.rootId && !node.unmodifiable,
  );
}

export function bookmarkMove(index, id, targetId, position = 'inside') {
  const node = index.byId.get(id);
  const target = index.byId.get(targetId);
  if (!bookmarkEditable(index, id) || !target || !['before', 'inside', 'after'].includes(position))
    throw new Error('Choose an editable bookmark and a destination.');
  const parentId = position === 'inside' ? targetId : target.parentId;
  const parent = index.byId.get(parentId);
  if (!parent || parent.type !== 'folder' || parent.id === index.rootId || parent.unmodifiable)
    throw new Error('Choose a bookmark folder as the destination.');
  for (let ancestor = parent; ancestor; ancestor = index.byId.get(ancestor.parentId))
    if (ancestor.id === id) throw new Error('A folder cannot be moved inside itself.');
  if (targetId === id) throw new Error('Choose another destination.');
  const siblings = parent.children.filter((child) => child.id !== id);
  const targetIndex = siblings.findIndex((child) => child.id === targetId);
  const at = position === 'inside' ? siblings.length : targetIndex + Number(position === 'after');
  if (at < 0) throw new Error('The destination has moved. Try again.');
  const beforeId = siblings[at]?.id ?? null;
  return { parentId, beforeId, index: at, noOp: node.parentId === parentId && node.index === at };
}

export function bookmarkAddress(value) {
  const text = String(value || '').trim();
  try {
    return new URL(text).href;
  } catch {
    throw new Error('Enter a complete bookmark address, such as https://example.com.');
  }
}
