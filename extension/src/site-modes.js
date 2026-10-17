// URL-derived context stays useful without page access. Only recognised routes
// have an identity; searches and homepages never become duplicate content.
export const SITE_MODES = {
  reddit: { name: 'Reddit', access: 'post previews and discussion details' },
  hn: { name: 'Hacker News', access: 'story sources and discussion details' },
  github: { name: 'GitHub', access: 'issue and pull request status' },
  shopping: { name: 'Shopping', access: 'product images, prices and selected options' },
  wiki: { name: 'Wikipedia', access: 'article descriptions and images' },
  docs: { name: 'Documents', access: 'document names and the current sheet or slide' },
  maps: { name: 'Maps', access: 'place names and addresses' },
  film: { name: 'Film', access: 'posters, release years, runtime and directors' },
};

export const AMAZON_DOMAINS = [
  'amazon.com',
  'amazon.co.uk',
  'amazon.de',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.ca',
  'amazon.com.au',
  'amazon.co.jp',
  'amazon.in',
  'amazon.nl',
  'amazon.se',
];
export const EBAY_DOMAINS = [
  'ebay.com',
  'ebay.co.uk',
  'ebay.de',
  'ebay.fr',
  'ebay.it',
  'ebay.es',
  'ebay.ca',
  'ebay.com.au',
];
export const GOOGLE_DOMAINS = [
  'google.com',
  'google.co.uk',
  'google.de',
  'google.fr',
  'google.it',
  'google.es',
  'google.ca',
  'google.com.au',
  'google.co.jp',
  'google.co.in',
];
export const SITE_ORIGINS = [
  'https://*.reddit.com/*',
  'https://news.ycombinator.com/*',
  'https://hacker-news.firebaseio.com/*',
  'https://github.com/*',
  ...[
    ...AMAZON_DOMAINS,
    ...EBAY_DOMAINS,
    'etsy.com',
    'wikipedia.org',
    ...GOOGLE_DOMAINS,
    'imdb.com',
    'letterboxd.com',
  ].map((host) => `https://*.${host}/*`),
];

const belongs = (host, domain) => host === domain || host.endsWith(`.${domain}`);

export function siteModeForDomain(domain, tabs = []) {
  if (!domain) return null;
  if (belongs(domain, 'reddit.com')) return 'reddit';
  if (domain === 'news.ycombinator.com') return 'hn';
  if (domain === 'github.com') return 'github';
  if ([...AMAZON_DOMAINS, ...EBAY_DOMAINS, 'etsy.com'].some((d) => belongs(domain, d)))
    return 'shopping';
  if (belongs(domain, 'wikipedia.org')) return 'wiki';
  if (domain === 'docs.google.com') return 'docs';
  if (['imdb.com', 'letterboxd.com'].some((d) => belongs(domain, d))) return 'film';
  if (
    GOOGLE_DOMAINS.some((d) => domain === d || domain === `maps.${d}`) &&
    (domain.startsWith('maps.') || tabs.some((tab) => sitePage(tab.url)?.mode === 'maps'))
  )
    return 'maps';
  return null;
}

export function siteOrigins(domain, mode) {
  const host = domain?.replace(/^www\./, '');
  if (mode === 'hn')
    return ['https://news.ycombinator.com/*', 'https://hacker-news.firebaseio.com/*'];
  // Grant only the host family currently being viewed, never every shopping or
  // Google domain merely because they share a renderer.
  if (host === 'docs.google.com') return ['https://docs.google.com/*'];
  if (mode === 'maps')
    return host.startsWith('maps.')
      ? [`https://${host}/*`]
      : [`https://${host}/*`, `https://www.${host}/*`];
  const base = [
    ...AMAZON_DOMAINS,
    ...EBAY_DOMAINS,
    ...GOOGLE_DOMAINS,
    'reddit.com',
    'etsy.com',
    'wikipedia.org',
    'imdb.com',
    'letterboxd.com',
  ].find((d) => belongs(host || '', d));
  return base ? [`https://*.${base}/*`] : host === 'github.com' ? ['https://github.com/*'] : [];
}

