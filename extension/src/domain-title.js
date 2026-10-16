import { domainFromUrl } from './domain-filter.js';

const separator = /\s+(?:[|–—·•-]|::)\s+/u;
const genericTitle =
  /^(?:home(?:\s?page)?|index|untitled|new tab|loading|just a moment|access denied|sign in|log in|error|(?:403|404|500)(?:\s.*)?)[.!…\s]*$/i;

function cleanTitle(value, domain, maxLength = 160) {
  if (typeof value !== 'string') return null;
  const title = value
    .trim()
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s+/gu, ' ');
  if (
    !title ||
    title.length > maxLength ||
    genericTitle.test(title) ||
    /^(?:https?:\/\/|www\.)/i.test(title) ||
    title.toLowerCase() === domain
  )
    return null;
  return title;
}

// Use evidence already supplied by open tabs. A page's own article/video title
// is not a site name, and child hosts may belong to different products.
export function resolveDomainTitle(domain, tabs) {
  const homeTitles = new Map();
  const suffixes = new Map();
  for (const tab of tabs) {
    if (domainFromUrl(tab.url) !== domain || tab.status === 'loading') continue;
    const title = cleanTitle(tab.title, domain, 4096);
    if (!title) continue;
    const url = new URL(tab.url);
    if (
      title.length <= 160 &&
      /^\/(?:index\.html?)?$/i.test(url.pathname) &&
      !url.search &&
      !url.hash
    )
      homeTitles.set(title.toLowerCase(), title);
    const parts = title.split(separator);
    if (parts.length < 2) continue;
    const suffix = cleanTitle(parts.at(-1), domain);
    if (!suffix) continue;
    const key = suffix.toLowerCase();
    const evidence = suffixes.get(key) || { title: suffix, pages: new Set(), titles: new Set() };
    url.hash = '';
    evidence.pages.add(url.href);
    evidence.titles.add(title.toLowerCase());
    suffixes.set(key, evidence);
  }
  if (homeTitles.size === 1) return [...homeTitles.values()][0];
  const shared = [...suffixes.values()].filter(
    ({ pages, titles }) => pages.size >= 2 && titles.size >= 2,
  );
  return shared.length === 1 ? shared[0].title : null;
}
