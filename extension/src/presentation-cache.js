const plain = (value) => {
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
};

// Weak markers share eligibility with the encoder without retaining records or
// walking an unchanged immutable snapshot again. Mutable inputs are never marked.
const plainPresentations = new WeakSet();

export function isPlainPresentation(value) {
  if (value === null || typeof value !== 'object')
    return typeof value !== 'function' && typeof value !== 'symbol';
  if (plainPresentations.has(value)) return true;
  const pending = [[value, false]];
  const visited = new WeakMap();
  while (pending.length) {
    const [current, leaving] = pending.pop();
    if (plainPresentations.has(current)) continue;
    if (leaving) {
      visited.set(current, 2);
      continue;
    }
    const status = visited.get(current);
    if (status === 1) return false;
    if (status === 2) continue;
    if (!plain(current)) return false;
    visited.set(current, 1);
    pending.push([current, true]);
    for (const child of Object.values(current)) {
      if (typeof child === 'function' || typeof child === 'symbol') return false;
      if (child !== null && typeof child === 'object') pending.push([child, false]);
    }
  }
  return true;
}

function copyForPresentation(value, ownedShells = null) {
  // Native structured-clone types retain their exact graph, but are never
  // cached: freezing a Date/Map does not make it immutable and typed arrays
  // cannot all be frozen. The partially built plain copy is discarded.
  const fallback = () => ({ value: structuredClone(value), nodes: null });
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') return fallback();
    return { value, nodes: [] };
  }
  if (!plain(value)) return fallback();
  // Preserve a compact property layout for row shells that we constructed;
  // borrowed records still copy through checked data descriptors below.
  const allocate = (source) =>
    Array.isArray(source)
      ? new Array(source.length)
      : ownedShells?.has(source)
        ? { ...source }
        : {};
  const copy = allocate(value);
  const copies = new WeakMap([[value, copy]]);
  const pending = [value];
  const nodes = [];
  let shared = false;
  while (pending.length) {
    const source = pending.pop();
    const target = copies.get(source);
    nodes.push(target);
    // Match structuredClone's enumerable string-keyed plain data. A single
    // graph walk copies and validates; only our detached nodes are frozen.
    const owned = ownedShells?.has(source);
    for (const key of Object.keys(source)) {
      const property = owned ? null : Object.getOwnPropertyDescriptor(source, key);
      // Accessors belong to native structuredClone: inspecting descriptors first
      // ensures fallback never invokes a previously visited getter twice. Only
      // locally constructed data shells can bypass descriptor inspection.
      if (!owned && (!property || !Object.hasOwn(property, 'value'))) return fallback();
      let child = owned ? source[key] : property.value;
      if (child !== null && typeof child === 'object') {
        const prior = copies.get(child);
        if (prior) {
          shared = true;
          child = prior;
        } else {
          if (!plain(child)) return fallback();
          const next = allocate(child);
          copies.set(child, next);
          pending.push(child);
          child = next;
        }
      } else if (typeof child === 'function' || typeof child === 'symbol') return fallback();
      if (key === '__proto__')
        Object.defineProperty(target, key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      else target[key] = child;
    }
  }
  for (const node of nodes) Object.freeze(node);
  // A repeated object needs a cycle check; distinct nodes prove an acyclic graph.
  if (!shared || isPlainPresentation(copy)) plainPresentations.add(copy);
  return { value: copy, nodes };
}

export function immutableCopy(value) {
  return copyForPresentation(value).value;
}

// Only compare the controller's small derived fields. Native rows are compared
// by source identity, preserving unknown fields without guessing their shape.
function samePlainValue(a, b) {
  if (Object.is(a, b)) return true;
  const pending = [[a, b]];
  const forward = new WeakMap();
  const reverse = new WeakMap();
  while (pending.length) {
    const [left, right] = pending.pop();
    if (Object.is(left, right) && (left === null || typeof left !== 'object')) continue;
    if (
      left === null ||
      right === null ||
      typeof left !== 'object' ||
      typeof right !== 'object' ||
      !plain(left) ||
      !plain(right) ||
      Array.isArray(left) !== Array.isArray(right) ||
      (Array.isArray(left) && left.length !== right.length)
    )
      return false;
    if (forward.has(left) || reverse.has(right)) {
      if (forward.get(left) !== right || reverse.get(right) !== left) return false;
      continue;
    }
    forward.set(left, right);
    reverse.set(right, left);
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(right, key)) return false;
      pending.push([left[key], right[key]]);
    }
  }
  return true;
}

