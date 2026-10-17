// Reader View changes the tab URL. Keep previews and filters tied to the source page.
export function articleUrl(value) {
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

export function articleOrigin(value) {
  const source = articleUrl(value);
  if (!source) return null;
  const url = new URL(source);
  // Firefox match patterns apply to every port on this exact host.
  return `${url.protocol}//${url.hostname}/*`;
}

export function normaliseArticle(value, url) {
  if (!value || value.url !== url || !articleUrl(url)) return null;
  const clean = (text, max) =>
    typeof text === 'string'
      ? text
          .replace(/[\s\u0000-\u001f]+/g, ' ')
          .trim()
          .slice(0, max)
      : '';
  const title = clean(value.title, 240);
  if (!title || !Number.isSafeInteger(value.words) || value.words < 80 || value.words > 1_000_000)
    return null;
  const published = typeof value.published === 'string' ? Date.parse(value.published) : NaN;
  return {
    url,
    title,
    excerpt: clean(value.excerpt, 280),
    byline: clean(value.byline, 160),
    words: value.words,
    minutes: Math.max(1, Math.ceil(value.words / 220)),
    published: Number.isFinite(published) ? new Date(published).toISOString().slice(0, 10) : '',
  };
}

// Injected into the isolated world only after site access has been granted.
// Readability receives a clone: it never edits the page the person is reading.
export function readArticle(expectedUrl) {
  if (
    location.href !== expectedUrl ||
    document.contentType !== 'text/html' ||
    typeof Readability !== 'function' ||
    typeof isProbablyReaderable !== 'function' ||
    document.getElementsByTagName('*').length > 50_000 ||
    !isProbablyReaderable(document)
  )
    return null;
  const article = new Readability(document.cloneNode(true), { maxElemsToParse: 50_000 }).parse();
  if (!article?.textContent) return null;
  let words = 0;
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(
    article.textContent,
  ))
    if (segment.isWordLike) words++;
  const clean = (value, max) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  return {
    url: expectedUrl,
    title: clean(article.title, 240),
    excerpt: clean(article.excerpt, 280),
    byline: clean(article.byline, 160),
    published: clean(article.publishedTime, 80),
    words,
  };
}
