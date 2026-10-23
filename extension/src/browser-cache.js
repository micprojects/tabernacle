import { TAB_KEY } from './model.js';
import { deserializeMembership, serializeMembership } from './persistence.js';
import { internalPage } from './internal-pages.js';

// Cache only data with an explicit invalidation path. Memberships belong to this
// extension; native tabs, containers and closed sessions have Firefox events.
export function createBrowserCache(api, changed = () => {}) {
  const memberships = new Map();
  const tabLists = new Map();
  const tabSnapshots = new WeakMap();
  const pendingRefreshes = new WeakMap();
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
  // Structural changes, unknown fields and pending full queries still query.
  // Eligible navigation takes complete bounded native reads before reusing topology.
  const metadataProperties = new Set([
    'title',
    'favIconUrl',
    'status',
    'audible',
    'mutedInfo',
    'discarded',
  ]);
  const selectionProperties = new Set(['active', 'highlighted', 'lastAccessed']);

  const samePageAddress = (left, right) =>
    typeof left === 'string' &&
    typeof right === 'string' &&
    /^https?:\/\//.test(left) &&
    left.split('#', 1)[0] === right.split('#', 1)[0];

  function sameOriginAddress(left, right) {
    if (
      typeof left !== 'string' ||
      typeof right !== 'string' ||
      !/^https?:\/\//.test(left) ||
      !/^https?:\/\//.test(right)
    )
      return false;
    try {
      return new URL(left).origin === new URL(right).origin;
    } catch {
      return false;
    }
  }

  function navigationChanged(id, properties, windowId) {
    if (
      !Object.hasOwn(properties, 'url') ||
      !Object.keys(properties).every((key) => key === 'url' || metadataProperties.has(key))
    )
      return false;
    const cached = tabSnapshots.get(tabLists.get(windowId));
    const before = cached?.tabs[cached.positions.get(id)];
    const fragment = samePageAddress(before?.url, properties.url);
    if (
      !fragment &&
      (!sameOriginAddress(before?.url, properties.url) ||
        internalPage(api, before.url) ||
        internalPage(api, properties.url))
    )
      return false;
    selectionChanged(windowId, [id]);
    if (tabSnapshots.get(tabLists.get(windowId)) === cached) {
      if (fragment) {
        cached.navigationUrls?.delete(id);
        (cached.fragmentIds ??= new Set()).add(id);
      } else {
        cached.fragmentIds?.delete(id);
        (cached.navigationUrls ??= new Map()).set(id, properties.url);
      }
    }
    return true;
  }

  function articleChanged(id, properties, windowId) {
    if (
      typeof properties.isArticle !== 'boolean' ||
      !Object.keys(properties).every((key) => key === 'isArticle' || metadataProperties.has(key))
    )
      return false;
    const cached = tabSnapshots.get(tabLists.get(windowId));
    if (!cached?.positions.has(id)) return false;
    // Firefox resets Reader Mode eligibility before announcing a new URL.
    // Read complete native data; this event cannot reveal removed favicons.
    selectionChanged(windowId, [id]);
    if (tabSnapshots.get(tabLists.get(windowId)) === cached)
      (cached.articleIds ??= new Set()).add(id);
    return true;
  }

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
    // Release a bulk burst immediately, before later events scan this window
    // again or retain more native-refresh markers between reader requests.
    if (cached.selectionIds.size > 32) invalidateTabs(windowId);
    else tabLists.delete(null);
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

    const refresh = { cached, ids: new Set(ids), revision: 0 };

    const fallback = () => {
      // Updates during a full query must invalidate its result as usual.
      pendingRefreshes.delete(pending);
      return api.tabs.query({ windowId });
    };

    const pending = Promise.resolve()
      .then(async () => {
        const structural = (tab, navigation, article) =>
          JSON.stringify(
            Object.entries(tab).filter(
              ([key]) =>
                !metadataProperties.has(key) &&
                !selectionProperties.has(key) &&
                !(navigation && key === 'url') &&
                !(article && key === 'isArticle'),
            ),
          );
        // A late event can describe older data than an in-flight get() reply.
        // Never overlay it: repeat complete reads after known metadata changes.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (disposed) return fallback();
          if (tabLists.get(windowId) !== pending) return invalidatedRead;
          const ids = [...refresh.ids];
          const revision = refresh.revision;
          const settled = await Promise.allSettled(ids.map((id) => api.tabs.get(id)));
          if (disposed) return fallback();
          if (tabLists.get(windowId) !== pending) return invalidatedRead;
          if (revision !== refresh.revision) continue;
          if (
            settled.some((result, i) => {
              if (result.status === 'rejected') return true;
              const before = cached.tabs[cached.positions.get(ids[i])];
              const fragment =
                cached.fragmentIds?.has(ids[i]) && samePageAddress(before.url, result.value.url);
              const announced = cached.navigationUrls?.get(ids[i]);
              const navigation =
                fragment || (announced !== undefined && announced === result.value.url);
              const article = cached.articleIds?.has(ids[i]);
              return (
                structural(result.value, navigation, article) !==
                structural(before, navigation, article)
              );
            })
          )
            return fallback();
          const tabs = cached.tabs.slice();
          for (const [position, properties] of cached.patches)
            tabs[position] = { ...tabs[position], ...properties };
          for (const [i, result] of settled.entries())
            tabs[cached.positions.get(ids[i])] = result.value;
          // Separate get() replies must describe one coherent native selection.
          if (tabs.filter((tab) => tab.active).length !== 1) return fallback();
          tabSnapshots.set(pending, {
            tabs,
            positions: cached.positions,
            patches: new Map(),
            selectionIds: new Set(),
            structureToken: cached.structureToken,
          });
          return tabs;
        }
        return fallback();
      })
      .finally(() => pendingRefreshes.delete(pending));
    pendingRefreshes.set(pending, refresh);
    tabLists.set(windowId, pending);
  }

  function updateMetadata(id, properties, windowId) {
    if (!Object.keys(properties).every((key) => metadataProperties.has(key))) return false;
    const pending = tabLists.get(windowId);
    const refresh = pendingRefreshes.get(pending);
    if (refresh) {
      if (!refresh.cached.positions.has(id)) return false;
      refresh.ids.add(id);
      if (refresh.ids.size > 32) invalidateTabs(windowId);
      else {
        refresh.revision++;
        tabLists.delete(null);
      }
      return true;
    }
    const cached = tabSnapshots.get(pending);
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
    else if (
      !articleChanged(id, properties, tab.windowId) &&
      !navigationChanged(id, properties, tab.windowId) &&
      !updateMetadata(id, properties, tab.windowId)
    )
      invalidateTabs(tab.windowId);
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

    // Retaining a prior resolution does not make this unfinished read current.
    isTabsRefreshPending: (windowId, structureToken) =>
      !disposed &&
      structureToken !== undefined &&
      pendingRefreshes.get(tabLists.get(windowId ?? null))?.cached.structureToken ===
        structureToken,

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
      // Closed windows can contain thousands of tabs, but only standalone closed
      // tabs are displayed. Do not retain those unused window trees in the cache.
      const fetch = async () => (await api.sessions.getRecentlyClosed()).filter(({ tab }) => tab);
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
