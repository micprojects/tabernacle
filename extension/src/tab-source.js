// Resolve HTTP(S) identity, including tabs opened in Firefox’s own Reader View.
export function httpUrl(value) {
  try {
    let url = new URL(value);
    if (url.protocol === 'about:' && url.pathname === 'reader')
      url = new URL(url.searchParams.get('url'));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// Preserve the browser's original spelling when copying ordinary URLs.
export const sourceUrl = (tab) =>
  (tab.url?.startsWith('about:reader?') ? httpUrl(tab.url) : tab.url) || tab.url || '';

export function matchesText(tab, query) {
  return `${tab.title || ''} ${sourceUrl(tab)}`.toLowerCase().includes(query.trim().toLowerCase());
}
