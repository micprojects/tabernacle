import { expect } from '@playwright/test';
import sharp from 'sharp';
import { startUiTest } from './ui-test.js';
import { prepareSettings } from './settings-test.js';

const { page, base, close } = await startUiTest({
  viewport: { width: 360, height: 640 },
  colorScheme: 'light',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const send = (type, args = {}) =>
  page.evaluate(
    async ({ type, args }) => {
      const result = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId: 1,
        ...args,
      });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
    { type, args },
  );

async function pixels(icon) {
  const { data, info } = await sharp(await icon.screenshot())
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x, y) => [
    ...data.subarray(
      (y * info.width + x) * info.channels,
      (y * info.width + x) * info.channels + 3,
    ),
  ];
  return { corner: at(1, 1), colour: at(8, 8), white: at(24, 8), dark: at(8, 24) };
}

const caption = (id) => page.locator(`[data-key="${id}"] .label`);

async function textColor(label) {
  let color;
  // A live update can replace the label between locator resolution and evaluation.
  // Read a connected label before comparing its colour or measuring contrast.
  await expect
    .poll(async () => {
      color = await label.evaluate((node) =>
        node.isConnected ? getComputedStyle(node).color : '',
      );
      return color;
    })
    .not.toBe('');
  return color;
}

async function checkCaptionContrast(label) {
  const foreground = (await textColor(label))
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
  const row = label.locator(
    'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " row ")][1]',
  );
  const { data, info } = await sharp(await row.screenshot())
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (4 * info.width + Math.floor(info.width * 0.7)) * info.channels;
  const background = [...data.subarray(offset, offset + 3)];
  const luminance = (rgb) =>
    rgb
      .map((value) => value / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
  expect(
    (values[1] + 0.05) / (values[0] + 0.05),
    `${await label.textContent()}: ${foreground} on ${background}`,
  ).toBeGreaterThanOrEqual(4.5);
}

try {
  await page.addInitScript(() => {
    const listeners = new Set();
    let ready;
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'favicon-tint-test',
        onMessage: { addListener: (listener) => listeners.add(listener) },

        sendMessage: async (message) => {
          ready ??= Promise.all([
            import('/preview/browser.js'),
            import('/extension/src/controller.js'),
          ]).then(([{ memoryBrowser }, { createController }]) => {
            const favicon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#00cc44" d="M2 2h6v6H2z"/><path fill="white" d="M8 2h6v6H8z"/><path fill="#303030" d="M2 8h6v6H2z"/><path fill="#af40dd" d="M8 8h6v6H8z"/></svg>')}`;
            window.tintApi = memoryBrowser({
              groups: [
                {
                  id: 'mixed',
                  name: 'Mixed containers',
                  parentId: null,
                  appearance: { color: 'purple' },
                  defaultCookieStoreId: 'firefox-container-2',
                },
                { id: 'child', name: 'Inherited folder', parentId: 'mixed' },
              ],
              containers: [
                {
                  cookieStoreId: 'firefox-container-1',
                  name: 'Red',
                  color: 'red',
                  colorCode: '#c4474b',
                },
                {
                  cookieStoreId: 'firefox-container-2',
                  name: 'Blue',
                  color: 'blue',
                  colorCode: '#00a7e0',
                },
              ],
              tabs: [
                { id: 1, title: 'Red container', cookieStoreId: 'firefox-container-1' },
                { id: 2, title: 'Blue container', cookieStoreId: 'firefox-container-2' },
                { id: 3, title: 'No container' },
                { id: 4, title: 'Pinned red', cookieStoreId: 'firefox-container-1', pinned: true },
              ].map((tab, index) => ({
                windowId: 1,
                index,
                url: 'https://example.com',
                favIconUrl: favicon,
                ...tab,
              })),
              memberships: Object.fromEntries(
                [1, 2, 3, 4].map((id) => [
                  id,
                  { groupId: 'mixed', treeId: `tint-${id}`, ancestors: id === 2 ? ['tint-1'] : [] },
                ]),
              ),
            });
            return createController(window.tintApi, (notice) => {
              for (const listener of listeners) listener({ type: 'tabernacle:changed', ...notice });
            });
          });
          if (message.type === 'tabernacle:setLook' && window.failTintSave)
            return { ok: false, error: 'Storage unavailable' };
          try {
            return {
              ok: true,
              data: await (
                await ready
              ).request({ ...message, type: message.type.slice('tabernacle:'.length) }),
            };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  const red = page.locator('[data-key="tab:1"] .tab-icon');
  const blue = page.locator('[data-key="tab:2"] .tab-icon');
  const neutral = page.locator('[data-key="tab:3"] .tab-icon');
  const pinned = page.locator('.pinned-tab[data-key="tab:4"] .tab-icon');
  await expect(red.locator('img')).toBeVisible();
  const original = await pixels(red);
  await expect(red.locator('img')).toHaveCSS('filter', 'none');
  const open = await prepareSettings(page);
  const settings = await open();
  const labels = settings.getByRole('checkbox', {
    name: 'Colour folder and tab labels',
    exact: true,
  });
  const redLabel = caption('tab:1'),
    blueLabel = caption('tab:2'),
    neutralLabel = caption('tab:3');
  const folderLabel = caption('group:mixed'),
    inheritedLabel = caption('group:child');
  const originalLabel = await textColor(neutralLabel);
  await expect(labels).toHaveCount(0);
  await expect(redLabel).not.toHaveCSS('color', originalLabel);
  await settings.locator('[name="domains"]').check();
  await settings.locator('#appearance-reset').click();
  await settings.locator('[name="domains"]').check();
  await settings.locator('#appearance-save').click();
  // Domain changes rebuild label nodes; wait for the sidebar to accept the save.
  await expect(page.locator('#tree')).toHaveClass(/show-domains/);
  await expect(redLabel).not.toHaveCSS('color', originalLabel);
  const redColor = await textColor(redLabel);
  expect(await textColor(blueLabel)).not.toBe(redColor);
  expect(await textColor(folderLabel)).not.toBe(redColor);
  expect(await textColor(inheritedLabel)).toBe(await textColor(folderLabel));
  expect(await textColor(neutralLabel)).toBe(originalLabel);
  await expect(red.locator('img')).toHaveCSS('filter', 'none');
  await settings.reload();
  await expect(labels).toHaveCount(0);
  await expect(redLabel).toHaveCSS('color', redColor);
  await send('setGroupAppearance', { id: 'mixed', appearance: { color: 'green' } });
  await expect(folderLabel).not.toHaveCSS('color', redColor);
  await expect(inheritedLabel).toHaveCSS('color', await textColor(folderLabel));
  expect(await textColor(redLabel)).toBe(redColor);
  await send('setGroupAppearance', { id: 'child', appearance: { color: 'orange' } });
  await expect(inheritedLabel).not.toHaveCSS('color', await textColor(folderLabel));

  for (const colorScheme of ['light', 'dark']) {
    await send('setLook', { partial: true, value: { colorScheme, domains: true } });
    await expect(page.locator('html')).toHaveAttribute('data-color-scheme', colorScheme);
    for (const label of [redLabel, blueLabel, neutralLabel, folderLabel, inheritedLabel])
      await checkCaptionContrast(label);
    const domainColor = await textColor(page.locator('[data-key="tab:1"] .row-detail'));
    expect(domainColor).not.toBe(await textColor(redLabel));
    await redLabel.hover();
    await checkCaptionContrast(redLabel);
    await send('activateTab', { id: 2 });
    await checkCaptionContrast(blueLabel);
    await page.evaluate(async () => {
      await window.tintApi.tabs.update(1, { discarded: true });
    });
    await send('setLook', { partial: true, value: { folderCounts: true } });
    await expect(page.locator('[data-key="tab:1"]')).toHaveClass(/discarded/);
    await checkCaptionContrast(redLabel);
    await page.mouse.move(0, 0);
    await checkCaptionContrast(redLabel);
    await page.screenshot({ path: `test-results/strong-labels-${colorScheme}.png` });
    await page.evaluate(async () => {
      await window.tintApi.tabs.update(1, { discarded: false });
    });
    await send('setLook', { partial: true, value: { folderCounts: false } });
  }

  // Automatic neutral appearance also repaints custom caption shades live.
  await send('setLook', { partial: true, value: { colorScheme: 'default' } });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'default');
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    // Media-query change events repaint calculated caption shades asynchronously.
    await expect(async () => {
      await checkCaptionContrast(redLabel);
      await checkCaptionContrast(blueLabel);
    }).toPass({ timeout: 3000 });
  }
  await send('setLook', { partial: true, value: { colorScheme: 'light' } });
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await textColor(redLabel)).toBe(await textColor(neutralLabel));
  await page.emulateMedia({ forcedColors: 'none' });
  await expect(redLabel).not.toHaveCSS('color', await textColor(neutralLabel));
  await send('setLook', { partial: true, value: { domains: false } });
  await expect(redLabel).not.toHaveCSS('color', await textColor(neutralLabel));
  console.log(
    '✓ Always-on caption colours: independent tab containers, custom/inherited folders, appearance reset, live colour modes and measured text contrast',
  );
  const tint = settings.getByRole('checkbox', { name: 'Tint website icons', exact: true });
  await expect(tint).not.toBeChecked();
  await tint.check();
  await settings.locator('#appearance-reset').click();
  await expect(tint).not.toBeChecked();
  await tint.check();
  await page.evaluate(() => {
    window.failTintSave = true;
  });
  await settings.locator('#appearance-save').click();
  await expect(settings.locator('#appearance-error')).toHaveText('Storage unavailable');
  await expect(red.locator('img')).toHaveCSS('filter', 'none');
  await page.evaluate(() => {
    window.failTintSave = false;
  });
  await settings.locator('#appearance-save').click();
  await expect(red.locator('img')).not.toHaveCSS('filter', 'none');
  await expect(blue.locator('img')).not.toHaveCSS('filter', 'none');
  await expect(pinned.locator('img')).not.toHaveCSS('filter', 'none');
  await expect(neutral.locator('img')).toHaveCSS('filter', 'none');
  const tinted = await pixels(red);
  expect(tinted.colour[0]).toBeGreaterThan(tinted.colour[1] + 30);
  expect(tinted.colour[0]).toBeGreaterThan(tinted.colour[2] + 30);
  expect(tinted.white).toEqual(original.white);
  const lightness = (rgb) =>
    rgb.reduce((sum, channel, index) => sum + channel * [0.3, 0.59, 0.11][index], 0);
  expect(Math.abs(lightness(tinted.dark) - lightness(original.dark))).toBeLessThan(2);
  expect(lightness(tinted.dark)).toBeLessThan(lightness(tinted.colour));
  expect(tinted.corner).toEqual(original.corner);
  const bluePixels = await pixels(blue);
  expect(bluePixels.colour[2]).toBeGreaterThan(bluePixels.colour[0] + 30);
  expect((await pixels(pinned)).colour).toEqual(tinted.colour);
  expect((await pixels(neutral)).colour).toEqual(original.colour);
  await page.screenshot({ path: 'test-results/favicon-tint-light.png' });

  await settings.reload();
  await expect(tint).toBeChecked();
  await send('setLook', { partial: true, value: { colorScheme: 'dark' } });
  await expect.poll(async () => (await pixels(red)).colour).not.toEqual(tinted.colour);
  await page.screenshot({ path: 'test-results/favicon-tint-dark.png' });
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(red.locator('img')).toHaveCSS('filter', 'none');
  await page.emulateMedia({ forcedColors: 'none' });
  await expect(red.locator('img')).not.toHaveCSS('filter', 'none');

  // Identity edits refresh cached tree and pinned icons, independently of folder colour.
  const beforeEdit = (await pixels(red)).colour;
  await send('updateContainer', {
    cookieStoreId: 'firefox-container-1',
    name: 'Green',
    color: 'green',
    icon: 'fingerprint',
  });
  await expect(async () => {
    expect((await pixels(red)).colour).not.toEqual(beforeEdit);
  }).toPass({ timeout: 5000 });
  expect((await pixels(pinned)).colour).toEqual((await pixels(red)).colour);

  // An unreadable source still falls back to a working, container-coloured globe.
  await page.evaluate(async () => {
    await window.tintApi.tabs.update(1, { favIconUrl: 'data:image/png;base64,bad' });
  });
  await send('setLook', { partial: true, value: { domains: true } });
  await expect(red.locator('svg')).toBeVisible();
  await expect(red.locator('svg')).toHaveCSS(
    'color',
    await red.evaluate((node) => getComputedStyle(node).color),
  );
  await tint.uncheck();
  await settings.locator('#appearance-save').click();
  await expect(blue.locator('img')).toHaveCSS('filter', 'none');
  await expect(pinned.locator('img')).toHaveCSS('filter', 'none');
  expect((await pixels(blue)).colour).toEqual(original.colour);
  expect(errors).toEqual([]);
  console.log(
    '✓ Opt-in favicon tint: settings, actual container colours, shading/alpha, pinned/nested tabs, dark/forced colours, identity edits and fallback',
  );
} finally {
  await close();
}
