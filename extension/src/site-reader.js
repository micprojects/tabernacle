import { hackerNewsArticle } from './hacker-news.js';
import { sitePage } from './site-modes.js';

// Self-contained for scripting.executeScript's isolated world. Read the loaded
// page only: no clicks, navigation, account APIs or page-world application state.
export function readSitePage(expectedUrl, page) {
  if (location.href !== expectedUrl) return null;
  const clean = (value, limit = 240) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const text = (selector, root = document) => clean(root.querySelector(selector)?.textContent);
  const attr = (selector, name, root = document) =>
    clean(root.querySelector(selector)?.getAttribute(name), 2000);
  const meta = (name) => attr(`meta[property="${name}"], meta[name="${name}"]`, 'content');
  const title = clean(document.title);
  if (
    /^(?:403|404|Access denied|Just a moment|Robot Check|Error Page|Before you continue|Sign in)/i.test(
      title,
    ) ||
    document.querySelector('form[action*="validateCaptcha"], #challenge-running, #captcha')
  )
    return null;
  const data = { url: expectedUrl };
  const nodes = [];

  const collect = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5 || nodes.length > 150) return;
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry, depth + 1);
      return;
    }
    nodes.push(value);
    collect(value['@graph'], depth + 1);
    collect(value.mainEntity, depth + 1);
    collect(value.itemReviewed, depth + 1);
  };

  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(
    0,
    20,
  )) {
    if (script.textContent.length > 500_000) continue;
    try {
      collect(
        JSON.parse(
          script.textContent
            .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, '')
            .replace(/\/\*\s*\]\]>\s*\*\/\s*$/, ''),
        ),
      );
    } catch {
      /* A broken structured-data block does not invalidate other blocks. */
    }
  }
  const schema = (...types) =>
    nodes.find((node) => [node['@type']].flat().some((type) => types.includes(type)));
  const image = (value) =>
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? image(value[0])
        : value?.url || value?.contentUrl || '';

  const count = (value) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return '';
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0
      ? `${number.toLocaleString()} ${number === 1 ? 'comment' : 'comments'}`
      : '';
  };

  switch (page.site) {
    case 'reddit': {
      if (!page.id) break;
      const post = document.querySelector(
        `shreddit-post[id="t3_${page.id}"], shreddit-post[post-id="t3_${page.id}"], .thing[data-fullname="t3_${page.id}"]`,
      );
      if (!post) break;
      data.title = clean(post.getAttribute('post-title')) || text('a.title, [slot="title"]', post);
      data.comments = post.hasAttribute('comment-count')
        ? count(post.getAttribute('comment-count'))
        : text('a.comments', post);
      data.flair = text(
        '[slot="post-flair"] shreddit-flair, [slot="post-flair"], .linkflairlabel',
        post,
      );
      const sensitive =
        post.hasAttribute('nsfw') ||
        post.hasAttribute('spoiler') ||
        post.classList.contains('over18') ||
        post.classList.contains('spoiler');
      if (!sensitive)
        data.image = attr(
          'img[slot="post-media"], [slot="post-media"] img, a.thumbnail img',
          'src',
          post,
        );
      break;
    }
    case 'hn': {
      if (!page.id) break;
      const story = document.getElementById(page.id);
      if (!story) break;
      const link = story.querySelector('.titleline > a');
      data.title = clean(link?.textContent);
      if (link) {
        try {
          const source = new URL(link.href);
          if (source.hostname !== location.hostname) {
            data.source = source.hostname.replace(/^www\./, '');
            data.articleUrl = source.href;
          }
        } catch {
          /* Invalid source. */
        }
      }
      const subtext = story.nextElementSibling;
      data.comments =
        [...(subtext?.querySelectorAll('a') || [])]
          .map((a) => clean(a.textContent))
          .find((t) => /^\d[\d,]* comments?$/.test(t)) || '';
      data.kind = /^Ask HN:/.test(data.title)
        ? 'Ask HN'
        : /^Show HN:/.test(data.title)
          ? 'Show HN'
          : story.classList.contains('comtr')
            ? 'Comment'
            : '';
      break;
    }
    case 'github': {
      if (!page.number) break;
      data.title =
        schema('DiscussionForumPosting')?.headline ||
        text('.js-issue-title, [data-testid="issue-title"]');
      // Only the issue/PR header; timeline events may describe an old state.
      const root = document.querySelector(
        '#partial-discussion-header, [data-testid="issue-header"], .gh-header',
      );
      const status =
        root &&
        text(
          '[data-testid="issue-state"], [data-testid="issue-state-badge"], .State, [data-component="StateLabel"]',
          root,
        );
      data.status = /^(Open|Closed|Merged|Draft)\b/.exec(status || '')?.[1] || '';
      if (!data.status) {
        const badge = document.querySelector(
          '[data-testid="header-state"], [data-testid="issue-state"], [data-testid="issue-state-badge"]',
        );
        data.status = /^(Open|Closed|Merged|Draft)\b/.exec(clean(badge?.textContent))?.[1] || '';
      }
      break;
    }
    case 'amazon': {
      if (!page.id || !document.querySelector('#productTitle')) break;
      data.title = text('#productTitle');
      data.image = attr('#landingImage, #imgBlkFront', 'src');
      data.price = text(
        '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen, #corePrice_feature_div .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #newBuyBoxPrice',
      );
      data.variant = [
        ...document.querySelectorAll('#twister .selection, #twister_feature_div .selection'),
      ]
        .map((n) => clean(n.textContent, 80))
        .filter(Boolean)
        .slice(0, 3)
        .join(' · ');
      break;
    }
    case 'ebay':
    case 'etsy': {
      if (!page.id) break;
      const product = schema('Product');
      data.title =
        clean(product?.name) ||
        text(
          page.site === 'ebay' ? '.x-item-title__mainTitle' : 'h1[data-buy-box-listing-title], h1',
        );
      data.image = image(product?.image);
      const offer = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
      if (
        offer?.price !== undefined &&
        /^[A-Z]{3}$/.test(offer.priceCurrency || '') &&
        Number.isFinite(Number(offer.price))
      ) {
        data.price = new Intl.NumberFormat(document.documentElement.lang || 'en', {
          style: 'currency',
          currency: offer.priceCurrency,
        }).format(Number(offer.price));
      }
      // A currently displayed price takes precedence over general schema offers.
      data.price =
        text(
          page.site === 'ebay'
            ? '.x-price-primary'
            : '[data-buy-box-region="price"] .wt-text-title-larger, [data-buy-box-region="price"] .wt-text-title-03',
        ) || data.price;
      data.variant = [
        ...document.querySelectorAll(
          page.site === 'ebay' ? '.x-msku select' : 'select[id^="variation-selector"]',
        ),
      ]
        .filter((n) => n.value && n.selectedIndex > 0)
        .map((n) => clean(n.selectedOptions[0]?.textContent, 80))
        .slice(0, 3)
        .join(' · ');
      break;
    }
    case 'wiki': {
      if (!page.id || !document.querySelector('#firstHeading')) break;
      const article = schema('Article');
      data.title = text('#firstHeading');
      data.description = text('.shortdescription') || clean(article?.headline);
      data.image = image(article?.image) || meta('og:image');
      break;
    }
    case 'docs': {
      if (!page.id) break;
      data.title = clean(document.querySelector('.docs-title-input')?.value) || meta('og:title');
      if (page.kind === 'Spreadsheet')
        data.location = text(
          '.docs-sheet-active-tab .docs-sheet-tab-name, [role="tab"][aria-selected="true"] .docs-sheet-tab-name',
        );
      if (page.kind === 'Presentation') {
        const label = attr(
          '.punch-filmstrip-thumbnail[aria-selected="true"], [role="option"][aria-selected="true"]',
          'aria-label',
        );
        // Keep the slide number, not its full contents or speaker notes.
        data.location = /^(?:Slide )?\d+/.exec(label)?.[0] || '';
        if (/^\d+$/.test(data.location)) data.location = `Slide ${data.location}`;
      }
      break;
    }
    case 'maps': {
      if (page.kind !== 'Place') break;
      const root = document.querySelector('[role="main"]');
      if (!root) break;
      data.title = text('h1', root);
      data.address =
        text('button[data-item-id="address"] .fontBodyMedium', root) ||
        attr('button[data-item-id="address"]', 'aria-label', root).replace(/^Address:\s*/i, '');
      data.category = text('button[jsaction*="category"]', root);
      // Place thumbnails often contain maps or viewport captures. The name and
      // address are enough to distinguish places without another image request.
      break;
    }
    case 'imdb':
    case 'letterboxd': {
      if (!page.id) break;
      const film = schema('Movie', 'TVSeries', 'TVEpisode');
      if (!film) break;
      data.title = clean(film.name);
      data.image = image(film.image);
      data.year = /^\d{4}/.exec(film.datePublished || film.dateCreated || '')?.[0] || '';
      const duration = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(film.duration || '');
      if (duration && (duration[1] || duration[2]))
        data.duration = [
          duration[1] && `${Number(duration[1])}h`,
          duration[2] && `${Number(duration[2])}m`,
        ]
          .filter(Boolean)
          .join(' ');
      data.director = [film.director]
        .flat()
        .filter(Boolean)
        .map((d) => clean(d.name, 100))
        .filter(Boolean)
        .slice(0, 3)
        .join(', ');
      break;
    }
  }
  return Object.values(data).some((v) => v && v !== expectedUrl) ? data : null;
}

export function normaliseSiteData(value, url) {
  if (!value || value.url !== url) return null;
  const data = { url };
  const article = hackerNewsArticle(value.articleUrl);
  if (sitePage(url)?.mode === 'hn' && article) data.articleUrl = article;
  for (const field of [
    'title',
    'description',
    'source',
    'kind',
    'comments',
    'flair',
    'status',
    'price',
    'variant',
    'location',
    'category',
    'address',
    'year',
    'duration',
    'director',
  ]) {
    if (typeof value[field] === 'string' && value[field].trim())
      data[field] = value[field]
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, field === 'title' ? 500 : 240);
  }
  try {
    const image = new URL(
      typeof value.image === 'string' && value.image.trim() ? value.image : 'invalid:',
      url,
    );
    if (
      image.protocol === 'https:' &&
      !image.username &&
      !image.password &&
      image.href.length < 2500
    )
      data.image = image.href;
  } catch {
    /* No usable image. */
  }
  return Object.keys(data).length > 1 ? data : null;
}
