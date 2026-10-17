import { sitePage, cleanSiteTitle, siteDetails } from './site-modes.js';
import { createSiteService } from './site-service.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createSiteView({ tree, onPermission, api = globalThis.browser }) {
  const service = createSiteService({ api });
  const visible = new Set();
  const watched = new Set();
  let tabs = new Map();
  let duplicates = new Map();
  let active = null;
  let domain = null;
  let timer;
  let epoch = 0;
  let busy = false;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      tick();
    },
    { root: tree, rootMargin: '100px 0px' },
  );

  function paint(row, tab) {
    const page = sitePage(tab.url);
    if (!page || page.mode !== active) return;
    const data = service.peek(tab);
    const title = cleanSiteTitle(data?.title || tab.title, page);
    row.querySelector('.label').textContent = title;
    const lines = siteDetails(page, data || {}).filter(Boolean);
    for (const [index, node] of [...row.querySelectorAll('.site-detail')].entries()) {
      node.textContent = lines[index] || '';
      node.hidden = !node.textContent;
      node.title = `${node.textContent}${data?.readAt ? `\nLast read ${new Date(data.readAt).toLocaleString()}` : ''}`;
    }
    row.setAttribute('aria-label', title + (row.dataset.siteAriaSuffix || ''));
    row.setAttribute(
      'aria-description',
      [row.dataset.folder, ...lines, row.querySelector('.site-related')?.textContent]
        .filter(Boolean)
        .join('. '),
    );
    const media = row.querySelector('.site-media');
    const image = media.querySelector('.site-image');
    const src = data?.image || '';
    if (image.dataset.source !== src) {
      image.dataset.source = src;
      image.hidden = true;
      media.classList.remove('has-image');
      image.removeAttribute('src');
      if (src && visible.has(row)) image.src = src;
    } else if (
      src &&
      visible.has(row) &&
      !image.hasAttribute('src') &&
      image.dataset.failed !== src
    )
      image.src = src;
  }

  async function tick() {
    if (!active || busy || document.hidden) return;
    busy = true;
    const token = epoch;
    const queue = [...visible].filter((row) => row.isConnected);
    try {
      await Promise.all(
        [0, 1].map(async () => {
          while (active && token === epoch && queue.length) {
            const row = queue.shift();
            const tab = tabs.get(Number(row.dataset.id));
            if (!tab) continue;
            paint(row, tab);
            await service.read(tab);
            if (token === epoch && row.isConnected) paint(row, tab);
          }
        }),
      );
    } finally {
      busy = false;
      // A mode may have changed while an old request was settling.
      if (active && token !== epoch) tick();
    }
  }

  return {
    prepare(nextTabs, nextDomain, mode) {
      tabs = new Map(nextTabs.map((tab) => [tab.id, tab]));
      duplicates = new Map();
      for (const tab of nextTabs) {
        const identity = sitePage(tab.url)?.identity;
        if (identity) duplicates.set(identity, (duplicates.get(identity) || 0) + 1);
      }
      service.configure(nextDomain, mode, nextTabs);
      if (active === mode && domain === nextDomain) return;
      active = mode;
      domain = nextDomain;
      epoch++;
      clearInterval(timer);
      observer.disconnect();
      watched.clear();
      visible.clear();
      if (!active) return;
      const token = epoch;
      service.permission().then((allowed) => {
        if (token !== epoch) return;
        onPermission(allowed);
        tick();
      });
      timer = setInterval(tick, 5000);
    },

    duplicateCount(tab) {
      return duplicates.get(sitePage(tab.url)?.identity) || 0;
    },

    content(tab, folder, favicon) {
      const page = sitePage(tab.url);
      const media = element('span', `site-media site-media-${page.mode}`);
      media.append(favicon);
      const image = element('img', 'site-image');
      image.alt = '';
      image.hidden = true;
      image.draggable = false;
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('load', () => {
        if (image.getAttribute('src') !== image.dataset.source) return;
        image.hidden = false;
        media.classList.add('has-image');
      });
      image.addEventListener('error', () => {
        image.dataset.failed = image.dataset.source;
        image.hidden = true;
        media.classList.remove('has-image');
      });
      media.append(image);
      const copy = element('span', 'site-copy');
      copy.append(element('span', 'label', cleanSiteTitle(tab.title, page)));
      for (const line of siteDetails(page)) {
        const node = element('span', 'site-detail', line || '');
        node.hidden = !line;
        copy.append(node);
      }
      const count = duplicates.get(page.identity) || 0;
      if (count > 1) {
        const related = element('span', 'site-related', `${page.relation} · ${count} tabs`);
        related.title =
          'These tabs refer to the same item. Their view, comment, section or selected options may differ.';
        copy.append(related);
      }
      return [media, copy];
    },

    mount() {
      if (!active) return;
      const rows = new Set(tree.querySelectorAll('.site-row'));
      for (const row of watched)
        if (!rows.has(row)) {
          observer.unobserve(row);
          watched.delete(row);
          visible.delete(row);
        }
      for (const row of rows) {
        const tab = tabs.get(Number(row.dataset.id));
        if (tab) paint(row, tab);
        if (!watched.has(row)) {
          watched.add(row);
          observer.observe(row);
        }
      }
    },

    async allow() {
      const token = epoch;
      const allowed = await service.allow();
      if (token === epoch) {
        onPermission(allowed);
        tick();
      }
      return allowed;
    },

    async refreshPermission() {
      if (!active) return;
      const token = epoch;
      const allowed = await service.permission();
      if (token === epoch) {
        onPermission(allowed);
        this.mount();
        tick();
      }
    },
  };
}
