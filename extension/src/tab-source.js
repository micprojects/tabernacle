import { articleUrl } from './article.js';

// Preserve the browser's original spelling when copying ordinary URLs.
export const sourceUrl = (tab) =>
  (tab.url?.startsWith('about:reader?') ? articleUrl(tab.url) : tab.url) || tab.url || '';

export function matchesText(tab, query) {
  return `${tab.title || ''} ${sourceUrl(tab)}`.toLowerCase().includes(query.trim().toLowerCase());
}
