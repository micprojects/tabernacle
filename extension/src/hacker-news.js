import { articleUrl } from './article.js';
import { sitePage } from './site-modes.js';

export const HACKER_NEWS_DOMAIN = 'news.ycombinator.com';

export function hackerNewsArticle(value) {
  if (typeof value !== 'string' || value.length > 8192 || !/^https?:\/\//i.test(value)) return null;
  const url = articleUrl(value);
  return url && new URL(url).hostname.replace(/^www\./, '') !== HACKER_NEWS_DOMAIN ? url : null;
}

export function normaliseHackerNewsStory(value) {
  if (!value || typeof value !== 'object') return null;
  const commentsUrl = articleUrl(value.commentsUrl);
  const page = sitePage(commentsUrl);
  const linkUrl = hackerNewsArticle(value.linkUrl || value.articleUrl);
  const destination = hackerNewsArticle(value.articleUrl);
  if (page?.mode !== 'hn' || !page.id || !linkUrl || !destination) return null;
  const clean = (text, limit) =>
    typeof text === 'string'
      ? text
          .replace(/[\s\u0000-\u001f]+/g, ' ')
          .trim()
          .slice(0, limit)
      : '';
  return {
    commentsUrl,
    articleUrl: destination,
    linkUrl,
    title: clean(value.title, 500),
    comments: clean(value.comments, 80),
    kind: clean(value.kind, 80),
    ...(value.pendingArticle === true ? { pendingArticle: true } : {}),
  };
}

const withoutFragment = (value) => {
  const url = new URL(value);
  url.hash = '';
  return url.href;
};

// Only the two known destinations (and the initial redirect chain) belong to
// this discussion. Following another link restores normal domain grouping.
export function hackerNewsStory(tab) {
  const story = normaliseHackerNewsStory(tab.hnStory);
  if (!story) return null;
  const url = articleUrl(tab.url);
  if (!url) return null;
  const page = sitePage(url);
  if (page?.mode === 'hn' && page.id === sitePage(story.commentsUrl).id)
    return { ...story, view: 'comments' };
  if (
    [story.articleUrl, story.linkUrl].some(
      (target) => withoutFragment(target) === withoutFragment(url),
    ) ||
    (story.pendingArticle && hackerNewsArticle(url))
  )
    return { ...story, view: 'article' };
  return null;
}

export function siteTabPage(tab) {
  return sitePage(hackerNewsStory(tab)?.commentsUrl || tab.url);
}

export function hackerNewsDisplayTab(tab) {
  const story = hackerNewsStory(tab);
  return story
    ? {
        ...tab,
        url: story.commentsUrl,
        title: `${story.title || 'Story'} | Hacker News`,
        favIconUrl: new URL('../icons/sites/hacker-news.ico', import.meta.url).href,
      }
    : tab;
}
