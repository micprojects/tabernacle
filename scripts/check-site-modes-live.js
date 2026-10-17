import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { ScreenshotBrowser } from './screenshot-browser.js';
import {
  SITE_ORIGINS,
  sitePage,
  siteDetails,
  cleanSiteTitle,
} from '../extension/src/site-modes.js';

// Opt-in network check. Never uses a personal Firefox profile. Blocked sites
// are reported as blocked, separately from deterministic regression coverage.
const examples = [
  [
    'reddit',
    'https://www.reddit.com/r/reddit/comments/1l2hl4l/curate_your_reddit_profile_content_with_new/',
  ],
  ['hn', 'https://news.ycombinator.com/item?id=8863'],
  ['github', 'https://github.com/microsoft/vscode/issues/1'],
  ['amazon', 'https://www.amazon.co.uk/dp/1838855572'],
  ['ebay', 'https://www.ebay.com/itm/176308104866'],
  ['etsy', 'https://www.etsy.com/uk/listing/1851033626/handmade-cream-stoneware-mug-12-oz'],
  ['wiki', 'https://en.wikipedia.org/wiki/Alan_Turing'],
  [
    'docs',
    'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0',
  ],
  ['maps', 'https://www.google.com/maps/search/?api=1&query=The+British+Museum+London'],
  ['imdb', 'https://www.imdb.com/title/tt0133093/'],
  ['letterboxd', 'https://letterboxd.com/film/the-matrix/'],
];
const selected = process.argv.slice(2);
const browser = new ScreenshotBrowser();
const report = [];
const size = { width: 320, height: 760 };
try {
  await mkdir('test-results/site-modes', { recursive: true });
  await browser.open(
    { window: { width: 1100, height: 980 }, sidebarWidth: 320, capture: { sourceSize: size } },
    'test-results/site-modes/live-firefox.log',
  );
  await browser.chrome(async (origins) => {
    const { ExtensionPermissions } = ChromeUtils.importESModule(
      'resource://gre/modules/ExtensionPermissions.sys.mjs',
    );
    const extension = WebExtensionPolicy.getByID('tabernacle@michaelprojects.com').extension;
    await ExtensionPermissions.add(extension.id, { permissions: [], origins }, extension);
  }, SITE_ORIGINS);
  for (const [site, url] of examples.filter(
    ([site]) => !selected.length || selected.includes(site),
  )) {
    let id;
    try {
      id = await browser.evaluate(
        async (url) => (await browser.tabs.create({ url, active: true })).id,
        url,
      );
      await browser.driver
        .wait(
          () =>
            browser.evaluate(async (id) => (await browser.tabs.get(id)).status === 'complete', id),
          30000,
        )
        .catch(() => {});
      if (site === 'maps') {
        await browser.evaluate(async (id) => {
          const tab = await browser.tabs.get(id);
          if (new URL(tab.url).hostname !== 'consent.google.com') return;
          await browser.scripting.executeScript({
            target: { tabId: id },

            func: () => {
              [...document.querySelectorAll('button')]
                .find((b) => /Reject all/i.test(b.textContent))
                ?.click();
            },
          });
        }, id);
        await browser.driver
          .wait(
            () =>
              browser.evaluate(async (id) => {
                const tab = await browser.tabs.get(id);
                return (
                  tab.url.includes('/maps/') &&
                  !tab.url.includes('consent.google') &&
                  tab.status === 'complete'
                );
              }, id),
            20000,
          )
          .catch(() => {});
      }
      // Dynamic page headers can arrive after the document load event.
      await browser.driver.sleep(2000);
      if (site === 'maps') await browser.driver.sleep(10000);
      const extracted = await browser.evaluate(async (id) => {
        const tab = await browser.tabs.get(id);
        const { sitePage } = await import(browser.runtime.getURL('src/site-modes.js'));
        const { readSitePage } = await import(browser.runtime.getURL('src/site-reader.js'));
        const page = sitePage(tab.url);
        const data = page
          ? (
              await browser.scripting.executeScript({
                target: { tabId: id },
                func: readSitePage,
                args: [tab.url, page],
              })
            )[0]?.result
          : null;
        return { url: tab.url, title: tab.title, mode: page?.mode, data };
      }, id);
      await browser.evaluate((id) => {
        document.getElementById('domain-close').click();
        document
          .querySelector(`#tree [data-key="tab:${id}"]`)
          ?.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 120 }),
          );
        [...document.querySelectorAll('#menu button')]
          .find((b) => b.textContent === 'Filter by domain')
          ?.click();
      }, id);
      if (extracted.mode) {
        await browser.driver.wait(
          () =>
            browser.evaluate(
              (id) => Boolean(document.querySelector(`[data-key="tab:${id}"] .site-copy`)),
              id,
            ),
          10000,
        );
        if (extracted.data)
          await browser.driver
            .wait(
              () =>
                browser.evaluate(
                  (id) =>
                    Boolean(
                      [...document.querySelectorAll(`[data-key="tab:${id}"] .site-detail`)].some(
                        (n) => !n.hidden && n.title.includes('Last read'),
                      ),
                    ),
                  id,
                ),
              10000,
            )
            .catch(() => {});
      }
      if (extracted.data?.image)
        await browser.driver
          .wait(
            () =>
              browser.evaluate(
                (id) =>
                  Boolean(document.querySelector(`[data-key="tab:${id}"] .site-media.has-image`)),
                id,
              ),
            15000,
          )
          .catch(() => {});
      if (site === 'maps') {
        const html = await browser.evaluate(
          async (id) =>
            (
              await browser.scripting.executeScript({
                target: { tabId: id },
                func: () => document.documentElement.outerHTML,
              })
            )[0]?.result,
          id,
        );
        await writeFile('test-results/site-modes/maps-firefox-live.html', html || '');
      }
      const displayed = await browser.evaluate((id) => {
        const row = document.querySelector(`[data-key="tab:${id}"]`);
        return {
          text: row?.innerText,
          image: Boolean(row?.querySelector('.site-media.has-image')),
          overflow: row ? row.scrollWidth > row.clientWidth : false,
          toggle: document.getElementById('site-mode-label').textContent,
        };
      }, id);
      assert(!displayed.overflow, `${site} overflows`);
      if (extracted.data) {
        const page = sitePage(extracted.url);
        for (const detail of siteDetails(page, extracted.data).filter(Boolean))
          assert(displayed.text.includes(detail), `${site} did not display ${detail}`);
        if (extracted.data.title)
          assert(
            displayed.text.includes(cleanSiteTitle(extracted.data.title, page)),
            `${site} title was not displayed`,
          );
        if (extracted.data.image) assert(displayed.image, `${site} preview did not load`);
      }
      const entry = {
        site,
        ...extracted,
        displayed,
        status: extracted.data ? 'retrieved' : 'unavailable',
      };
      report.push(entry);
      console.log(JSON.stringify(entry));
      await writeFile(
        `test-results/site-modes/live-${site}-firefox.png`,
        await browser.screenshot({ sourceSize: size, scale: 2 }),
      );
    } catch (error) {
      const entry = { site, status: 'error', error: error.message };
      report.push(entry);
      console.log(JSON.stringify(entry));
    } finally {
      if (id)
        await browser.evaluate(async (id) => {
          document.getElementById('domain-close').click();
          await browser.tabs.remove(id);
        }, id);
    }
  }
} finally {
  await writeFile(
    `test-results/site-modes/live-report${selected.length ? `-${selected.join('-')}` : ''}.json`,
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
