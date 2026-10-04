// Retain existing nodes in place. Appending every node on every render would
// detach the focused/clicked row and interrupt native double-click and dragging.
export function reconcileChildren(parent, children) {
  let cursor = parent.firstChild;
  for (const child of children) {
    if (child === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(child, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

export function setAttribute(node, name, value) {
  const text = String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}

// Row listeners depend only on the stable tab/group ID. Keep that row and its
// focus; replace its small content only when the displayed values change.
export function createRowCache() {
  const rows = new Map();
  const used = new Set();
  return {
    get(key, values, build) {
      used.add(key);
      let entry = rows.get(key);
      if (
        entry &&
        values.length === entry.values.length &&
        values.every((value, i) => value === entry.values[i])
      )
        return entry.row;
      const next = build();
      if (entry) {
        for (const attr of [...entry.row.attributes])
          if (!next.hasAttribute(attr.name)) entry.row.removeAttribute(attr.name);
        for (const attr of next.attributes) setAttribute(entry.row, attr.name, attr.value);
        entry.row.replaceChildren(...next.childNodes);
        entry.values = values;
      } else {
        entry = { row: next, values };
        rows.set(key, entry);
      }
      return entry.row;
    },

    finish() {
      for (const key of rows.keys()) if (!used.has(key)) rows.delete(key);
      used.clear();
    },
  };
}
