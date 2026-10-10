import { MODEL_KEY, TAB_KEY, VIEW_KEY, emptyModel } from '../extension/src/model.js';
import { serializeModel, serializeMembership } from '../extension/src/persistence.js';

export function memoryEvent() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),

    emit: (...args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

// A local-only adapter for the interactive preview and controller tests.
// Production always uses Firefox's APIs; preview data never touches real tabs.
export function memoryBrowser({
  groups = [],
  tabs = [],
  memberships = {},
  containers = [],
  events = false,
} = {}) {
  let liveTabs = structuredClone(tabs).map((tab) => ({
    ...(tab.active ? { lastAccessed: Date.now() } : {}),
    ...tab,
  }));
  let nextId = Math.max(0, ...liveTabs.map((tab) => tab.id)) + 1;
  let nextSessionId = 1;
  let nextContainerId =
    Math.max(0, ...containers.map((item) => Number(item.cookieStoreId.split('-').at(-1)) || 0)) + 1;
  const colorCodes = {
    blue: '#37adff',
    turquoise: '#00c79a',
    green: '#51cd00',
    yellow: '#ffcb00',
    orange: '#ff9f00',
    red: '#ff613d',
    pink: '#ff4bda',
    purple: '#af51f5',
    toolbar: '#7c7c7d',
  };
  const saved = {
    [MODEL_KEY]: serializeModel({ ...emptyModel(), groups: structuredClone(groups) }),
  };
  const tabValues = new Map(
    Object.entries(memberships).map(([id, value]) => [Number(id), serializeMembership(value)]),
  );
  const windowValues = new Map();
  const closed = [];
  const windows = new Map(
    [...new Set([1, ...liveTabs.map((tab) => tab.windowId)])].map((id) => [
      id,
      { id, incognito: false, focused: id === 1 },
    ]),
  );

  let onCreated = () => {};

  const getTab = (id) => {
    const tab = liveTabs.find((tab) => tab.id === id);
    if (!tab) throw new Error('Tab not found.');
    return tab;
  };

  const api = {
    storage: {
      local: {
        get: async (key) => ({ [key]: structuredClone(saved[key]) }),
        set: async (value) => Object.assign(saved, structuredClone(value)),
      },
    },
    sessions: {
      getRecentlyClosed: async () =>
        closed
          .slice()
          .reverse()
          .map(({ tab, sessionId, lastModified }) => ({
            tab: { ...structuredClone(tab), sessionId },
            lastModified,
          })),

      restore: async (sessionId) => {
        const index =
          sessionId === undefined
            ? closed.length - 1
            : closed.findIndex((item) => item.sessionId === sessionId);
        if (index < 0) throw new Error('Nothing to restore.');
        const [item] = closed.splice(index, 1);
        const restored = { ...item.tab, id: nextId++ };
        liveTabs.push(restored);
        tabValues.set(restored.id, item.membership);
        api.tabs.onCreated?.emit?.(structuredClone(restored));
        api.sessions.onChanged?.emit?.();
        onCreated(structuredClone(restored));
        return { tab: structuredClone(restored) };
      },

      getTabValue: async (id, key) => {
        getTab(id);
        return key === TAB_KEY ? structuredClone(tabValues.get(id)) : undefined;
      },

      setTabValue: async (id, key, value) => {
        getTab(id);
        if (key === TAB_KEY) tabValues.set(id, structuredClone(value));
      },

      getWindowValue: async (id, key) =>
        key === VIEW_KEY ? structuredClone(windowValues.get(id)) : undefined,

      setWindowValue: async (id, key, value) => {
        if (key === VIEW_KEY) windowValues.set(id, structuredClone(value));
      },
    },
    windows: {
      get: async (id) => {
        if (!windows.has(id)) throw new Error('Window not found.');
        return windows.get(id);
      },

      getAll: async () => [...windows.values()],

      update: async (id, changes) => {
        const window = await api.windows.get(id);
        if (changes.focused) for (const other of windows.values()) other.focused = false;
        Object.assign(window, changes);
        if ('focused' in changes) api.windows.onFocusChanged?.emit?.(changes.focused ? id : -1);
        return structuredClone(window);
      },
    },
    tabs: {
      query: async (query) =>
        structuredClone(
          liveTabs.filter((tab) => query.windowId === undefined || tab.windowId === query.windowId),
        ),
      get: async (id) => structuredClone(getTab(id)),

      update: async (id, changes) => {
        const tab = getTab(id);
        if (changes.active)
          liveTabs
            .filter((item) => item.windowId === tab.windowId)
            .forEach((item) => (item.active = false));
        const next = { ...changes };
        if (next.active) next.lastAccessed = Date.now();
        if ('muted' in next) {
          next.mutedInfo = { muted: next.muted };
          delete next.muted;
        }
        Object.assign(tab, next);
        api.tabs.onUpdated?.emit?.(id, structuredClone(next), structuredClone(tab));
        if (next.active) api.tabs.onActivated?.emit?.({ tabId: id, windowId: tab.windowId });
        return structuredClone(tab);
      },

      create: async (props) => {
        const tab = {
          id: nextId++,
          windowId: props.windowId ?? 1,
          index: liveTabs.length,
          title: props.url
            ? liveTabs.find((tab) => tab.url === props.url)?.title || props.url
            : 'New tab',
          url: 'about:newtab',
          groupId: -1,
          cookieStoreId: 'firefox-default',
          active: false,
          ...(props.active ? { lastAccessed: Date.now() } : {}),
          ...props,
        };
        if ('muted' in tab) {
          tab.mutedInfo = { muted: tab.muted };
          delete tab.muted;
        }
        if (tab.active)
          liveTabs
            .filter((item) => item.windowId === tab.windowId)
            .forEach((item) => (item.active = false));
        liveTabs.push(tab);
        api.tabs.onCreated?.emit?.(structuredClone(tab));
        onCreated(structuredClone(tab));
        return structuredClone(tab);
      },

      remove: async (ids) => {
        const tabs = (Array.isArray(ids) ? ids : [ids]).map(getTab);
        for (const tab of tabs) {
          closed.push({
            tab: structuredClone(tab),
            membership: structuredClone(tabValues.get(tab.id)),
            sessionId: String(nextSessionId++),
            lastModified: Date.now(),
          });
          liveTabs = liveTabs.filter((item) => item.id !== tab.id);
          tabValues.delete(tab.id);
          api.tabs.onRemoved?.emit?.(tab.id, { windowId: tab.windowId });
          api.sessions.onChanged?.emit?.();
          if (tab.active) {
            const next = liveTabs.find((item) => item.windowId === tab.windowId);
            if (next) {
              next.active = true;
              next.lastAccessed = Date.now();
              api.tabs.onActivated?.emit?.({ tabId: next.id, windowId: next.windowId });
            }
          }
        }
      },

      duplicate: async (id) => {
        const tab = getTab(id);
        const duplicate = await api.tabs.create({ ...tab, id: nextId++, active: true });
        // Firefox duplicates session values along with a tab's page state.
        if (tabValues.has(id)) tabValues.set(duplicate.id, structuredClone(tabValues.get(id)));
        return duplicate;
      },

      group: async ({ tabIds, groupId }) => {
        for (const id of tabIds) getTab(id).groupId = groupId;
        return groupId;
      },

      move: async (id, { index }) => {
        const tab = getTab(id);
        const fromIndex = tab.index;
        for (const other of liveTabs) {
          if (other.id === id || other.windowId !== tab.windowId) continue;
          if (fromIndex < index && other.index > fromIndex && other.index <= index) other.index--;
          if (fromIndex > index && other.index >= index && other.index < fromIndex) other.index++;
        }
        tab.index = index;
        api.tabs.onMoved?.emit?.(id, { windowId: tab.windowId, fromIndex, toIndex: index });
        return structuredClone(tab);
      },
    },
    contextualIdentities: {
      query: async () => structuredClone(containers),

      create: async (details) => {
        const identity = {
          ...details,
          cookieStoreId: `firefox-container-${nextContainerId++}`,
          colorCode: colorCodes[details.color],
        };
        containers.push(identity);
        api.contextualIdentities.onCreated?.emit?.({
          contextualIdentity: structuredClone(identity),
        });
        return structuredClone(identity);
      },

      update: async (cookieStoreId, details) => {
        const identity = containers.find((item) => item.cookieStoreId === cookieStoreId);
        if (!identity) throw new Error('Container not found.');
        Object.assign(identity, details, { colorCode: colorCodes[details.color] });
        api.contextualIdentities.onUpdated?.emit?.({
          contextualIdentity: structuredClone(identity),
        });
        return structuredClone(identity);
      },

      remove: async (cookieStoreId) => {
        const index = containers.findIndex((item) => item.cookieStoreId === cookieStoreId);
        if (index < 0) throw new Error('Container not found.');
        const [identity] = containers.splice(index, 1);
        api.contextualIdentities.onRemoved?.emit?.({
          contextualIdentity: structuredClone(identity),
        });
        return structuredClone(identity);
      },
    },
    testing: {
      saved,
      tabValues,
      windowValues,
      windows,

      setCreatedHandler(handler) {
        onCreated = handler;
      },

      async restore() {
        return (await api.sessions.restore()).tab;
      },

      async attach(id, windowId) {
        const oldWindowId = getTab(id).windowId;
        getTab(id).windowId = windowId;
        api.tabs.onDetached?.emit?.(id, { oldWindowId });
        api.tabs.onAttached?.emit?.(id, { newWindowId: windowId });
        if (!windows.has(windowId))
          windows.set(windowId, { id: windowId, incognito: false, focused: false });
      },
    },
  };
  if (events) {
    for (const name of [
      'onCreated',
      'onUpdated',
      'onRemoved',
      'onActivated',
      'onMoved',
      'onAttached',
      'onDetached',
    ])
      api.tabs[name] = memoryEvent();
    for (const name of ['onCreated', 'onUpdated', 'onRemoved'])
      api.contextualIdentities[name] = memoryEvent();
    api.sessions.onChanged = memoryEvent();
    api.windows.onRemoved = memoryEvent();
    api.windows.onFocusChanged = memoryEvent();
  }
  return api;
}
