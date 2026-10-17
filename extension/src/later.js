import { isSavedForLater } from './model.js';
import { articleUrl } from './article.js';

export const laterFilters = {
  all: 'All',
  articles: 'Articles',
  videos: 'Videos',
  documents: 'Documents',
};

// Native detection and permitted previews supplement conservative URL hints.
export function laterCategory(value) {
  const tab = typeof value === 'object' && value ? value : null;
  if (tab?.isArticle || tab?.isInReaderMode || tab?.articlePreview) return 'articles';
  value = tab ? tab.url : value;
  let url;
  try {
    url = new URL(articleUrl(value) || value);
  } catch {
    return 'other';
  }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) return 'other';
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  const path = url.pathname;
  const belongs = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (
    /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i.test(path) ||
    (host === 'docs.google.com' &&
      /^\/(document|spreadsheets|presentation|forms)\/d\//.test(path)) ||
    (host === 'drive.google.com' && /^\/file\/d\//.test(path)) ||
    (belongs('notion.so') && /[a-f\d]{32}\/?$/i.test(path))
  )
    return 'documents';
  if (
    /\.(mp4|webm|mov|m4v)$/i.test(path) ||
    (belongs('youtube.com') &&
      ((path === '/watch' && /^[\w-]{11}$/.test(url.searchParams.get('v') || '')) ||
        /^\/(shorts|embed|live)\/[\w-]{11}(?:\/|$)/.test(path))) ||
    (host === 'youtu.be' && /^\/[\w-]{11}\/?$/.test(path)) ||
    (belongs('vimeo.com') && /^\/(?:video\/)?\d+\/?$/.test(path)) ||
    (belongs('twitch.tv') && /^\/videos\/\d+/.test(path))
  )
    return 'videos';
  if (
    (belongs('wikipedia.org') && /^\/wiki\/[^/:]+$/.test(path) && !/\/Main_Page$/.test(path)) ||
    (host === 'developer.mozilla.org' && /^\/[^/]+\/docs\/.+/.test(path)) ||
    /\/(articles?|posts?|blog|p)\/[^/]+/i.test(path) ||
    /\/\d{4}\/\d{2}\/\d{2}\/[^/]+/.test(path) ||
    (['bbc.co.uk', 'bbc.com'].some(belongs) && /^\/news\/.+-\d+$/.test(path)) ||
    (belongs('medium.com') && /-[a-f\d]{8,}\/?$/i.test(path))
  )
    return 'articles';
  return 'other';
}

export function laterResults(tabs, { category = 'all', query = '', sort = 'newest', tabIds } = {}) {
  const search = query.trim().toLowerCase();
  const included = Array.isArray(tabIds) ? new Set(tabIds) : null;
  return tabs
    .filter(
      (tab) =>
        isSavedForLater(tab) &&
        (included
          ? included.has(tab.id)
          : (category === 'all' || laterCategory(tab) === category) &&
            `${tab.title || ''} ${articleUrl(tab.url) || tab.url || ''} ${tab.articlePreview?.title || ''} ${tab.articlePreview?.byline || ''}`
              .toLowerCase()
              .includes(search)),
    )
    .sort(
      (a, b) =>
        (a.savedForLaterAt - b.savedForLaterAt) * (sort === 'oldest' ? 1 : -1) ||
        (a.index ?? 0) - (b.index ?? 0) ||
        a.id - b.id,
    );
}

export function laterAge(time, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  const days = Math.floor(minutes / 1440);
  return days === 1 ? '1d ago' : `${days}d ago`;
}
