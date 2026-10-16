import { folderAppearance } from './folder-appearance.js';

// Build a fresh index for each snapshot/render. Model objects can be edited in
// place, so retaining a cache by object identity would leave inheritance stale.
export function createFolderIndex({ groups, containers = [] }) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const identities = new Map(containers.map((item) => [item.cookieStoreId, item]));
  const candidates = new Map();
  for (const group of groups) {
    const parent = byId.has(group.parentId) ? group.parentId : null;
    if (!candidates.has(parent)) candidates.set(parent, []);
    candidates.get(parent).push(group);
  }
  const children = new Map();
  const parents = new Map();
  const details = new Map();
  const order = [];
  const bounds = new Map();

  function visit(root) {
    const pending = [{ group: root, parent: null }];
    while (pending.length) {
      const { group, parent, exit } = pending.pop();
      if (exit) {
        bounds.get(group.id).end = order.length;
        continue;
      }
      if (details.has(group.id)) continue;
      parents.set(group.id, parent);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(group);
      const inherited = details.get(parent);
      const own = folderAppearance(group);
      const source = group.defaultCookieStoreId != null ? group : inherited?.source;
      const container = identities.get(source?.defaultCookieStoreId);
      const customColor = own.color ?? inherited?.customColor;
      details.set(group.id, {
        source,
        container,
        customColor,
        appearance: { icon: own.icon, color: customColor ?? container?.colorCode },
      });
      bounds.set(group.id, { start: order.length, end: order.length + 1 });
      order.push(group);
      pending.push({ group, exit: true });
      const nested = candidates.get(group.id) || [];
      for (let i = nested.length - 1; i >= 0; i--)
        pending.push({ group: nested[i], parent: group.id });
    }
  }

  for (const group of candidates.get(null) || []) visit(group);
  // Defensive handling of malformed cycles: expose each folder once and keep
  // all traversals finite. Normalised stored models are already acyclic.
  for (const group of groups) if (!details.has(group.id)) visit(group);
  return {
    byId,
    children,
    parents,
    details,
    order,

    path(id) {
      const path = [];
      while (byId.has(id)) {
        path.push(byId.get(id));
        id = parents.get(id);
      }
      return path.reverse();
    },

    isWithin(id, ancestor) {
      if (ancestor === null) return true;
      const item = bounds.get(id);
      const scope = bounds.get(ancestor);
      return Boolean(item && scope && item.start >= scope.start && item.start < scope.end);
    },
  };
}