export function sitePage(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const path = url.pathname;
    const page = { host, mode: null, kind: '', context: '', identity: '', relation: '' };
    if (belongs(host, 'reddit.com')) {
      page.mode = 'reddit';
      page.site = 'reddit';
      if (parts[0] === 'r' && parts[1]) page.context = `r/${parts[1]}`;
      const index = parts.indexOf('comments');
      if (index >= 0 && /^[a-z\d]+$/i.test(parts[index + 1] || '')) {
        page.kind = parts[index + 3] ? 'Comment' : 'Post';
        page.id = parts[index + 1];
        page.identity = `reddit:${page.id}`;
        page.relation = 'Same thread';
      } else page.kind = parts[0] === 'r' && parts.length === 2 ? 'Community' : '';
    } else if (host === 'news.ycombinator.com') {
      page.mode = 'hn';
      page.site = 'hn';
      if (path === '/item' && /^\d+$/.test(url.searchParams.get('id') || '')) {
        page.id = url.searchParams.get('id');
        page.identity = `hn:${page.id}`;
        page.relation = 'Same item';
      }
    } else if (host === 'github.com') {
      page.mode = 'github';
      page.site = 'github';
      if (
        parts.length >= 2 &&
        ![
          'settings',
          'orgs',
          'users',
          'search',
          'marketplace',
          'features',
          'topics',
          'collections',
        ].includes(parts[0])
      ) {
        page.context = `${parts[0]}/${parts[1]}`;
        const kind = {
          issues: 'Issue',
          pull: 'Pull request',
          discussions: 'Discussion',
          releases: 'Release',
          blob: 'File',
          tree: 'Code',
          commit: 'Commit',
          wiki: 'Wiki',
          actions: 'Actions',
        }[parts[2]];
        page.kind = kind || (parts.length === 2 ? 'Repository' : '');
        if (['issues', 'pull', 'discussions'].includes(parts[2]) && /^\d+$/.test(parts[3] || '')) {
          page.number = parts[3];
          page.kind += ` #${page.number}`;
          page.identity = `github:${page.context}/${parts[2]}/${page.number}`;
          page.relation = 'Same item';
        }
      }
    } else if (AMAZON_DOMAINS.some((d) => belongs(host, d))) {
      page.mode = 'shopping';
      page.site = 'amazon';
      const id = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z\d]{10})(?:\/|$)/i.exec(path)?.[1];
      if (id) {
        page.id = id.toUpperCase();
        page.kind = 'Product';
        page.identity = `${host}:${page.id}`;
        page.relation = 'Same product';
      }
    } else if (EBAY_DOMAINS.some((d) => belongs(host, d))) {
      page.mode = 'shopping';
      page.site = 'ebay';
      const id = /\/itm\/(?:[^/]+\/)?(\d+)(?:\/|$)/.exec(path)?.[1];
      if (id) {
        page.id = id;
        page.kind = 'Listing';
        page.identity = `${host}:${id}`;
        page.relation = 'Same listing';
      }
    } else if (belongs(host, 'etsy.com')) {
      page.mode = 'shopping';
      page.site = 'etsy';
      const listing = parts.indexOf('listing');
      if (listing >= 0 && listing <= 1 && /^\d+$/.test(parts[listing + 1] || '')) {
        page.id = parts[listing + 1];
        page.kind = 'Listing';
        page.identity = `etsy:${page.id}`;
        page.relation = 'Same listing';
      }
    } else if (belongs(host, 'wikipedia.org')) {
      page.mode = 'wiki';
      page.site = 'wiki';
      if (
        parts[0] === 'wiki' &&
        parts[1] &&
        !/^(?:Special|Talk|User|Wikipedia|File|Category|Help|Template|Portal):/i.test(parts[1])
      ) {
        page.id = parts.slice(1).join('/');
        page.context = host.split('.')[0].toUpperCase();
        page.identity = `${host}:${page.id}`;
        page.relation = 'Same article';
        if (url.hash) page.location = decodeURIComponent(url.hash.slice(1)).replaceAll('_', ' ');
      }
    } else if (host === 'docs.google.com') {
      page.mode = 'docs';
      page.site = 'docs';
      page.kind =
        { document: 'Document', spreadsheets: 'Spreadsheet', presentation: 'Presentation' }[
          parts[0]
        ] || '';
      const d = parts.indexOf('d');
      const fileId = parts[d + 1] === 'e' ? parts[d + 2] : parts[d + 1];
      if (page.kind && d >= 0 && /^[\w-]+$/.test(fileId || '')) {
        page.id = fileId;
        page.identity = `docs:${parts[0]}:${page.id}`;
        page.relation = 'Same file';
        if (parts.includes('pub') || parts.includes('pubhtml')) page.location = 'Published view';
        else if (parts.includes('preview')) page.location = 'Preview';
      }
    } else if (
      GOOGLE_DOMAINS.some((d) => host === d || host === `maps.${d}`) &&
      (host.startsWith('maps.') || parts[0] === 'maps')
    ) {
      page.mode = 'maps';
      page.site = 'maps';
      const mapParts = parts[0] === 'maps' ? parts.slice(1) : parts;
      page.kind = { place: 'Place', dir: 'Directions', search: 'Search' }[mapParts[0]] || 'Map';
      if (mapParts[0] === 'place') page.name = (mapParts[1] || '').replaceAll('+', ' ');
      // Place names are not unique. Do not infer duplicate places from a name.
    } else if (belongs(host, 'imdb.com')) {
      page.mode = 'film';
      page.site = 'imdb';
      if (parts[0] === 'title' && /^tt\d+$/.test(parts[1] || '')) {
        page.id = parts[1];
        page.identity = `imdb:${page.id}`;
        page.relation = 'Same title';
        page.kind = parts[2] === 'reviews' ? 'Reviews' : '';
      }
    } else if (belongs(host, 'letterboxd.com')) {
      page.mode = 'film';
      page.site = 'letterboxd';
      const f = parts.indexOf('film');
      if (f >= 0 && parts[f + 1]) {
        page.id = parts[f + 1];
        page.identity = `letterboxd:${page.id}`;
        page.relation = 'Same film';
        if (f > 0) page.kind = `${parts[0]}’s review`;
      }
    }
    return page.mode ? page : null;
  } catch {
    return null;
  }
}

