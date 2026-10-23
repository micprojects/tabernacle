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

export function reconcileRetainedChildren(parent, children) {
  let cursor = parent.firstChild;
  let index = 0;
  while (cursor && cursor === children[index]) {
    cursor = cursor.nextSibling;
    index++;
  }
  if (!cursor && index === children.length) return;
  const keep = new Set(children);
  while (cursor) {
    const next = cursor.nextSibling;
    if (!keep.has(cursor)) cursor.remove();
    cursor = next;
  }
  reconcileChildren(parent, children);
}

export function setAttribute(node, name, value) {
  const text = String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}

// Keep each logical row and its focus; patch or replace its small content only
// when displayed values change. Idle views can be explicitly taken for reuse.
export function createRowCache({ retain = 0, owned = () => false } = {}) {
  const rows = new Map();
  const used = new Set();
  const hidden = [];
  let clock = 0;

  function detach() {
    // A retained row must not keep its former parent/subtree alive. Outgoing
    // animations still own connected rows; detach those after motion finishes.
    rows.forEach(({ key, row }) => {
      if (!used.has(key) && !row.isConnected) row.remove();
    });
  }

  return {
    begin() {
      used.clear();
    },

    reuse(key) {
      used.add(key);
    },

    has(key) {
      return rows.has(key);
    },

    get(key, values, build, update) {
      used.add(key);
      let entry = rows.get(key);
      if (entry) entry.usedAt = ++clock;
      if (
        entry &&
        values.length === entry.values.length &&
        values.every((value, i) => value === entry.values[i])
      )
        return entry.row;
      if (entry && update?.(entry.row, entry.values, values)) {
        entry.values = values;
        return entry.row;
      }
      const next = build();
      if (entry) {
        for (const attr of [...entry.row.attributes])
          if (!next.hasAttribute(attr.name)) entry.row.removeAttribute(attr.name);
        for (const attr of next.attributes) setAttribute(entry.row, attr.name, attr.value);
        const focused = [...entry.row.children].find((node) => node === document.activeElement);
        const replacement =
          focused &&
          [...next.children].find(
            (node) =>
              (focused.dataset.rowAction && node.dataset.rowAction === focused.dataset.rowAction) ||
              (focused.dataset.key && node.dataset.key === focused.dataset.key),
          );
        if (replacement) {
          for (const attr of [...focused.attributes])
            if (!replacement.hasAttribute(attr.name)) focused.removeAttribute(attr.name);
          for (const attr of replacement.attributes) setAttribute(focused, attr.name, attr.value);
          focused.replaceChildren(...replacement.childNodes);
          reconcileRetainedChildren(
            entry.row,
            [...next.childNodes].map((node) => (node === replacement ? focused : node)),
          );
        } else entry.row.replaceChildren(...next.childNodes);
        entry.values = values;
      } else {
        entry = { key, row: next, values, usedAt: ++clock };
        rows.set(key, entry);
      }
      return entry.row;
    },

    take(key) {
      const entry = rows.get(key);
      if (!entry || used.has(key) || owned(entry.row) || entry.row.contains(document.activeElement))
        return;
      rows.delete(key);
      return entry;
    },

    adopt(key, entry) {
      entry.key = key;
      entry.values = [];
      rows.set(key, entry);
    },

    finish(isLive = () => false) {
      const limit = typeof retain === 'function' ? retain() : retain;
      rows.forEach((entry, key) => {
        if (used.has(key) || owned(entry.row)) return;
        if (limit && isLive(key)) hidden.push(entry);
        else rows.delete(key);
      });
      hidden.sort((a, b) => b.usedAt - a.usedAt);
      for (let i = limit; i < hidden.length; i++) rows.delete(hidden[i].key);
      hidden.length = 0;
      detach();
      used.clear();
    },

    clear() {
      for (const { row } of rows.values()) row.remove();
      rows.clear();
      used.clear();
      hidden.length = 0;
      clock = 0;
    },

    detach,
  };
}