export function createPresentationCache() {
  let records = new WeakMap();
  let rows = new WeakMap();
  let lists = new WeakMap();
  let immutableValues = new WeakSet();
  let snapshots = new WeakSet();
  const windows = new Map();
  const immutable = (value) =>
    value === null || typeof value !== 'object' || immutableValues.has(value);

  function cacheRecord(source, ownedShells = null) {
    if (source === null || typeof source !== 'object') return source;
    if (records.has(source)) return records.get(source);
    const copy = copyForPresentation(source, ownedShells);
    if (copy.nodes) {
      immutableValues.add(copy.value);
      records.set(source, copy.value);
    }
    return copy.value;
  }

  function record(source) {
    return cacheRecord(source);
  }

  function tabs(source, containers) {
    const prior = lists.get(source);
    if (prior?.containers === containers) return prior.tabs;
    const stores = new Map(containers.map((identity) => [identity.cookieStoreId, identity]));
    const missing = [];
    const positions = [];
    let reusable = true;
    let transferable = true;
    const result = source.map((tab, index) => {
      const identity = stores.get(tab.cookieStoreId);
      const container = identity ? { name: identity.name, colorCode: identity.colorCode } : null;
      const prior = rows.get(tab) || (immutableValues.has(tab) ? tab : undefined);
      if (prior && samePlainValue(prior.container, container)) {
        if (!plainPresentations.has(prior)) transferable = false;
        return prior;
      }
      missing.push({ ...tab, container });
      positions.push(index);
      return null;
    });
    // Cold snapshots detach and freeze their new rows in one graph walk, keeping
    // shared references and every native field. A metadata refresh normally has
    // just one missing row.
    if (missing.length) {
      // These row shells and this array were just constructed above. Their own
      // fields are data properties; all borrowed nested values remain checked.
      const ownedShells = new WeakSet(missing);
      ownedShells.add(missing);
      const detached = cacheRecord(missing, ownedShells);
      reusable = immutable(detached);
      const plainRows = plainPresentations.has(detached);
      transferable &&= plainRows;
      for (let index = 0; index < positions.length; index++) {
        const position = positions[index];
        const next = detached[index];
        result[position] = next;
        if (reusable) {
          immutableValues.add(next);
          if (plainRows) plainPresentations.add(next);
          // An old immutable snapshot must not become a key retaining every
          // later container version through a chain of adopted rows.
          if (!immutableValues.has(source[position])) rows.set(source[position], next);
        }
      }
    }
    const value =
      prior &&
      result.length === prior.tabs.length &&
      result.every((tab, index) => tab === prior.tabs[index])
        ? prior.tabs
        : Object.freeze(result);
    if (reusable) {
      immutableValues.add(value);
      if (transferable) plainPresentations.add(value);
      const entry = { containers, tabs: value };
      if (!immutableValues.has(source)) lists.set(source, entry);
      // The controller may adopt this owned array as its resolved state.
      lists.set(value, entry);
    }
    return value;
  }

  // Retain only the current derived fields per window, never a whole snapshot.
  function field(windowId, key, source) {
    if (!windows.has(windowId)) windows.set(windowId, new Map());
    const fields = windows.get(windowId);
    const prior = fields.get(key);
    if (source !== null && typeof source === 'object' && records.has(source)) {
      const value = records.get(source);
      fields.set(key, value);
      return value;
    }
    if (fields.has(key) && immutable(prior) && samePlainValue(prior, source)) {
      if (source !== null && typeof source === 'object') records.set(source, prior);
      return prior;
    }
    const next = record(source);
    if (immutable(next)) fields.set(key, next);
    else fields.delete(key);
    return next;
  }

  function snapshot(fields) {
    const value = Object.freeze(fields);
    if (Object.values(value).every(immutable)) {
      snapshots.add(value);
      if (isPlainPresentation(value)) plainPresentations.add(value);
    }
    return value;
  }

  return {
    record,
    tabs,
    field,
    snapshot,
    ownsSnapshot: (value) => snapshots.has(value),
    ownsTabs: (value) => Array.isArray(value) && immutableValues.has(value),
    forget: (windowId) => windows.delete(windowId),
    size: () => windows.size,

    dispose() {
      windows.clear();
      records = new WeakMap();
      rows = new WeakMap();
      lists = new WeakMap();
      immutableValues = new WeakSet();
      snapshots = new WeakSet();
    },
  };
}
