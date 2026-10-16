// Native messaging copies every object across processes. Keep unchanged tabs
// in the receiving view, while continuing to read authoritative full snapshots.
// Tokens identify a specific response, independently of notification revisions.
function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return (
    Array.isArray(a) === Array.isArray(b) &&
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
  );
}

export function createSnapshotEncoder(limit = 8) {
  const previous = new Map();
  const generation = crypto.randomUUID();
  let sequence = 0;
  return {
    encode(windowId, state, baseToken) {
      const before = previous.get(baseToken);
      const token = `${generation}:${++sequence}`;
      let result = { token, state };
      if (
        before &&
        before.windowId === windowId &&
        before.state.generation === state.generation &&
        before.state.tabs.length === state.tabs.length &&
        state.tabs.every((tab, i) => tab.id === before.state.tabs[i].id)
      ) {
        const changes = [];
        for (const [index, tab] of state.tabs.entries())
          if (!sameValue(tab, before.state.tabs[index])) changes.push({ index, tab });
        // Large structural changes are cheaper and simpler to send in full.
        if (changes.length < state.tabs.length / 2) {
          const { tabs, ...rest } = state;
          result = { token, baseToken, state: rest, changes };
        }
      }
      if (before?.windowId === windowId) previous.delete(baseToken);
      previous.set(token, { windowId, state });
      if (previous.size > limit) previous.delete(previous.keys().next().value);
      return result;
    },

    forget(windowId) {
      for (const [token, entry] of previous)
        if (entry.windowId === windowId) previous.delete(token);
    },
  };
}

export function createSnapshotReader(send) {
  let previous;
  return async () => {
    // Capture this request's base: overlapping reads may finish out of order.
    const before = previous;
    let result = await send(before?.token);
    // A view can briefly outlive its background script during an add-on update.
    if (!result.token) {
      previous = undefined;
      return result;
    }
    if (result.baseToken && result.baseToken !== before?.token) result = await send();
    if (result.baseToken && result.baseToken !== before?.token)
      throw new Error('Tabernacle could not refresh. Try reopening the sidebar.');
    let state = result.state;
    if (result.baseToken) {
      const tabs = before.state.tabs.slice();
      for (const { index, tab } of result.changes) tabs[index] = tab;
      state = { ...state, tabs };
    }
    previous = { token: result.token, state };
    return state;
  };
}
