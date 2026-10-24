// One geometry record per logical row. The renderer uses these same records for
// range lookup, nested spacers and reveals; there is no second measurement cache.
export function treeLayout(
  projection,
  { rowHeight = 30, tabHeight = 30, gap = 0, groupGap = 0, addHeight = rowHeight } = {},
) {
  const entries = [];
  const byKey = new Map();
  const siblings = new Map();
  const sizes = new Map();
  let totalSize = 0;
  for (const row of projection.visibleRows) {
    const parent = row.parentKey;
    const previous = siblings.get(parent);
    let margin = row.kind === 'new-tab' ? gap : 0;
    if (row.kind !== 'new-tab' && previous) {
      if (previous.kind === 'group' && row.kind === 'group') margin = gap;
      if (previous.children.some((child) => child.visible)) {
        margin = row.depth === 0 && previous.kind === 'group' ? groupGap : gap;
      }
    }
    const height = row.kind === 'group' ? 32 : row.kind === 'new-tab' ? addHeight : tabHeight;
    const entry = {
      row,
      parentKey: parent,
      index: entries.length,
      sibling: sizes.get(parent) || 0,
      height,
      margin,
      start: totalSize,
      top: totalSize + margin,
      end: totalSize + margin + height,
      last: entries.length,
    };
    totalSize = entry.end;
    sizes.set(parent, entry.sibling + 1);
    siblings.set(parent, row);
    entries.push(entry);
    byKey.set(row.key, entry);
  }
  // A branch's endpoint includes all its descendants, while top + height is
  // always the endpoint of its own row. Reverse preorder settles children first.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const parent = byKey.get(entry.parentKey);
    if (parent && entry.last > parent.last) {
      parent.last = entry.last;
      parent.end = entry.end;
    }
  }
  return { entries, byKey, sizes, totalSize };
}

// Binary searches bound work even for a very tall viewport or a distant jump.
// Include a partially visible slot, including its leading branch margin. At an
// exact bottom boundary, the next row is outside the viewport.
export function visibleRange(entries, offset, height, previous) {
  const count = entries.length;
  if (!count || height <= 0) return null;
  offset = Math.max(0, offset);
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (entries[middle].start <= offset) low = middle;
    else high = middle - 1;
  }
  const startIndex = low;
  high = count - 1;
  const bottom = offset + height;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].top + entries[middle].height < bottom) low = middle + 1;
    else high = middle;
  }
  if (previous?.startIndex === startIndex && previous.endIndex === low && previous.count === count)
    return previous;
  return { startIndex, endIndex: low, count, overscan: 24 };
}

export function revealOffset(entry, offset, height, maximum) {
  const bottom = entry.top + entry.height;
  const next = bottom >= offset + height ? bottom - height : Math.min(offset, entry.start);
  return Math.max(0, Math.min(maximum, next));
}
