import { TAB_KEY } from './model.js';
import { deserializeMembership, serializeMembership } from './persistence.js';

// Cache only data with an explicit invalidation path. Memberships belong to this
// extension; native tabs, containers and closed sessions have Firefox events.
export function createBrowserCache(api, changed = () => {}) {
  const memberships = new Map();
  const tabLists = new Map();
  const ancillary = new Map();
  const listeners = [];

  const watch = (event, listener) => {
    if (!event?.addListener) return;
    event.addListener(listener);
    listeners.push(() => event.removeListener?.(listener));
  };

  async function read(cache, key, fetch) {
    for (;;) {
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(fetch));
      const pending = cache.get(key);
      let value;
      try {
        value = await pending;
      } catch (error) {
        if (cache.get(key) === pending) cache.delete(key);
        throw error;
      }
      // An event during the read invalidates its result too.
      if (cache.get(key) === pending) return value;
    }
  }

  function invalidateTabs(windowId) {
    tabLists.delete(null);
    if (windowId == null) tabLists.clear();
    else tabLists.delete(windowId);
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
  ]);
  watch(api.tabs.onUpdated, (_id, properties, tab) => {
    invalidateTabs(tab.windowId);
    if (Object.keys(properties).some((key) => visibleProperties.has(key)))
      changed({ windowId: tab.windowId });
  });
  watch(api.tabs.onCreated, (tab) => tabChanged(tab.windowId));
  watch(api.tabs.onRemoved, (id, info) => tabChanged(info.windowId, id));
  watch(api.tabs.onActivated, (info) => tabChanged(info.windowId));
  watch(api.tabs.onMoved, (_id, info) => tabChanged(info.windowId));
  watch(api.tabs.onAttached, (_id, info) => tabChanged(info.newWindowId));
  watch(api.tabs.onDetached, (_id, info) => tabChanged(info.oldWindowId));
  watch(api.windows.onRemoved, (windowId) => tabChanged(windowId));
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
    invalidateContainers: () => ancillary.delete('containers'),
    invalidateHistory: () => ancillary.delete('history'),

    async tabs(windowId = null) {
      // Adapters without lifecycle events can still use the controller safely.
      if (!api.tabs.onUpdated) return api.tabs.query(windowId == null ? {} : { windowId });
      const tabs = await read(tabLists, windowId, () =>
        api.tabs.query(windowId == null ? {} : { windowId }),
      );
      if (windowId === null) {
        const windows = new Map();
        for (const tab of tabs) {
          if (!windows.has(tab.windowId)) windows.set(tab.windowId, []);
          windows.get(tab.windowId).push(tab);
        }
        for (const [id, values] of windows)
          if (!tabLists.has(id)) tabLists.set(id, Promise.resolve(values));
      }
      return tabs;
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
      memberships.set(id, Promise.resolve(structuredClone(value)));
    },

    forgetMembership: (id) => memberships.delete(id),

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

    dispose() {
      for (const stop of listeners) stop();
      memberships.clear();
      tabLists.clear();
      ancillary.clear();
    },
  };
}
