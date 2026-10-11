import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';
import { prepareSettings } from './settings-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 760 },
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

let openLook, settings, mode;
const background = (scheme) => (scheme === 'dark' ? 'rgb(32, 32, 32)' : 'rgb(247, 247, 247)');

const checkPalette = async (scheme) => {
  await expect(page.locator('html')).toHaveCSS('background-color', background(scheme));
  const samples = await page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d');

    const rgb = (color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };

    const surface = (node) => {
      const layers = [];
      for (let current = node; current; current = current.parentElement)
        layers.unshift(getComputedStyle(current).backgroundColor);
      context.clearRect(0, 0, 1, 1);
      for (const color of layers) {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
      }
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };

    return ['html', '#home', '#search-toggle', '.row.active', '.tab-toggle-badge'].map(
      (selector) => {
        const node = document.querySelector(selector);
        const style = getComputedStyle(node);
        return {
          selector,
          text: rgb(style.color),
          background: surface(node),
        };
      },
    );
  });

  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((value) => {
      value /= 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  };

  for (const sample of samples) {
    const values = [luminance(sample.text), luminance(sample.background)].sort((a, b) => a - b);
    expect((values[1] + 0.05) / (values[0] + 0.05), sample.selector).toBeGreaterThanOrEqual(4.5);
  }
};

try {
  await page.addInitScript(() => {
    const listeners = new Set();
    let ready;
    window.browser = {
      // A failed theme API must leave the original fallback palette usable.
      get theme() {
        throw new Error('Firefox theme colours must not be queried');
      },

      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'tabernacle-color-mode-test',
        onMessage: { addListener: (listener) => listeners.add(listener) },

        sendMessage: async (message) => {
          if (message.type === 'tabernacle:setLook' && window.failLookSave)
            return { ok: false, error: 'Storage unavailable' };
          ready ??= import('/preview/demo.js').then(({ createDemo }) =>
            createDemo((notice) => {
              for (const listener of listeners) listener({ type: 'tabernacle:changed', ...notice });
            }),
          );
          const data = await (
            await ready
          ).request({ ...message, type: message.type.slice('tabernacle:'.length) });
          return { ok: true, data };
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await expect(page.locator('.row.active')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'default');
  await checkPalette('light');
  await page.screenshot({ path: 'test-results/color-mode-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await checkPalette('dark');
  await page.screenshot({ path: 'test-results/color-mode-dark.png' });

  openLook = await prepareSettings(page);
  settings = await openLook();
  mode = settings.getByRole('combobox', { name: 'Monochrome colour mode', exact: true });
  await openLook();
  await expect(settings.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible();
  await expect(mode).toHaveValue('default');
  await expect(mode).toHaveAccessibleDescription(
    'Used for Monochrome, including the fallback. Follow Firefox uses its light/dark preference.',
  );
  await mode.selectOption('light');
  await settings.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await checkPalette('dark');
  await openLook();
  await expect(mode).toHaveValue('default');
  await mode.selectOption('light');
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await checkPalette('light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await checkPalette('light');

  await openLook();
  await expect(mode).toHaveValue('light');
  await mode.selectOption('dark');
  await page.evaluate(() => (window.failLookSave = true));
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(settings.getByRole('alert')).toHaveText('Storage unavailable');
  await expect(mode).toBeEnabled();
  await expect(mode).toHaveValue('dark');
  await checkPalette('light');
  await page.evaluate(() => (window.failLookSave = false));
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await checkPalette('dark');

  await page.locator('#search-toggle').click();
  await expect(page.locator('#search')).toHaveCSS('background-color', background('dark'));
  await page.keyboard.press('Escape');
  await openLook();
  await expect(mode).toHaveValue('dark');
  await expect(settings.locator('.settings-card').first()).toHaveCSS(
    'background-color',
    background('dark'),
  );
  await expect(mode).toHaveCSS('background-color', background('dark'));
  await settings.setViewportSize({ width: 220, height: 660 });
  expect(await settings.evaluate(() => document.documentElement.scrollWidth)).toBe(220);
  await settings.screenshot({
    path: 'test-results/color-mode-look-dark-narrow.png',
    fullPage: true,
  });
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.emulateMedia({ forcedColors: 'none' });
  await mode.selectOption('default');
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await checkPalette('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await checkPalette('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await checkPalette('light');
  expect(errors).toEqual([]);
  console.log(
    '✓ Accessible compact palettes, live Default mode, saved overrides, cancellation, save retry, narrow layouts and forced colours work when Firefox theme access fails',
  );
} finally {
  await close();
}
