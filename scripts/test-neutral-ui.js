import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';
import { prepareSettings } from './settings-test.js';

const { page, close, base } = await startUiTest({ colorScheme: 'light' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

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

try {
  await page.addInitScript(() => {
    const notices = new Set();
    let ready;
    window.retiredThemeReads = [];
    window.browser = {
      get management() {
        window.retiredThemeReads.push(new Error().stack);
        throw new Error('Installed add-ons must not be queried');
      },

      get theme() {
        window.retiredThemeReads.push(new Error().stack);
        throw new Error('Firefox theme colours must not be queried');
      },

      windows: { getCurrent: async () => ({ id: 1, focused: true }) },
      runtime: {
        id: 'tabernacle-neutral-test',
        onMessage: { addListener: (listener) => notices.add(listener) },

        sendMessage: async (message) => {
          ready ??= import('/preview/demo.js').then(({ createDemo }) =>
            createDemo((notice) => {
              for (const listener of notices) listener({ type: 'tabernacle:changed', ...notice });
            }),
          );
          return {
            ok: true,
            data: await (
              await ready
            ).request({
              ...message,
              type: message.type.slice('tabernacle:'.length),
            }),
          };
        },
      },
    };
  });
  await page.goto(`${base}/extension/sidebar.html`);
  await expect(page.locator('.row.active')).toBeVisible();
  const openSettings = await prepareSettings(page);
  const settings = await openSettings();
  await expect(settings.getByRole('combobox', { name: 'Theme', exact: true })).toHaveCount(0);
  await expect(settings.getByText('Use Firefox theme', { exact: true })).toHaveCount(0);
  const opened = page.waitForEvent('popup');
  await page.evaluate(() => {
    window.open('activity.html', 'neutral-activity');
  });
  const activity = await opened;
  await expect(activity.locator('#activity-results')).toHaveAttribute('aria-busy', 'false');
  for (const tab of [settings, activity])
    tab.on('pageerror', (error) => errors.push(error.message));
  const pages = [page, settings, activity];
  const mode = settings.getByRole('combobox', { name: 'Colour mode', exact: true });

  const checkSharedPalette = async (dark) => {
    await expect(page.locator('html')).toHaveCSS(
      'background-color',
      dark ? 'rgb(32, 32, 32)' : 'rgb(255, 255, 255)',
    );
    const expected = await palette(page);
    for (const tab of pages) {
      await expect.poll(() => palette(tab)).toEqual(expected);
      await expect(tab.locator('html')).not.toHaveAttribute('data-firefox-theme');
    }
    await expect(page.locator('.sidebar')).toHaveCSS('background-image', 'none');
  };

  for (const colorScheme of ['dark', 'light', 'default']) {
    await mode.selectOption(colorScheme);
    await settings.locator('#appearance-save').click();
    await expect(settings.locator('#appearance-save')).toBeDisabled();
    for (const preferred of ['dark', 'light']) {
      for (const tab of pages) await tab.emulateMedia({ colorScheme: preferred });
      await checkSharedPalette((colorScheme === 'default' ? preferred : colorScheme) === 'dark');
    }
  }
  for (const tab of pages) await tab.emulateMedia({ forcedColors: 'active' });
  await checkSharedPalette(false);
  for (const tab of pages) await tab.emulateMedia({ forcedColors: 'none', colorScheme: 'dark' });
  await checkSharedPalette(true);
  await settings.screenshot({ path: 'test-results/neutral-settings-dark.png', fullPage: true });
  for (const tab of pages) await tab.emulateMedia({ colorScheme: 'light' });
  await checkSharedPalette(false);
  await settings.screenshot({ path: 'test-results/neutral-settings-light.png', fullPage: true });
  expect(await page.evaluate(() => window.retiredThemeReads)).toEqual([]);
  expect(errors).toEqual([]);
  console.log(
    '✓ Sidebar, Settings and Activity share neutral colour modes and forced colours without theme APIs',
  );
} finally {
  await close();
}
