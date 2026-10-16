import { createTreeIndex } from './tree-index.js';
import { domainResults, normaliseDomain } from './domain-filter.js';

// Match the sidebar's folder-first, depth-first order. Offscreen rows count;
// collapsed branches and the global pin strip do not.
export function visibleTabOrder(state) {
  const index = createTreeIndex(state);
  const collapsed = new Set(state.view.collapsed);
  const result = [];
  const pending = [{ kind: 'group', id: state.view.scopeId, root: true }];
  while (pending.length) {
    const item = pending.pop();
    if (item.kind === 'tab') {
      result.push(item.tab.id);
      if (!item.tab.collapsed)
        for (const tab of (index.children.get(item.tab.id) || []).slice().reverse())
          pending.push({ kind: 'tab', tab });
    } else if (item.root || !collapsed.has(item.id)) {
      for (const tab of (index.roots.get(item.id) || []).slice().reverse())
        pending.push({ kind: 'tab', tab });
      for (const group of (index.groupChildren.get(item.id) || []).slice().reverse())
        pending.push({ kind: 'group', id: group.id });
    }
  }
  return result;
}

export function closeFallback(before, after, closedId, filter = null) {
  if (
    before.view.scopeId !== after.view.scopeId ||
    JSON.stringify(before.view.collapsed) !== JSON.stringify(after.view.collapsed)
  )
    return null;
  const domain = normaliseDomain(filter?.domain);
  const query = typeof filter?.query === 'string' ? filter.query : '';
  // A native close may refresh the sidebar before we ask for its projection.
  // Keep the removed row's former place when finding the surviving neighbour.
  const included = Array.isArray(filter?.tabIds) ? new Set([...filter.tabIds, closedId]) : null;
  const orderFor = (state) =>
    domain
      ? domainResults(createTreeIndex(state), domain, query, filter.sort)
          .filter((tab) => !included || included.has(tab.id))
          .map((tab) => tab.id)
      : visibleTabOrder(state);
  const order = orderFor(before);
  const position = order.indexOf(closedId);
  if (position < 0 || after.tabs.some((tab) => tab.id === closedId)) return null;
  const remaining = orderFor(after);
  const visible = new Set(remaining);
  const active = after.tabs.find((tab) => tab.active);
  if (!active || visible.has(active.id)) return null;
  const above = order.slice(0, position).reverse();
  const below = order.slice(position + 1);
  return (
    (domain ? [...above, ...below] : [...below, ...above]).find((id) => visible.has(id)) ??
    // Closing a collapsed parent natively can reveal its surviving children.
    remaining[0] ??
    null
  );
}

// Firefox's default successor is not exposed by successorTabId. Observe its
// actual choice, pairing removal with activation in either event order. A later
// deliberate activation cancels the correction, even while storage is loading.
export function createCloseSelection(api, correct) {
  const windows = new Map();
  const listeners = [];

  function watch(event, listener) {
    if (!event?.addListener) return;
    event.addListener(listener);
    listeners.push(() => event.removeListener?.(listener));
  }

  function schedule(windowId, entry, before, closedId, transition) {
    const current = () => windows.get(windowId) === entry && entry.transition === transition;
    correct(windowId, before, closedId, current).catch((error) =>
      console.warn('Tabernacle could not select a nearby tab:', error.message),
    );
  }

  watch(api.tabs.onRemoved, (id, { windowId, isWindowClosing }) => {
    const entry = windows.get(windowId);
    if (!entry) return;
    if (isWindowClosing) {
      windows.delete(windowId);
      return;
    }
    if (entry.activeId === id) entry.removed = { id, before: entry.state };
    else if (entry.transition?.closed && entry.transition.from === id)
      schedule(windowId, entry, entry.transition.before, id, entry.transition);
  });
  watch(api.tabs.onActivated, ({ windowId, tabId, previousTabId }) => {
    const entry = windows.get(windowId);
    if (!entry) return;
    const from = entry.activeId;
    const transition = {
      from,
      to: tabId,
      closed: previousTabId == null,
      before: entry.state,
    };
    entry.activeId = tabId;
    entry.transition = transition;
    if (entry.removed && entry.removed.id === from)
      schedule(windowId, entry, entry.removed.before, from, transition);
    entry.removed = null;
  });
  watch(api.tabs.onCreated, (tab) => {
    const entry = windows.get(tab.windowId);
    if (entry && tab.active) {
      entry.transition = { from: entry.activeId, to: tab.id, closed: false };
      entry.activeId = tab.id;
      entry.removed = null;
    }
  });
  watch(api.tabs.onDetached, (_id, { oldWindowId }) => {
    const entry = windows.get(oldWindowId);
    if (entry) {
      entry.transition = {};
      entry.removed = null;
    }
  });
  watch(api.windows.onRemoved, (id) => windows.delete(id));
  return {
    remember(windowId, state) {
      const entry = windows.get(windowId);
      if (entry) entry.state = state;
      else windows.set(windowId, { state, activeId: state.tabs.find((tab) => tab.active)?.id });
    },

    // Managed closes also settle before returning their snapshot. Native-event
    // corrections queued during remove() then become harmless no-ops.
    guard(windowId, closing) {
      const entry = windows.get(windowId);
      const prior = entry?.transition;
      return () =>
        !entry ||
        (windows.get(windowId) === entry &&
          (entry.transition === prior ||
            (entry.transition?.closed &&
              closing.includes(entry.transition.from) &&
              entry.transition.to === entry.activeId)));
    },

    dispose() {
      for (const stop of listeners) stop();
      windows.clear();
    },
  };
}