export function cleanSiteTitle(title, page) {
  let value = (title || page?.name || 'Untitled tab').replace(/^\(\d+\)\s+/, '');
  const suffixes = {
    reddit: /\s*(?:[|:–—-]\s*Reddit|:\s*r\/[^\s]+)$/i,
    hn: /\s*\|\s*Hacker News$/i,
    github: /\s*·\s*(?:Issue|Pull Request|Discussion)\s*#\d+\s*·.*$|\s*·\s*GitHub$/i,
    wiki: /\s*[-–—]\s*Wikipedia$/i,
    docs: /\s*[-–—]\s*Google (?:Docs|Sheets|Slides)$/i,
    maps: /\s*[-–—]\s*Google Maps$/i,
    film: /\s*[-–—]\s*IMDb$|\s*•\s*.*Letterboxd$/i,
    shopping: /\s*[-–—|]\s*(?:Etsy|eBay)(?:\s.*)?$/i,
  };
  value = value.replace(suffixes[page?.mode] || /$^/, '');
  return value.trim() || title || 'Untitled tab';
}

export function siteDetails(page, data = {}) {
  const join = (...parts) => parts.filter(Boolean).join(' · ');
  switch (page.mode) {
    case 'reddit':
      return [
        join(page.context, page.kind === 'Comment' ? 'Comment' : ''),
        join(data.flair, data.comments),
      ];
    case 'hn':
      return [join(data.source, data.kind), data.comments];
    case 'github':
      return [join(page.context, page.kind), data.status];
    case 'shopping':
      return [data.price, data.variant];
    case 'wiki':
      return [data.description, page.location ? `§ ${page.location}` : ''];
    case 'docs':
      return [page.kind, data.location || page.location];
    case 'maps':
      return [data.category || (page.kind !== 'Place' ? page.kind : ''), data.address];
    case 'film':
      return [
        join(data.year, data.duration, page.kind),
        data.director ? `Dir. ${data.director}` : '',
      ];
    default:
      return [];
  }
}
