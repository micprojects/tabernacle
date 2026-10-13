import { expect } from '@playwright/test';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';
import { prepareSettings } from './settings-test.js';
import { knownThemes } from '../extension/src/theme-palette.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 300, height: 650 },
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

let openAppearance, settings, source, activity;

const palette = (tab) =>
  tab.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    document.body.append(probe);
    const values = { background: root.backgroundColor, text: root.color };
    for (const token of ['accent', 'accent-text', 'focus', 'folder-icon', 'selected', 'panel']) {
      probe.style.color = `var(--${token})`;
      values[token] = getComputedStyle(probe).color;
    }
    probe.remove();
    return values;
  });

const checkSharedPalette = async () => {
  const expected = await palette(page);
  await expect.poll(() => palette(settings)).toEqual(expected);
  await expect.poll(() => palette(activity)).toEqual(expected);
};

const setTheme = (id, details = null) =>
  page.evaluate(
    async ({ id, details }) => {
      const { knownThemes } = await import('/extension/src/theme-palette.js');
      const selected = knownThemes.find((theme) => theme.id === id);
      window.themeFixture.active = id
        ? { type: 'theme', enabled: true, id, name: selected?.name || 'External' }
        : null;
      window.themeFixture.details = details;
      window.themeFixture.emit();
    },
    { id, details },
  );
