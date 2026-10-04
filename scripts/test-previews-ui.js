import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { server, page, close } = await startUiTest({
  viewport: { width: 320, height: 600 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let checks = 0;

const check = (message) => {
  checks++;
  console.log(`✓ ${message}`);
};

try {
  // The real sidebar/controller, with mock tabs and no capture or host permission API.
  await page.addInitScript(() => {
    const listeners = new Set();
    const testing = (window.previewTest = {});
    const ready = Promise.all([
      import('/preview/browser.js'),
      import('/extension/src/controller.js'),
    ]).then(([{ memoryBrowser }, { createController }]) => {
      const api = memoryBrowser({
        tabs: [
          {
            id: 1,
            windowId: 1,
            index: 0,
            title: 'Pinned project',
            url: 'https://example.com/project',
            pinned: true,
          },
          {
            id: 2,
            windowId: 1,
            index: 1,
            title: 'A long page title that the sidebar normally truncates',
            url: 'https://example.com/research?view=all&sort=latest',
            cookieStoreId: 'firefox-container-1',
          },
          ...Array.from({ length: 18 }, (_, i) => ({
            id: i + 3,
            windowId: 1,
            index: i + 2,
            title: `Reference ${i + 1}`,
            url: `https://example.com/reference/${i + 1}`,
            active: i === 0,
          })),
        ],
        containers: [
          { cookieStoreId: 'firefox-container-1', name: 'Research', colorCode: '#00a7e0' },
        ],
      });
      testing.update = async (id, props) => {
        await api.tabs.update(id, props);
        testing.notify();
      };
      return createController(api, () => testing.notify());
    });
    testing.notify = () => {
      for (const fn of listeners) fn({ type: 'tabernacle:changed' });
    };
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'tabernacle-preview-test',
        onMessage: { addListener: (fn) => listeners.add(fn) },

        sendMessage: async (message) => {
          try {
            return {
              ok: true,
              data: await (
                await ready
              ).request({ ...message, type: message.type.replace('tabernacle:', '') }),
            };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/extension/sidebar.html`);
  const tab = page.locator('[data-key="tab:2"]');
  const pin = page.locator('.pinned-tab');
  const card = page.getByRole('tooltip');
  await expect(tab).toBeVisible();
  await tab.hover();
  await expect(card).toBeHidden();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(650);
  await expect(card).toBeHidden();
  await tab.hover();
  await expect(card).toBeVisible();
  await expect(card.locator('.preview-title')).toHaveText(
    'A long page title that the sidebar normally truncates',
  );
  await expect(card.locator('.preview-url')).toHaveText(
    'https://example.com/research?view=all&sort=latest',
  );
  await expect(card.locator('.preview-container')).toHaveText('Container: Research');
  await expect(tab).toHaveAttribute('aria-describedby', 'tab-preview');
  await expect(tab).not.toHaveAttribute('title');
  await expect(page.locator('[data-key="tab:3"]')).toHaveClass(/active/);
  await card.hover();
  await page.waitForTimeout(180);
  await expect(card).toBeVisible();
  await page.screenshot({ path: 'test-results/hover-preview-light.png' });
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(tab).toHaveAttribute('title', /Container: Research/);
  check(
    'Delayed hover shows full metadata without switching tabs; quick passes cancel and Escape dismisses',
  );

  await pin.hover();
  await expect(card).toBeVisible();
  await expect(card.locator('.preview-title')).toHaveText('Pinned project');
  await expect(card.locator('.preview-container')).toBeHidden();
  await pin.click({ button: 'right' });
  await expect(card).toBeHidden();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.move(2, 2);
  await page.locator('#home').focus();
  await pin.focus();
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  check('Pinned tabs support hover and keyboard previews; context menus dismiss the card');

  await tab.hover();
  await expect(card).toBeVisible();
  await page.evaluate(() =>
    window.previewTest.update(2, { title: 'Updated title', url: 'https://example.com/updated' }),
  );
  await expect(card).toBeHidden();
  await page.mouse.move(2, 2);
  await tab.hover();
  await expect(card.locator('.preview-title')).toHaveText('Updated title');
  await expect(card.locator('.preview-url')).toHaveText('https://example.com/updated');
  await page.locator('#tree').evaluate((node) => {
    node.scrollTop = 1000;
  });
  await expect(card).toBeHidden();
  check('Tab updates and scrolling dismiss stale previews; hovering again uses the new metadata');

  await page.setViewportSize({ width: 240, height: 420 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const last = page.locator('[data-key="tab:20"]');
  await last.scrollIntoViewIfNeeded();
  await last.evaluate((node) => {
    const tree = document.getElementById('tree');
    tree.scrollTop += node.getBoundingClientRect().bottom - tree.getBoundingClientRect().bottom + 4;
  });
  // Let resize/scroll dismissal settle before starting a fresh hover.
  await page.mouse.move(2, 2);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await last.hover();
  await expect(card).toBeVisible();
  let box = await card.boundingBox();
  const row = await last.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(232);
  expect(box.y).toBeGreaterThanOrEqual(8);
  expect(box.y + box.height).toBeLessThanOrEqual(row.y);
  await page.screenshot({ path: 'test-results/hover-preview-dark-narrow.png' });
  await page.setViewportSize({ width: 280, height: 480 });
  await expect(card).toBeHidden();
  check('Cards fit narrow dark sidebars, open above lower rows and dismiss on resize');

  await page.mouse.move(2, 2);
  await page.emulateMedia({ colorScheme: 'light' });
  await pin.hover();
  await expect(card).toBeVisible();
  await expect(card).toHaveCSS('background-color', 'rgb(247, 246, 250)');
  await expect(card).toHaveCSS('color', 'rgb(36, 32, 45)');
  await page.screenshot({ path: 'test-results/hover-preview-light.png' });
  expect(errors).toEqual([]);
  check('Preview colours switch back to compact light mode with no JavaScript errors');
  console.log(`${checks} hover preview UI checks passed.`);
} catch (error) {
  await page.screenshot({ path: 'test-results/hover-preview-failure.png' });
  throw error;
} finally {
  await close();
}
