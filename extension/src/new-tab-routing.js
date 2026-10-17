import { MODEL_KEY, TAB_KEY } from './model.js';

// Do not register a permanent chrome_url_overrides entry. Only fresh Firefox
// Home tabs are eligible; ordinary navigation, blank tabs and other overrides
// are never intercepted. Listeners register before the event page's first await.
export function createNewTabRouting(api) {
  let enabled = false;
  let version = 0;
  const pending = new Map();
  const ready = api.storage.local
    .get(MODEL_KEY)
    .then((saved) => {
      if (!version) enabled = saved[MODEL_KEY]?.newTab?.enabled === true;
    })
    .catch(() => {});

  const changed = (changes, area) => {
    if (area !== 'local' || !changes[MODEL_KEY]) return;
    version++;
    enabled = changes[MODEL_KEY].newValue?.newTab?.enabled === true;
    if (!enabled) pending.clear();
  };

  async function redirect(tab, started) {
    await ready;
    if (!enabled || tab.incognito || tab.discarded || Date.now() - started > 5000) return;
    const saved = await api.sessions.getTabValue(tab.id, TAB_KEY);
    // Restores and duplicates carry prior membership, unlike a fresh blank tab.
    if (saved && (!saved.openedAt || saved.openedAt < started - 1000)) return;
    const current = await api.tabs.get(tab.id);
    if (
      !enabled ||
      current.url !== 'about:newtab' ||
      (current.pendingUrl && current.pendingUrl !== 'about:newtab')
    )
      return;
    await api.tabs.update(tab.id, {
      url: api.runtime.getURL('new-tab.html?start=1'),
      loadReplace: true,
    });
  }

  const safelyRedirect = (tab, started) => redirect(tab, started).catch(() => {});

  const created = (tab) => {
    if (tab.incognito || tab.discarded) return;
    const started = Date.now();
    if (tab.url === 'about:newtab') safelyRedirect(tab, started);
    else if (!tab.url || tab.url === 'about:blank') {
      for (const [id, time] of pending) if (started - time > 5000) pending.delete(id);
      pending.set(tab.id, started);
      if (pending.size > 100) pending.delete(pending.keys().next().value);
    }
  };

  const updated = (id, change, tab) => {
    if (!pending.has(id) || !change.url) return;
    const started = pending.get(id);
    pending.delete(id);
    if (change.url === 'about:newtab') safelyRedirect(tab, started);
  };

  const removed = (id) => pending.delete(id);
  api.storage.onChanged.addListener(changed);
  api.tabs.onCreated.addListener(created);
  api.tabs.onUpdated.addListener(updated);
  api.tabs.onRemoved.addListener(removed);
  return {
    dispose() {
      api.storage.onChanged.removeListener(changed);
      api.tabs.onCreated.removeListener(created);
      api.tabs.onUpdated.removeListener(updated);
      api.tabs.onRemoved.removeListener(removed);
      pending.clear();
    },
  };
}
