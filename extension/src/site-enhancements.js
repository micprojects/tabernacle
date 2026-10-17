import {
  SITE_MODES,
  AMAZON_DOMAINS,
  EBAY_DOMAINS,
  GOOGLE_DOMAINS,
  siteOrigins,
} from './site-modes.js';
import { YOUTUBE_ORIGINS } from './youtube.js';

const domains = {
  reddit: ['reddit.com'],
  hn: ['news.ycombinator.com'],
  github: ['github.com'],
  shopping: [...AMAZON_DOMAINS, ...EBAY_DOMAINS, 'etsy.com'],
  wiki: ['wikipedia.org'],
  docs: ['docs.google.com'],
  maps: GOOGLE_DOMAINS.flatMap((domain) => [domain, `maps.${domain}`]),
  film: ['imdb.com', 'letterboxd.com'],
};

const favicons = {
  reddit: ['reddit.png'],
  hn: ['hacker-news.ico'],
  github: ['github.svg'],
  shopping: ['amazon.ico', 'ebay.ico', 'etsy.png'],
  wiki: ['wikipedia.ico'],
  docs: ['google-docs.ico', 'google-sheets.ico', 'google-slides.ico'],
  maps: ['google-maps.ico'],
  film: ['imdb.png', 'letterboxd.ico'],
};

export const SITE_ENHANCEMENTS = [
  {
    id: 'youtube',
    name: 'YouTube',
    description: 'Video thumbnails, channels, duration and observed progress.',
    favicons: ['youtube.png'],
    sites: [{ domain: 'youtube.com', origins: YOUTUBE_ORIGINS }],
  },
  ...Object.entries(SITE_MODES).map(([id, mode]) => ({
    id,
    name: mode.name,
    description: `${mode.access[0].toUpperCase()}${mode.access.slice(1)}.`,
    favicons: favicons[id],
    sites: domains[id].map((domain) => ({ domain, origins: siteOrigins(domain, id) })),
  })),
];

// Compare the host match patterns returned by Firefox, including broad grants
// shared with article previews. Never remove a grant covering unrelated sites.
function pattern(value) {
  if (value === '<all_urls>') return { scheme: '*', host: '*' };
  const match = /^(\*|https?):\/\/([^/]+)\/.*$/.exec(value);
  return match ? { scheme: match[1], host: match[2] } : null;
}

export function coversOrigin(grant, origin) {
  const outer = pattern(grant);
  const inner = pattern(origin);
  if (!outer || !inner || (outer.scheme !== '*' && outer.scheme !== inner.scheme)) return false;
  if (outer.host === '*' || outer.host === inner.host) return true;
  if (!outer.host.startsWith('*.')) return false;
  const domain = outer.host.slice(2);
  return inner.host === domain || inner.host.endsWith(`.${domain}`);
}

export async function siteAccess(permissions, origins) {
  const [grants, checks] = await Promise.all([
    permissions.getAll(),
    Promise.all(origins.map((origin) => permissions.contains({ origins: [origin] }))),
  ]);
  const relevant = (grants.origins || []).filter((grant) =>
    origins.some((origin) => coversOrigin(grant, origin) || coversOrigin(origin, grant)),
  );
  const removable = relevant.filter((grant) =>
    origins.some((origin) => coversOrigin(origin, grant)),
  );
  return {
    allowed: checks.every(Boolean),
    any: checks.some(Boolean) || relevant.length > 0,
    wider: relevant.some((grant) => !removable.includes(grant)),
    removable,
  };
}
