import { articleUrl, articleOrigin, normaliseArticle, readArticle } from './article.js';

export const ARTICLE_SESSION_KEY = 'tabernacle.article.v1';
export const ARTICLE_ORIGINS = ['http://*/*', 'https://*/*'];
const files = ['Readability.js', 'Readability-readerable.js'].map(
  (name) => `vendor/readability/${name}`,
);

export function createArticleService({ api, now = Date.now } = {}) {
  const records = new Map();
  const attempts = new Map();
  const hydrated = new Map();
  const permissions = new Map();
  const pending = new Map();
  let tabs = new Map();
  let active = false;
  let epoch = 0;
  const identity = (tab) => `${tab.treeId || ''}:${articleUrl(tab.url)}`;
  const current = (tab, token) =>
    active && token === epoch && identity(tabs.get(tab.id) || {}) === identity(tab);

  function allowed(tab) {
    return permissions.get(articleOrigin(tab.url)) === true;
  }

  function peek(tab) {
    const record = records.get(tab.id);
    return allowed(tab) && record?.identity === identity(tab) ? record : null;
  }

  async function permission(tab, token) {
    const origin = articleOrigin(tab.url);
    if (!origin) return false;
    if (!permissions.has(origin)) {
      const result = await api?.permissions?.contains({ origins: [origin] }).catch(() => false);
      if (token !== epoch) return false;
      permissions.set(origin, Boolean(result));
    }
    return allowed(tab);
  }

  async function read(tab) {
    const token = epoch;
    const url = articleUrl(tab.url);
    if (!url || !current(tab, token) || !(await permission(tab, token))) return;
    if (!current(tab, token)) return;
    const key = identity(tab);
    if (hydrated.get(tab.id) !== key) {
      hydrated.set(tab.id, key);
      try {
        const saved = await api?.sessions?.getTabValue(tab.id, ARTICLE_SESSION_KEY);
        if (!current(tab, token)) return;
        const value = saved?.treeId === tab.treeId && normaliseArticle(saved, url);
        if (value && Number.isFinite(saved.readAt))
          records.set(tab.id, { ...value, identity: key, readAt: saved.readAt });
      } catch {
        // A closing tab may no longer have session data.
      }
    }
    const previous = attempts.get(tab.id);
    if (previous?.identity === key && previous.next > now()) return;
    let value;
    try {
      const native = await api.tabs.get(tab.id);
      if (!current(tab, token) || articleUrl(native.url) !== url) return;
      // Reader View is protected browser UI. Its source preview is retained.
      if (native.discarded || native.status === 'loading' || native.isInReaderMode) return;
      if (native.url !== url) return;
      await api.scripting.executeScript({ target: { tabId: tab.id }, files });
      if (!current(tab, token)) return;
      const result = await api.scripting.executeScript({
        target: { tabId: tab.id },
        func: readArticle,
        args: [url],
      });
      value = normaliseArticle(result[0]?.result, url);
      if (!current(tab, token) || articleUrl((await api.tabs.get(tab.id)).url) !== url) return;
    } catch {
      // Unsupported pages and permission changes leave the ordinary saved row usable.
    }
    if (!current(tab, token)) return;
    const failures = value ? 0 : (previous?.identity === key ? previous.failures : 0) + 1;
    attempts.set(tab.id, {
      identity: key,
      failures,
      next: now() + (value ? 300_000 : Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4))),
    });
    if (!value) return;
    const record = { ...value, identity: key, readAt: now() };
    records.set(tab.id, record);
    try {
      await api.sessions.setTabValue(tab.id, ARTICLE_SESSION_KEY, {
        ...value,
        readAt: record.readAt,
        treeId: tab.treeId,
      });
    } catch {
      // Tab closed. Only the small preview is stored, never the article body.
    }
  }

  return {
    allowed,
    peek,

    configure(nextTabs, enabled) {
      if (active !== enabled) epoch++;
      active = enabled;
      tabs = new Map(nextTabs.map((tab) => [tab.id, tab]));
      for (const [id, record] of records)
        if (identity(tabs.get(id) || {}) !== record.identity) records.delete(id);
      for (const [id, key] of hydrated)
        if (identity(tabs.get(id) || {}) !== key) hydrated.delete(id);
      for (const [id, record] of attempts)
        if (identity(tabs.get(id) || {}) !== record.identity) attempts.delete(id);
    },

    refreshPermissions() {
      epoch++;
      permissions.clear();
      attempts.clear();
    },

    async hasAllAccess() {
      return Boolean(await api?.permissions?.contains({ origins: ARTICLE_ORIGINS }));
    },

    // Request before the first await to preserve Firefox's click gesture.
    async allowAll() {
      const result = await api?.permissions?.request({ origins: ARTICLE_ORIGINS });
      // Refresh every host, including denials cached before the all-sites grant.
      this.refreshPermissions();
      return Boolean(result);
    },

    async removeAllAccess() {
      const result = await api?.permissions?.remove({ origins: ARTICLE_ORIGINS });
      this.refreshPermissions();
      return Boolean(result);
    },

    read(tab) {
      const key = `${epoch}:${tab.id}:${identity(tab)}`;
      if (!pending.has(key))
        pending.set(
          key,
          read(tab).finally(() => pending.delete(key)),
        );
      return pending.get(key);
    },
  };
}
