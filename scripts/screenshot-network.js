import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Network } from 'selenium-webdriver/bidi/generated/network.js';

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

// Only the demo websites are fixtures. Firefox and the installed extension still
// create, organise and render real tabs, containers, favicons and sidebar controls.
export async function loadScreenshotResponses(fixture, directory) {
  const responses = new Map();
  for (const tab of fixture.tabs) {
    assert(
      tab.title && tab.favicon && tab.faviconType?.startsWith('image/'),
      `Missing page metadata: ${tab.key}`,
    );
    const iconPath = resolve(directory, tab.favicon);
    assert(
      iconPath.startsWith(`${resolve(directory, 'favicons')}${sep}`),
      `Invalid favicon path: ${tab.key}`,
    );
    const url = new URL(tab.url);
    assert(['http:', 'https:'].includes(url.protocol), `Invalid demo URL: ${tab.key}`);
    const iconUrl = new URL(`/__tabernacle_screenshots__/${tab.key}`, url).href;
    responses.set(iconUrl, { type: tab.faviconType, data: await readFile(iconPath) });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(tab.title)}</title><link rel="icon" type="${escapeHtml(tab.faviconType)}" href="${escapeHtml(iconUrl)}"></head><body></body></html>`;
    assert(!responses.has(url.href), `Duplicate demo URL: ${url.href}`);
    responses.set(url.href, { type: 'text/html; charset=utf-8', data: Buffer.from(html) });
  }
  return responses;
}

export async function installScreenshotResponses(driver, responses) {
  const network = await Network.create(driver);
  const failures = [];
  const served = new Set();
  await network.onBeforeRequestSent((event) => {
    if (!event.isBlocked) return;
    const response = responses.get(event.request.url);
    // Intercept HTTP(S) only in this private WebDriver session. Unknown page
    // requests get an empty response; demo pages never depend on live websites.
    network
      .provideResponse({
        request: event.request.request,
        statusCode: response ? 200 : 204,
        headers: [
          {
            name: 'Content-Type',
            value: { type: 'string', value: response?.type || 'text/plain' },
          },
          { name: 'Cache-Control', value: { type: 'string', value: 'no-store' } },
        ],
        body: { type: 'base64', value: response?.data.toString('base64') || '' },
      })
      .then(() => {
        if (response) served.add(event.request.url);
      })
      .catch((error) => failures.push(error));
  });
  await network.addIntercept({
    phases: ['beforeRequestSent'],
    urlPatterns: ['http', 'https'].map((protocol) => ({ type: 'pattern', protocol })),
  });
  return {
    verify() {
      if (failures.length) throw new AggregateError(failures, 'Demo network fixtures failed');
      const missing = [...responses.keys()].filter((url) => !served.has(url));
      assert.equal(missing.length, 0, `Demo resources were not loaded: ${missing.join(', ')}`);
    },
  };
}
