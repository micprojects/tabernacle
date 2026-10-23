import { TAB_KEY } from './model.js';
import { deserializeMembership, serializeMembership } from './persistence.js';

// Cache only data with an explicit invalidation path. Memberships belong to this
// extension; native tabs, containers and closed sessions have Firefox events.
export function createBrowserCache(api, changed = () => {}) {
  const memberships = new Map();
  const tabLists = new Map();
  const tabSnapshots = new WeakMap();
  const ancillary = new Map();
  const listeners = [];
  const invalidatedRead = Symbol('invalidated read');
  let disposed = false;

  const watch = (event, listener) => {
    if (!event?.addListener) return;
    event.addListener(listener);
    listeners.push(() => event.removeListener?.(listener));
  };

  async function read(cache, key, fetch, accept = (value) => value) {
    for (;;) {
      if (disposed) return fetch();
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(fetch));
      const pending = cache.get(key);
      let value;
      try {
        value = await pending;
      } catch (error) {
        if (cache.get(key) === pending) cache.delete(key);
        throw error;
      }
      // A discarded refresh is not a native result, even if disposal happens
      // before this reader resumes. Retry authoritative data in either case.
      if (value === invalidatedRead) {
        if (cache.get(key) === pending) cache.delete(key);
        continue;
      }
      if (disposed) return value;
      // An event during the read invalidates its result too.
      if (cache.get(key) === pending) return accept(value);
    }
  }

  function invalidateTabs(windowId) {
    tabLists.delete(null);
    if (windowId == null) tabLists.clear();
    else tabLists.delete(windowId);
  }

  function rememberTabs(windowId, tabs) {
    const pending = tabLists.get(windowId);
    if (!tabSnapshots.has(pending))
      tabSnapshots.set(pending, {
        tabs,
        positions: new Map(tabs.map((tab, index) => [tab.id, index])),
        patches: new Map(),
        selectionIds: new Set(),
        structureToken: Object.freeze({}),
      });
    return tabSnapshots.get(pending);
  }

  // These events carry all changed values and cannot move tabs or alter which
  // tabs belong to a window. Keep old arrays immutable for in-flight snapshots.
  // Navigation, structural changes, unknown fields and pending reads still query.
  const metadataProperties = new Set([
    'title',
    'favIconUrl',
    'status',
    'audible',
    'mutedInfo',
    'discarded',
  ]);
  const selectionProperties = new Set(['active', 'highlighted', 'lastAccessed']);

  function selectionChanged(windowId, ids) {
    const cached = tabSnapshots.get(tabLists.get(windowId));
    const known = ids.filter((id) => id !== undefined);
    if (
      !api.tabs.get ||
      !cached ||
      cached.additions?.size ||
      !known.length ||
      known.some((id) => !cached.positions.has(id))
    ) {
      invalidateTabs(windowId);
      return;
    }
    // Firefox updates both the old and new selection, including lastAccessed.
    // Read native records rather than inventing timestamps or active flags.
    for (const tab of cached.tabs)
      if (tab.active || tab.highlighted) cached.selectionIds.add(tab.id);
    for (const id of known) cached.selectionIds.add(id);
    tabLists.delete(null);
  }

  function refreshSelection(windowId) {
    const cached = tabSnapshots.get(tabLists.get(windowId));
    if (!cached?.selectionIds.size) return;
    const ids = [...cached.selectionIds];
    // Bulk highlighting or a long burst is cheaper and bounded as one query.
    if (ids.length > 32) {
      invalidateTabs(windowId);
      return;
    }
    // The pending promise has no snapshot: an intervening event invalidates it
    // and read() retries authoritative data, just like a cold tabs.query().
    const pending = Promise.resolve().then(async () => {
      const settled = await Promise.allSettled(ids.map((id) => api.tabs.get(id)));
      const structural = (tab) =>
        JSON.stringify(
          Object.entries(tab).filter(
            ([key]) => !metadataProperties.has(key) && !selectionProperties.has(key),
          ),
        );
      if (
        settled.some(
          (result, i) =>
            result.status === 'rejected' ||
            structural(result.value) !== structural(cached.tabs[cached.positions.get(ids[i])]),
        )
      )
        return api.tabs.query({ windowId });
      const tabs = cached.tabs.slice();
      for (const [position, properties] of cached.patches)
        tabs[position] = { ...tabs[position], ...properties };
      for (const [i, result] of settled.entries())
        tabs[cached.positions.get(ids[i])] = result.value;
      // Separate get() replies must describe one coherent native selection.
      // A racing activation/close can otherwise leave zero or two active rows.
      if (tabs.filter((tab) => tab.active).length !== 1) return api.tabs.query({ windowId });
      if (!disposed && tabLists.get(windowId) === pending)
        tabSnapshots.set(pending, {
          tabs,
          positions: cached.positions,
          patches: new Map(),
          selectionIds: new Set(),
          structureToken: cached.structureToken,
        });
      return tabs;
    });
    tabLists.set(windowId, pending);
  }

  function updateMetadata(id, properties, windowId) {
    if (!Object.keys(properties).every((key) => metadataProperties.has(key))) return false;
    const cached = tabSnapshots.get(tabLists.get(windowId));
    const position = cached?.positions.get(id);
    if (position === undefined) return false;
    cached.patches.set(position, {
      ...cached.patches.get(position),
      ...structuredClone(properties),
    });
    tabLists.delete(null);
    return true;
  }

  // Only inactive appends preserve all existing positions and selection. Event
  // records are incomplete (for example discarded-tab dimensions), so remember
  // IDs and read their complete native state before exposing a new snapshot.
  function appendCreated(tab) {
    const cached = tabSnapshots.get(tabLists.get(tab.windowId));
    if (
      !api.tabs.get ||
      !cached ||
      cached.selectionIds.size ||
      tab.active ||
      tab.highlighted ||
      tab.pinned ||
      tab.incognito ||
      !Number.isInteger(tab.id) ||
      !Number.isInteger(tab.index) ||
      tab.index !== cached.tabs.length + (cached.additions?.size || 0) ||
      cached.positions.has(tab.id) ||
      cached.additions?.has(tab.id)
    )
      return false;
    (cached.additions ??= new Map()).set(tab.id, tab.index);
    cached.structureToken = Object.freeze({});
    tabLists.delete(null);
    return true;
  }

  function refreshAdditions(windowId) {
    const cached = tabSnapshots.get(tabLists.get(windowId));
    if (!cached?.additions?.size || cached.appending) return;
    // Large parallel bursts still use one native query. Serial arrivals can
    // otherwise repeatedly transfer every unchanged row in the window.
    if (cached.additions.size > 32) {
      invalidateTabs(windowId);
      return;
    }
    const pending = Promise.resolve()
      .then(async () => {
        while (cached.additions.size) {
          if (disposed) return api.tabs.query({ windowId });
          if (tabLists.get(windowId) !== pending) return invalidatedRead;
          if (cached.additions.size > 32) {
            invalidateTabs(windowId);
            return invalidatedRead;
          }
          const added = [...cached.additions];
          const settled = await Promise.allSettled(
            added.map(([id]) => cached.createdReads?.get(id) ?? api.tabs.get(id)),
          );
          if (disposed) return api.tabs.query({ windowId });
          if (tabLists.get(windowId) !== pending) return invalidatedRead;
          if (
            settled.some((result, i) => {
              const tab = result.value;
              return (
                result.status !== 'fulfilled' ||
                tab.id !== added[i][0] ||
                tab.windowId !== windowId ||
                tab.index !== added[i][1] ||
                tab.pinned ||
                tab.active ||
                tab.highlighted ||
                tab.incognito
              );
            })
          ) {
            invalidateTabs(windowId);
            return invalidatedRead;
          }
          const next = cached.tabs.slice();
          const positions = new Map(cached.positions);
          for (const result of settled) {
            positions.set(result.value.id, next.length);
            next.push(result.value);
            cached.additions.delete(result.value.id);
            cached.createdReads?.delete(result.value.id);
          }
          cached.tabs = next;
          cached.positions = positions;
        }
        cached.additions = undefined;
        cached.createdReads = undefined;
        const ready = Promise.resolve(cached.tabs);
        tabLists.set(windowId, ready);
        tabSnapshots.set(ready, cached);
        return cached.tabs;
      })
      .finally(() => {
        cached.appending = false;
      });
    cached.appending = true;
    tabLists.set(windowId, pending);
    tabSnapshots.set(pending, cached);
  }

  async function tabsState(windowId = null) {
    // Adapters without lifecycle events cannot promise a stable structure.
    if (!api.tabs.onUpdated)
      return {
        tabs: await api.tabs.query(windowId == null ? {} : { windowId }),
        structureToken: Object.freeze({}),
      };
    for (;;) {
      refreshAdditions(windowId);
      refreshSelection(windowId);
      const state = await read(
        tabLists,
        windowId,
        () => api.tabs.query(windowId == null ? {} : { windowId }),
        (tabs) => {
          // Seed windows while the global result is still known to be current.
          // Another await here could let an event invalidate it before seeding.
          if (windowId === null) {
            const windows = new Map();
            for (const tab of tabs) {
              if (!windows.has(tab.windowId)) windows.set(tab.windowId, []);
              windows.get(tab.windowId).push(tab);
            }
            for (const [id, values] of windows)
              if (!tabLists.has(id)) {
                tabLists.set(id, Promise.resolve(values));
                rememberTabs(id, values);
              }
          }
          const cached = rememberTabs(windowId, tabs);
          if (cached.patches.size) {
            // A burst makes one array copy when consumed, with new rows only for
            // the affected tabs. Earlier snapshots keep their original values.
            const next = cached.tabs.slice();
            for (const [position, properties] of cached.patches)
              next[position] = { ...next[position], ...properties };
            cached.tabs = next;
            cached.patches.clear();
            // Release the prior promise's array once its readers have finished.
            const pending = Promise.resolve(next);
            tabLists.set(windowId, pending);
            tabSnapshots.set(pending, cached);
          }
          // This index belongs to the structural token. Consumers may share it,
          // but must never mutate it; metadata patches preserve every position.
          return {
            tabs: cached.tabs,
            positions: cached.positions,
            structureToken: cached.structureToken,
          };
        },
      );
      // Selection can change after a shared read settles but before this reader
      // resumes. Consume that new refresh before returning its older native rows.
      const current = tabSnapshots.get(tabLists.get(windowId));
      if (current?.selectionIds.size || current?.additions?.size) continue;
      // Disposal lets outstanding work settle without repopulating the cache.
      return Array.isArray(state) ? { tabs: state, structureToken: Object.freeze({}) } : state;
    }
  }

  const tabChanged = (windowId, removedTabId) => {
    invalidateTabs(windowId);
    if (removedTabId !== undefined) memberships.delete(removedTabId);
    changed({ windowId, removedTabId });
  };

  const visibleProperties = new Set([
    'title',
    'url',
    'favIconUrl',
    'pinned',
    'audible',
    'mutedInfo',
    'discarded',
    'hidden',
    'groupId',
    'cookieStoreId',
    'active',
    'lastAccessed',
  ]);
  watch(api.tabs.onUpdated, (id, properties, tab) => {
    const keys = Object.keys(properties);
    if (
      keys.some((key) => selectionProperties.has(key)) &&
      keys.every((key) => selectionProperties.has(key) || metadataProperties.has(key))
    )
      selectionChanged(tab.windowId, [id]);
    else if (!updateMetadata(id, properties, tab.windowId)) invalidateTabs(tab.windowId);
    // Domain headings can resolve a site name once its page title has settled.
    if (
      properties.status === 'complete' ||
      Object.keys(properties).some((key) => visibleProperties.has(key))
    )
      changed({ windowId: tab.windowId });
  });
  watch(api.tabs.onCreated, (tab) => {
    if (!appendCreated(tab)) invalidateTabs(tab.windowId);
    changed({ windowId: tab.windowId });
  });
  watch(api.tabs.onRemoved, (id, info) => tabChanged(info.windowId, id));
  watch(api.tabs.onActivated, (info) => {
    selectionChanged(info.windowId, [info.tabId, info.previousTabId]);
    changed({ windowId: info.windowId });
  });
  watch(api.tabs.onHighlighted, (info) => {
    selectionChanged(info.windowId, info.tabIds);
    changed({ windowId: info.windowId });
  });
  watch(api.tabs.onMoved, (_id, info) => tabChanged(info.windowId));
  watch(api.tabs.onAttached, (_id, info) => tabChanged(info.newWindowId));
  watch(api.tabs.onDetached, (id, info) => {
    invalidateTabs(info.oldWindowId);
    changed({ windowId: info.oldWindowId, detachedTabId: id });
  });
  watch(api.windows.onRemoved, (windowId) => {
    const cached = tabSnapshots.get(tabLists.get(windowId));
    const removedTabIds = [
      ...(cached?.tabs || []).map((tab) => tab.id),
      ...(cached?.additions?.keys() || []),
    ];
    for (const id of removedTabIds) memberships.delete(id);
    invalidateTabs(windowId);
    changed({ windowId, removedWindowId: windowId, removedTabIds });
  });
  watch(api.sessions.onChanged, () => {
    ancillary.delete('history');
    changed({});
  });
  for (const event of ['onCreated', 'onUpdated', 'onRemoved']) {
    watch(api.contextualIdentities?.[event], () => {
      ancillary.delete('containers');
      changed({});
    });
  }
  return {
    invalidateTabs,
    selectionChanged,
    invalidateContainers: () => ancillary.delete('containers'),
    invalidateHistory: () => ancillary.delete('history'),

    tabsState,
    isTabsStateCurrent: (windowId, structureToken) =>
      disposed ||
      !api.tabs.onUpdated ||
      (structureToken !== undefined &&
        tabSnapshots.get(tabLists.get(windowId ?? null))?.structureToken === structureToken),

    async tabs(windowId = null) {
      return (await tabsState(windowId)).tabs;
    },

    async createdTab(id, windowId) {
      const cached = tabSnapshots.get(tabLists.get(windowId));
      const index = cached?.additions?.get(id);
      const tab = await api.tabs.get(id);
      // The ordinary native check remains authoritative. Reuse its result only
      // while this same append-only snapshot still owns that pending addition.
      // Events that could change the new tab invalidate the snapshot instead.
      if (
        index !== undefined &&
        !cached.appending &&
        tabSnapshots.get(tabLists.get(windowId)) === cached &&
        cached.additions?.get(id) === index
      )
        (cached.createdReads ??= new Map()).set(id, structuredClone(tab));
      return tab;
    },

    async membership(id) {
      const value = await read(memberships, id, async () =>
        deserializeMembership(await api.sessions.getTabValue(id, TAB_KEY)),
      );
      // Memberships contain scalar fields and an ancestry array. Copy those
      // explicitly: deep cloning every record dominates large tab-creation bursts.
      return value == null
        ? value
        : {
            ...value,
            ...(Array.isArray(value.ancestors) ? { ancestors: [...value.ancestors] } : {}),
          };
    },

    async saveMembership(id, value) {
      await api.sessions.setTabValue(id, TAB_KEY, serializeMembership(value));
      if (!disposed) memberships.set(id, Promise.resolve(structuredClone(value)));
    },

    forgetMembership: (id) => memberships.delete(id),

    pruneMemberships(tabs) {
      if (!memberships.size) return;
      const live = new Set(tabs.map((tab) => tab.id));
      for (const id of memberships.keys()) if (!live.has(id)) memberships.delete(id);
    },

    containers() {
      if (!api.contextualIdentities?.query)
        return Promise.reject(
          new Error(
            'Container access is unavailable. Reload Tabernacle to enable its container permissions.',
          ),
        );
      const fetch = () => api.contextualIdentities.query({});
      return api.contextualIdentities.onUpdated ? read(ancillary, 'containers', fetch) : fetch();
    },

    history() {
      const fetch = () => api.sessions.getRecentlyClosed();
      return api.sessions.onChanged ? read(ancillary, 'history', fetch) : fetch();
    },

    stats: () => ({
      memberships: memberships.size,
      nativeLists: tabLists.size,
      ancillary: ancillary.size,
    }),

    dispose() {
      disposed = true;
      for (const stop of listeners) stop();
      listeners.length = 0;
      memberships.clear();
      tabLists.clear();
      ancillary.clear();
    },
  };
}