try {
  await page.addInitScript(() => {
    const notices = new Set(),
      themes = new Set(),
      enabled = new Set();
    let ready;
    window.themeFixture = {
      active: null,
      details: null,
      failSave: false,

      emit: () => {
        for (const listener of themes) listener({});
      },
    };
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1, focused: true }) },
      management: {
        getAll: async () => (window.themeFixture.active ? [window.themeFixture.active] : []),
        onEnabled: {
          addListener: (listener) => enabled.add(listener),
          removeListener: (listener) => enabled.delete(listener),
        },
      },
      theme: {
        getCurrent: async () => window.themeFixture.details,
        onUpdated: {
          addListener: (listener) => themes.add(listener),
          removeListener: (listener) => themes.delete(listener),
        },
      },
      runtime: {
        id: 'tabernacle-theme-test',
        onMessage: { addListener: (listener) => notices.add(listener) },

        sendMessage: async (message) => {
          if (message.type === 'tabernacle:setLook' && window.themeFixture.failSave)
            return { ok: false, error: 'Storage unavailable' };
          ready ??= import('/preview/demo.js').then(({ createDemo }) =>
            createDemo((notice) => {
              for (const listener of notices) listener({ type: 'tabernacle:changed', ...notice });
            }),
          );
          return {
            ok: true,
            data: await (
              await ready
            ).request({ ...message, type: message.type.slice('tabernacle:'.length) }),
          };
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await expect(page.locator('.row.active')).toBeVisible();
  openAppearance = await prepareSettings(page);
  settings = await openAppearance();
  const opened = page.waitForEvent('popup');
  await page.evaluate(() => window.open('activity.html', 'theme-activity'));
  activity = await opened;
  await expect(activity.locator('#activity-results')).toHaveAttribute('aria-busy', 'false');
  for (const tab of [settings, activity])
    tab.on('pageerror', (error) => errors.push(error.message));
  const beforeGeometry = await page.locator('.row.active').boundingBox();
  const cases = [{ id: null, name: 'Monochrome fallback' }, ...knownThemes];
  for (const dark of [false, true]) {
    for (const tab of [page, settings, activity])
      await tab.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    const images = [];
    for (const theme of cases) {
      await setTheme(theme.id);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.firefoxTheme || ''))
        .toBe(theme.id ? (theme.id === 'default-theme@mozilla.org' ? 'default' : 'custom') : '');
      if (theme.id) {
        const frame = theme.manifest[dark ? 'dark_theme' : 'theme'].colors.frame;
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.style.getPropertyValue('--background')),
          )
          .toBe(Array.isArray(frame) ? `rgb(${frame.join(', ')})` : frame);
      } else
        await expect(page.locator('html')).toHaveCSS(
          'background-color',
          dark ? 'rgb(32, 32, 32)' : 'rgb(247, 247, 247)',
        );
      const geometry = await page.locator('.row.active').boundingBox();
      expect(geometry).toEqual(beforeGeometry);
      await checkSharedPalette();
      const newTab = page.locator('.new-tab-action').first();
      await newTab.hover();
      const expected = await palette(page);
      await expect(newTab).toHaveCSS('color', theme.id ? expected.text : expected.accent);
      await expect(newTab.locator('svg')).toHaveCSS(
        'fill',
        theme.id ? expected.text : expected.accent,
      );
      const pixels = await page.screenshot();
      // Check the visible backdrop after live theme changes, including the
      // default theme's translucent tint composited over its frame colour.
      const backdrops = {
        'default-theme@mozilla.org': dark ? [50, 43, 68] : [245, 238, 255],
        'nova-sun@mozilla.org': dark ? [39, 15, 0] : [249, 245, 230],
        'nova-pine@mozilla.org': dark ? [0, 73, 51] : [236, 244, 241],
      };
      if (backdrops[theme.id]) {
        const { data, info } = await sharp(pixels).raw().toBuffer({ resolveWithObject: true });
        const offset =
          (Math.floor(info.height * 0.85) * info.width + Math.floor(info.width * 0.9)) *
          info.channels;
        for (const [channel, expected] of backdrops[theme.id].entries())
          expect(Math.abs(data[offset + channel] - expected)).toBeLessThanOrEqual(1);
        await writeFile(
          `test-results/theme-background-${theme.name.toLowerCase().replaceAll(' ', '-')}-${dark ? 'dark' : 'light'}.png`,
          pixels,
        );
      }
      await page.mouse.move(0, 0);
      // Establish keyboard modality before asserting :focus-visible styles.
      await page.keyboard.press('Tab');
      await newTab.focus();
      await expect(newTab).toHaveCSS('color', theme.id ? expected.text : expected.accent);
      await page.locator('#tree').focus();
      const title = Buffer.from(
        `<svg width="300" height="28"><rect width="300" height="28" fill="white"/><text x="10" y="19" font-family="sans-serif" font-size="13">${theme.name} — ${dark ? 'dark' : 'light'}</text></svg>`,
      );
      const thumb = await sharp(pixels)
        .resize(300, 650)
        .extend({ top: 28, bottom: 0, left: 0, right: 0, background: 'white' })
        .composite([{ input: title, top: 0, left: 0 }])
        .png()
        .toBuffer();
      images.push({
        input: thumb,
        left: (images.length % 4) * 300,
        top: Math.floor(images.length / 4) * 678,
      });
    }
    await sharp({ create: { width: 1200, height: 2712, channels: 4, background: '#ddd' } })
      .composite(images)
      .png()
      .toFile(`test-results/themes-${dark ? 'dark' : 'light'}-contact.png`);
  }
  source = settings.getByRole('combobox', { name: 'Theme', exact: true });
  await setTheme('nova-sun@mozilla.org');
  await openAppearance();
  await expect(source).toBeVisible();
  await expect(settings.locator('#look-theme-status')).toHaveText('Using Sun');
  await source.selectOption('tabernacle');
  await settings.locator('#appearance-reset').click();
  await expect(page.locator('html')).toHaveAttribute('data-firefox-theme', 'custom');
  await openAppearance();
  await expect(source).toHaveValue('firefox');
  await source.selectOption('tabernacle');
  await page.evaluate(() => {
    window.themeFixture.failSave = true;
  });
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(settings.getByRole('alert')).toHaveText('Storage unavailable');
  await expect(source).toHaveValue('tabernacle');
  await expect(page.locator('html')).toHaveAttribute('data-firefox-theme', 'custom');
  await page.evaluate(() => {
    window.themeFixture.failSave = false;
  });
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-firefox-theme');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(32, 32, 32)');
  await expect(page.locator('.sidebar')).toHaveCSS('background-image', 'none');
  await checkSharedPalette();
  await setTheme('nova-pine@mozilla.org');
  await expect(page.locator('html')).not.toHaveAttribute('data-firefox-theme');
  await openAppearance();
  await source.selectOption('firefox');
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-firefox-theme', 'custom');
  await checkSharedPalette();
  await page.locator('#search-toggle').click();
  await page.locator('#search').fill('firefox');
  await page.screenshot({ path: 'test-results/theme-search.png' });
  await page.keyboard.press('Escape');
  await page.locator('#tree').focus();
  await page.keyboard.press('Shift+F10');
  await page.screenshot({ path: 'test-results/theme-menu.png' });
  await page.keyboard.press('Escape');
  await openAppearance();
  await settings.setViewportSize({ width: 220, height: 400 });
  expect(await settings.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  await settings.screenshot({ path: 'test-results/theme-settings-narrow.png', fullPage: true });
  await setTheme('nova-lavender@mozilla.org');
  await expect(settings.locator('#look-theme-status')).toHaveText('Using Lavender');
  for (const tab of [page, settings, activity]) await tab.emulateMedia({ forcedColors: 'active' });
  await checkSharedPalette();
  await expect(page.locator('.sidebar')).toHaveCSS('background-image', 'none');
  await page.screenshot({ path: 'test-results/theme-forced-colours.png' });
  for (const tab of [page, settings, activity]) await tab.emulateMedia({ forcedColors: 'none' });
  await expect(page.locator('.sidebar')).not.toHaveCSS('background-image', 'none');
  await page.keyboard.press('Escape');
  await setTheme('external', {
    colors: { frame: '#123456', tab_selected: '#abcdef', tab_text: '#000000', popup: '#ffffff' },
    images: { additional_backgrounds: ['https://example.com/never-load.png'] },
  });
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await expect(page.locator('.row.active')).toHaveCSS('background-color', 'rgb(171, 205, 239)');
  await expect(page.locator('.sidebar')).toHaveCSS('background-image', 'none');
  await checkSharedPalette();
  await setTheme('external', { colors: { frame: 'var(--bad)', toolbar: 'invalid' } });
  await expect(page.locator('html')).not.toHaveAttribute('data-firefox-theme');
  await checkSharedPalette();
  expect(errors).toEqual([]);
  console.log(
    '✓ 26 shared palettes, themed New tab hover/focus, fixed geometry, automatic changes, override, cancel/retry, narrow layouts and forced colours',
  );
} finally {
  await close();
}
