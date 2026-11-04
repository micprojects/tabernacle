import { MODEL_KEY, TAB_KEY } from '../model.js';

// Do not register a permanent chrome_url_overrides entry. Only fresh Firefox
// Home tabs are eligible; ordinary navigation, blank tabs and other overrides
// are never intercepted. Listeners register before the event page's first await.
export function createNewTabRouting(api) {
  let enabled = false;
  let version = 0;
  const pending = new Map();
  const freshMemberships = new Map();
  let preferencesLoaded = false;
  let preferenceRead;

  function readPreference() {
    if (preferencesLoaded) return Promise.resolve();
    if (!preferenceRead) {
      const currentVersion = version;
      preferenceRead = api.storage.local
        .get(MODEL_KEY)
        .then((saved) => {
          if (version === currentVersion) {
            enabled = saved[MODEL_KEY]?.newTab?.enabled === true;
            preferencesLoaded = true;
          }
        })
        .finally(() => {
          preferenceRead = undefined;
        });
    }
    return preferenceRead;
  }

  // A failed initial load leaves routing undecided; the next fresh tab retries.
  // Share pending reads, and never replace a newer saved choice with a late read.
  readPreference().catch(() => {});

  const changed = (changes, area) => {
    if (area !== 'local' || !changes[MODEL_KEY]) return;
    version++;
    preferencesLoaded = true;
    enabled = changes[MODEL_KEY].newValue?.newTab?.enabled === true;
    if (!enabled) pending.clear();
  };

  async function redirect(tab, started) {
    // Capture membership before waiting for startup. Only an identity explicitly
    // assigned to this fresh tab can exempt an existing record from restore checks.
    const [saved] = await Promise.all([
      api.sessions.getTabValue(tab.id, TAB_KEY),
      readPreference(),
    ]);
    if (!enabled || tab.incognito || tab.discarded || Date.now() - started > 5000) return;
    const fresh = freshMemberships.get(tab.id);
    if (saved && (!fresh || saved.treeId !== fresh.treeId || fresh.expiresAt < Date.now())) return;
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
    freshMemberships.delete(tab.id);
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

  const removed = (id) => {
    pending.delete(id);
    freshMemberships.delete(id);
  };

  api.storage.onChanged.addListener(changed);
  api.tabs.onCreated.addListener(created);
  api.tabs.onUpdated.addListener(updated);
  api.tabs.onRemoved.addListener(removed);
  return {
    recordFreshMembership(id, treeId) {
      const now = Date.now();
      for (const [id, record] of freshMemberships)
        if (record.expiresAt < now) freshMemberships.delete(id);
      freshMemberships.set(id, { treeId, expiresAt: now + 5000 });
      if (freshMemberships.size > 100)
        freshMemberships.delete(freshMemberships.keys().next().value);
    },

    dispose() {
      api.storage.onChanged.removeListener(changed);
      api.tabs.onCreated.removeListener(created);
      api.tabs.onUpdated.removeListener(updated);
      api.tabs.onRemoved.removeListener(removed);
      pending.clear();
      freshMemberships.clear();
    },
  };
}
