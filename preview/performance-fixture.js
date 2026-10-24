// Deterministic fixtures shared by synthetic and isolated Firefox diagnostics.
// These addresses are never fetched by the fixture itself.
export function performanceFixture({ tabs = 60000, windows = 28, seed = 17 } = {}) {
  if (
    !Number.isInteger(tabs) ||
    tabs < 1 ||
    !Number.isInteger(windows) ||
    windows < 1 ||
    windows > tabs
  )
    throw new Error('Choose positive tab/window counts, with at least one tab per window.');
  if (!Number.isInteger(seed)) throw new Error('The fixture seed must be an integer.');
  const groups = Array.from({ length: 12 }, (_, i) => ({
    id: `perf-folder-${i}`,
    name: `Folder ${i + 1}`,
    parentId: i % 4 ? `perf-folder-${i - (i % 4)}` : null,
  }));
  const containers = ['blue', 'green', 'orange', 'purple'].map((color, i) => ({
    cookieStoreId: `firefox-container-${i + 1}`,
    name: `Fixture ${i + 1}`,
    color,
    colorCode: ['#37adff', '#51cd00', '#ff9f00', '#af51f5'][i],
    icon: 'circle',
  }));
  const memberships = new Map();
  const counts = new Map();
  const nativeTabs = Array.from({ length: tabs }, (_, i) => {
    const windowId = (i % windows) + 1;
    const index = counts.get(windowId) || 0;
    counts.set(windowId, index + 1);
    const group = Math.floor(index / 16) % groups.length;
    const parentOffset = index % 4;
    const id = i + 1;
    const ancestors = Array.from(
      { length: parentOffset },
      (_, depth) => `perf-tab-${id - (depth + 1) * windows}`,
    );
    memberships.set(id, {
      treeId: `perf-tab-${id}`,
      groupId: groups[group].id,
      order: index * 1024,
      ancestors,
      collapsed: index % 31 === 0,
      openedAt: 1700000000000 + i,
      fixtureUnknown: { retained: true },
    });
    return {
      id,
      windowId,
      index,
      active: index === 0,
      pinned: index < 2,
      discarded: index !== 0,
      title: `Fixture ${seed}: tab ${String(id).padStart(6, '0')} — window ${windowId}`,
      url: `https://fixture-${(i + seed) % 23}.invalid/page/${id}?fixture=${seed}`,
      cookieStoreId:
        index % 5 ? containers[index % containers.length].cookieStoreId : 'firefox-default',
      lastAccessed: 1700000200000 + i,
      status: 'complete',
      audible: false,
      mutedInfo: { muted: false },
      favIconUrl:
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"%3E%3Cpath fill="%236b7280" d="M2 2h12v12H2z"/%3E%3C/svg%3E',
    };
  });
  return {
    version: 1,
    seed,
    groups,
    containers,
    tabs: nativeTabs,
    memberships,
    windows: [...counts.keys()],
  };
}

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),

    emit: (...args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

// This deliberately does not call memoryBrowser: its linear getTab lookup would
// otherwise turn a 60,000-tab membership-read benchmark into an adapter benchmark.
export function performanceBrowser(
  fixture = performanceFixture(),
  { onReadConcurrency = () => {} } = {},
) {
  const native = new Map(fixture.tabs.map((tab) => [tab.id, structuredClone(tab)]));
  const byWindow = new Map(fixture.windows.map((id) => [id, new Set()]));
  for (const tab of native.values()) byWindow.get(tab.windowId).add(tab.id);
  const memberships = structuredClone(fixture.memberships);
  const views = new Map();
  const saved = { 'tabernacle.model.v1': { version: 1, groups: structuredClone(fixture.groups) } };
  const windows = new Map(
    fixture.windows.map((id) => [id, { id, incognito: false, focused: id === 1 }]),
  );
  const closed = [];
  let nextId = native.size + 1;
  let stats = { calls: {}, reads: 0, writes: 0, activeReads: 0, peakReads: 0 };
  let lastReadSample = 0;

  const sampleReads = () => {
    if (stats.activeReads > lastReadSample) {
      lastReadSample = stats.activeReads;
      onReadConcurrency(stats.activeReads);
    }
  };

  const count = (name) => {
    stats.calls[name] = (stats.calls[name] || 0) + 1;
  };

  const get = (id) => {
    const tab = native.get(id);
    if (!tab) throw new Error(`Invalid tab ID: ${id}`);
    return tab;
  };

  const inWindow = (id) => [...(byWindow.get(id) || [])].map((tabId) => native.get(tabId));
  const api = {
    runtime: {
      id: 'tabernacle@michaelprojects.com',
      getURL: (path) => `moz-extension://performance-fixture/${path}`,
      sendMessage: async () => null,
    },
    storage: {
      local: {
        get: async (key) => {
          count('storage.local.get');
          return { [key]: structuredClone(saved[key]) };
        },

        set: async (value) => {
          count('storage.local.set');
          Object.assign(saved, structuredClone(value));
        },
      },
    },
    sessions: {
      onChanged: event(),

      getTabValue: async (id, key) => {
        count('sessions.getTabValue');
        get(id);
        stats.reads++;
        stats.peakReads = Math.max(stats.peakReads, ++stats.activeReads);
        if ((stats.activeReads & (stats.activeReads - 1)) === 0) sampleReads();
        try {
          await Promise.resolve();
          get(id);
          return key === 'tabernacle.membership.v1'
            ? structuredClone(memberships.get(id))
            : undefined;
        } finally {
          if (stats.activeReads === stats.peakReads) sampleReads();
          stats.activeReads--;
        }
      },

      setTabValue: async (id, key, value) => {
        count('sessions.setTabValue');
        get(id);
        stats.writes++;
        if (key === 'tabernacle.membership.v1') memberships.set(id, structuredClone(value));
      },

      getWindowValue: async (id) => {
        count('sessions.getWindowValue');
        return structuredClone(views.get(id));
      },

      setWindowValue: async (id, _key, value) => {
        count('sessions.setWindowValue');
        views.set(id, structuredClone(value));
      },

      getRecentlyClosed: async () => {
        count('sessions.getRecentlyClosed');
        return structuredClone(closed);
      },
    },
    windows: {
      onRemoved: event(),
      onFocusChanged: event(),

      get: async (id) => {
        count('windows.get');
        if (!windows.has(id)) throw new Error('Window not found.');
        return { ...windows.get(id) };
      },

      getAll: async () => {
        count('windows.getAll');
        return [...windows.values()].map((value) => ({ ...value }));
      },

      update: async (id, changes) => {
        Object.assign(windows.get(id), changes);
        return { ...windows.get(id) };
      },
    },
    contextualIdentities: {
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),

      query: async () => {
        count('contextualIdentities.query');
        return structuredClone(fixture.containers);
      },
    },
    tabs: {
      ...Object.fromEntries(
        [
          'onCreated',
          'onRemoved',
          'onUpdated',
          'onActivated',
          'onMoved',
          'onAttached',
          'onDetached',
        ].map((name) => [name, event()]),
      ),

      query: async ({ windowId } = {}) => {
        count('tabs.query');
        return structuredClone(windowId == null ? [...native.values()] : inWindow(windowId));
      },

      get: async (id) => {
        count('tabs.get');
        return structuredClone(get(id));
      },

      update: async (id, changes) => {
        count('tabs.update');
        const tab = get(id);
        let previousTabId;
        if (changes.active) {
          for (const peer of inWindow(tab.windowId)) {
            if (peer.active) previousTabId = peer.id;
            peer.active = false;
          }
        }
        Object.assign(tab, structuredClone(changes));
        api.tabs.onUpdated.emit(id, structuredClone(changes), structuredClone(tab));
        if (changes.active)
          api.tabs.onActivated.emit({ tabId: id, windowId: tab.windowId, previousTabId });
        return structuredClone(tab);
      },

      create: async (details) => {
        count('tabs.create');
        const windowId = details.windowId ?? 1;
        const tab = {
          id: nextId++,
          windowId,
          index: byWindow.get(windowId).size,
          active: false,
          ...details,
        };
        native.set(tab.id, tab);
        byWindow.get(windowId).add(tab.id);
        api.tabs.onCreated.emit(structuredClone(tab));
        return structuredClone(tab);
      },

      remove: async (ids) => {
        count('tabs.remove');
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const tab = get(id);
          closed.unshift({
            tab: { ...structuredClone(tab), sessionId: `closed-${id}` },
            lastModified: 1700000300,
          });
          closed.splice(25);
          native.delete(id);
          byWindow.get(tab.windowId).delete(id);
          memberships.delete(id);
          api.tabs.onRemoved.emit(id, { windowId: tab.windowId, isWindowClosing: false });
        }
        api.sessions.onChanged.emit();
      },
    },
  };
  return {
    api,
    native,
    memberships,
    views,
    saved,
    tabCount: (windowId) => byWindow.get(windowId)?.size || 0,
    stats: () => structuredClone(stats),

    resetStats() {
      if (stats.activeReads) throw new Error('Cannot reset counters during a pending read.');
      stats = { calls: {}, reads: 0, writes: 0, activeReads: 0, peakReads: 0 };
      lastReadSample = 0;
    },

    closeWindow(id) {
      if (byWindow.get(id)?.size) throw new Error('Remove this fixture window’s tabs first.');
      byWindow.delete(id);
      windows.delete(id);
      views.delete(id);
      api.windows.onRemoved.emit(id);
    },
  };
}
