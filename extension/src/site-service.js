import { sitePage, siteOrigins } from './site-modes.js';
import { readSitePage, normaliseSiteData } from './site-reader.js';

export const SITE_SESSION_KEY = 'tabernacle.site-details.v1';

export function createSiteService({ api, fetcher = globalThis.fetch, now = Date.now } = {}) {
  const records = new Map();
  const attempts = new Map();
  const hydrated = new Map();
  const pending = new Map();
  let mode = null;
  let domain = null;
  let allowed = false;
  let epoch = 0;
  let abort = new AbortController();

  function reset() {
    epoch++;
    abort.abort();
    abort = new AbortController();
    attempts.clear();
  }

  function peek(tab) {
    const record = records.get(tab.id);
    return allowed && mode && record?.url === tab.url ? record : null;
  }

  function access(value) {
    if (allowed && !value) reset();
    allowed = value;
    return value;
  }

  async function permission() {
    const token = epoch;
    const origins = siteOrigins(domain, mode);
    const result =
      origins.length && (await api?.permissions?.contains({ origins }).catch(() => false));
    return token === epoch ? access(Boolean(result)) : false;
  }

  async function hydrate(tab, token) {
    if (hydrated.get(tab.id) === tab.url) return;
    hydrated.set(tab.id, tab.url);
    try {
      const saved = await api?.sessions?.getTabValue(tab.id, SITE_SESSION_KEY);
      if (token !== epoch || (tab.treeId && saved?.treeId !== tab.treeId)) return;
      const value = normaliseSiteData(saved, tab.url);
      if (value && Number.isFinite(saved.readAt))
        records.set(tab.id, { ...value, readAt: saved.readAt });
    } catch {
      /* A closing tab may no longer have session values. */
    }
  }

  async function hnDetails(tab, page, signal) {
    const response = await fetcher(`https://hacker-news.firebaseio.com/v0/item/${page.id}.json`, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) return null;
    const item = await response.json();
    if (!item || String(item.id) !== page.id || item.deleted || item.dead) return null;
    let source = '';
    try {
      source = new URL(item.url).hostname.replace(/^www\./, '');
    } catch {
      /* Text post. */
    }
    return {
      url: tab.url,
      source,
      // DOM titles are already decoded; API titles can contain HTML entities.
      // Keep Firefox's tab title when the response isn't plain text.
      title: /[<&]/.test(item.title || '') ? '' : item.title,
      kind:
        item.type === 'comment'
          ? 'Comment'
          : /^Ask HN:/.test(item.title)
            ? 'Ask HN'
            : /^Show HN:/.test(item.title)
              ? 'Show HN'
              : '',
      comments:
        Number.isSafeInteger(item.descendants) && item.descendants >= 0
          ? `${item.descendants.toLocaleString()} ${item.descendants === 1 ? 'comment' : 'comments'}`
          : '',
    };
  }

  async function read(tab) {
    const page = sitePage(tab.url);
    if (!allowed || !mode || page?.mode !== mode) return;
    if (!page.id && !page.number && !(page.site === 'maps' && page.kind === 'Place')) return;
    const token = epoch;
    await hydrate(tab, token);
    if (token !== epoch) return;
    const previous = attempts.get(tab.id);
    if (previous?.url === tab.url && previous.next > now()) return;
    let value;
    try {
      const current = await api.tabs.get(tab.id);
      if (current.url !== tab.url || token !== epoch) return;
      if (!current.discarded && current.status !== 'loading') {
        const results = await api.scripting.executeScript({
          target: { tabId: tab.id },
          func: readSitePage,
          args: [tab.url, page],
        });
        value = normaliseSiteData(results[0]?.result, tab.url);
      }
      if (token !== epoch) return;
      if (page.site === 'hn' && page.id && !value?.comments) {
        const extra = normaliseSiteData(await hnDetails(tab, page, abort.signal), tab.url);
        if (extra) value = { ...value, ...extra };
      }
      if (token !== epoch || (await api.tabs.get(tab.id)).url !== tab.url) return;
    } catch {
      /* Permission changes, unavailable pages and network failures are retried. */
    }
    if (token !== epoch) return;
    const failures = value ? 0 : (previous?.url === tab.url ? previous.failures : 0) + 1;
    attempts.set(tab.id, {
      url: tab.url,
      failures,
      next: now() + (value ? 30_000 : Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5))),
    });
    if (!value) return;
    const record = { ...value, readAt: now() };
    records.set(tab.id, record);
    if (records.size > 250) records.delete(records.keys().next().value);
    try {
      await api?.sessions?.setTabValue(tab.id, SITE_SESSION_KEY, {
        ...record,
        ...(tab.treeId ? { treeId: tab.treeId } : {}),
      });
    } catch {
      /* Tab closed. */
    }
  }

  return {
    peek,
    permission,

    configure(nextDomain, nextMode, tabs) {
      if (domain !== nextDomain || mode !== nextMode) {
        reset();
        domain = nextDomain;
        mode = nextMode;
        allowed = false;
      }
      const urls = new Map(tabs.map((tab) => [tab.id, tab.url]));
      for (const [id, value] of records) if (urls.get(id) !== value.url) records.delete(id);
      for (const [id, url] of hydrated) if (urls.get(id) !== url) hydrated.delete(id);
      for (const id of attempts.keys()) if (!urls.has(id)) attempts.delete(id);
    },

    async allow() {
      const token = epoch;
      const origins = siteOrigins(domain, mode);
      const result = origins.length && (await api?.permissions?.request({ origins }));
      return token === epoch ? access(Boolean(result)) : false;
    },

    read(tab) {
      const key = `${epoch}:${tab.id}:${tab.url}`;
      if (!pending.has(key))
        pending.set(
          key,
          read(tab).finally(() => pending.delete(key)),
        );
      return pending.get(key);
    },
  };
}
