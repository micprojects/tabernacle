import { expect } from '@playwright/test';
import { startUiTest } from './ui-test.js';

const { server, page, close } = await startUiTest({
  viewport: { width: 320, height: 820 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let checks = 0;

const check = (message) => {
  checks++;
  console.log(`✓ ${message}`);
};

const snapshot = () => page.evaluate(() => window.containerTest.snapshot());
const colorChoice = (name) =>
  page
    .getByRole('group', { name: 'Colour', exact: true })
    .getByRole('radio', { name, exact: true });
const iconChoice = (name) =>
  page.getByRole('group', { name: 'Icon', exact: true }).getByRole('radio', { name, exact: true });

const expectIconColor = (color) =>
  expect
    .poll(() =>
      page
        .locator('.container-choice-icon')
        .evaluateAll((icons) => [
          ...new Set(icons.map((icon) => getComputedStyle(icon).backgroundColor)),
        ]),
    )
    .toEqual([color]);

const expectIconsLoaded = async (icons) => {
  const loaded = await icons.evaluateAll((nodes) =>
    Promise.all(
      nodes.map(
        (node) =>
          new Promise((resolve) => {
            const image = new Image();
            image.onload = () => resolve(image.naturalWidth > 0);
            image.onerror = () => resolve(false);
            image.src = node.style.maskImage.slice(5, -2);
          }),
      ),
    ),
  );
  expect(loaded.length).toBeGreaterThan(0);
  expect(loaded.every(Boolean)).toBe(true);
};

const expectFaviconUnderline = async (row) => {
  const favicon = await row.locator('.tab-icon').boundingBox();
  const underline = await row.locator('.container-indicator').boundingBox();
  const bounds = await row.boundingBox();
  expect(underline.x).toBe(favicon.x);
  expect(underline.width).toBe(favicon.width);
  expect(underline.height).toBe(2);
  expect(underline.y).toBe(favicon.y + favicon.height + 2);
  expect(underline.y + underline.height).toBeLessThan(bounds.y + bounds.height);
};

const openPicker = async (row) => {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reopen in container…', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
};

try {
  await page.addInitScript(() => {
    const listeners = new Set();
    const testing = (window.containerTest = {
      identities: Array.from({ length: 28 }, (_, i) => ({
        cookieStoreId: `firefox-container-${i + 1}`,
        name: i === 0 ? 'Work' : i === 1 ? 'Personal' : `Project ${i + 1}`,
        colorCode: ['#00a7e0', '#f89c24', '#00a465', '#d65780'][i % 4],
        icon: ['fingerprint', 'briefcase', 'dollar', 'cart'][i % 4],
        iconUrl: `resource://usercontext-content/${['fingerprint', 'briefcase', 'dollar', 'cart'][i % 4]}.svg`,
      })),
      failCreate: false,
      failList: false,
      delayList: false,
      reopenCount: 0,
    });
    const ready = Promise.all([
      import('/preview/browser.js'),
      import('/extension/src/controller.js'),
    ]).then(([{ memoryBrowser }, { createController }]) => {
      const api = memoryBrowser({
        containers: testing.identities,
        groups: [{ id: 'project', name: 'Project', parentId: null }],
        tabs: [
          {
            id: 1,
            windowId: 1,
            index: 0,
            title: 'Parent page',
            url: 'https://example.com/parent',
            active: true,
            cookieStoreId: 'firefox-default',
          },
          {
            id: 2,
            windowId: 1,
            index: 1,
            title: 'Child page',
            url: 'https://example.com/child',
            active: false,
            cookieStoreId: 'firefox-default',
          },
        ],
        memberships: {
          1: { groupId: 'project', treeId: 'parent', ancestors: [], order: 0 },
          2: { groupId: 'project', treeId: 'child', ancestors: ['parent'], order: 0 },
        },
      });
      const create = api.tabs.create;
      api.tabs.create = (props) => {
        if (testing.failCreate) throw new Error('Firefox refused to reopen this page.');
        return create(props);
      };
      const query = api.contextualIdentities.query;
      api.contextualIdentities.query = async () => {
        if (testing.failList) throw new Error('Container access is unavailable.');
        return query();
      };
      const controller = createController(api, () => {
        for (const fn of listeners) fn({ type: 'tabernacle:changed' });
      });
      api.testing.setCreatedHandler((tab) => {
        controller.created(tab).catch(() => {});
      });
      return controller;
    });
    testing.snapshot = async () => (await ready).request({ type: 'snapshot', windowId: 1 });
    testing.send = async (type, args = {}) => (await ready).request({ type, windowId: 1, ...args });
    testing.notify = () => {
      for (const fn of listeners) fn({ type: 'tabernacle:changed' });
    };
    window.browser = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: {
        id: 'tabernacle-container-test',
        onMessage: { addListener: (fn) => listeners.add(fn) },

        sendMessage: async (message) => {
          const type = message.type.replace('tabernacle:', '');
          if (type === 'getContainers' && testing.delayList)
            await new Promise((resolve) => {
              testing.finishList = resolve;
            });
          if (type === 'reopenInContainer') testing.reopenCount++;
          try {
            if (type === 'createContainer' && testing.failIdentityCreate)
              throw new Error('Firefox refused to create this container.');
            const data = await (await ready).request({ ...message, type });
            if (type === 'getContainerChoices')
              // Firefox's current API returns browser-owned URLs; known icons must still render.
              data.icons = data.icons.map(({ icon }) => ({
                icon,
                iconUrl: `resource://usercontext-content/${icon}.svg`,
              }));
            return { ok: true, data };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/extension/sidebar.html`);
  let parent = page.locator('[data-key="tab:1"]');
  await expect(parent).toBeVisible();
  await openPicker(parent);
  await expect(page.getByRole('radio')).toHaveCount(29);
  const sortedNames = [
    'Personal',
    ...Array.from({ length: 26 }, (_, i) => `Project ${i + 3}`),
    'Work',
  ];
  await expect(page.locator('#dialog-options .container-name')).toHaveText([
    'No container',
    ...sortedNames,
  ]);
  await expect(page.getByRole('radio', { name: 'No container Current' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Reopen tab', exact: true })).toBeDisabled();
  await expectIconsLoaded(page.locator('#dialog-options .container-list-icon-mask'));
  await page.keyboard.press('ArrowDown');
  const personalChoice = page.getByRole('radio', { name: 'Personal', exact: true });
  await expect(personalChoice).toBeChecked();
  await expect(personalChoice).toBeFocused();
  await expect(personalChoice.locator('..').locator('.container-check')).toBeVisible();
  await expect(personalChoice.locator('..')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('radio', { name: 'No container Current' })).toBeChecked();
  await expect(personalChoice.locator('..').locator('.container-check')).toBeHidden();
  check('Container icons load and keyboard selection updates the tick and visible focus ring');
  expect(
    await page.locator('#dialog-options').evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  await page.getByRole('radio', { name: 'Project 28', exact: true }).check();
  expect(await page.locator('#dialog-options').evaluate((node) => node.scrollTop)).toBeGreaterThan(
    0,
  );
  await page.getByRole('radio', { name: 'Work', exact: true }).check();
  await page.screenshot({ path: 'test-results/container-picker.png' });
  check(
    'Dialog lists every container and No container, marks the current choice and scrolls long lists',
  );

  await page.getByRole('button', { name: 'Manage containers…', exact: true }).click();
  await expect(page.locator('.container-management-row .container-name')).toHaveText(sortedNames);
  await expectIconsLoaded(page.locator('.container-management-list .container-list-icon-mask'));
  await page.screenshot({ path: 'test-results/manage-containers-light.png' });
  await page.getByRole('button', { name: 'Edit Work', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toHaveClass(/compact-container-dialog/);
  await expect(colorChoice('Blue')).toBeChecked();
  await expect(iconChoice('Fingerprint')).toBeChecked();
  await expect(page.locator('.container-choice-icon')).toHaveCount(13);
  await expectIconsLoaded(page.locator('.container-choice-icon'));
  await page.screenshot({ path: 'test-results/container-editor-light.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Work', exact: true })).toBeChecked();
  check('Container lists sort alphabetically with natural numbers; every visual icon loads');

  await page.getByRole('button', { name: 'Reopen tab', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  let state = await snapshot();
  let source = state.tabs.find((tab) => tab.treeId === 'parent');
  expect(source.id).not.toBe(1);
  expect(source.cookieStoreId).toBe('firefox-container-1');
  expect(state.tabs.find((tab) => tab.id === 2).parentTabId).toBe(source.id);
  parent = page.locator(`[data-key="tab:${source.id}"]`);
  await expect(parent).toBeVisible();
  await expect(parent.locator('.container-indicator')).toHaveCSS(
    'background-color',
    'rgb(0, 167, 224)',
  );
  await expect(parent).toHaveAttribute('title', /Container: Work/);
  await expect(parent).toHaveAccessibleName('Parent page, container: Work, 1 nested tab');
  await expect(page.locator('[data-key="tab:2"] .container-indicator')).toHaveCount(0);
  await expect(page.locator('.group-row .container-indicator')).toHaveCount(0);
  await expectFaviconUnderline(parent);
  await page.screenshot({ path: 'test-results/container-indicators-nested.png' });
  check(
    'Reopening underlines the parent favicon in its container colour, independently of children',
  );

  await openPicker(parent);
  await expect(page.getByRole('radio', { name: 'Work Current' })).toBeChecked();
  await page.getByRole('radio', { name: 'No container', exact: true }).check();
  await page.getByRole('button', { name: 'Reopen tab', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  state = await snapshot();
  source = state.tabs.find((tab) => tab.treeId === 'parent');
  expect(source.cookieStoreId).toBe('firefox-default');
  parent = page.locator(`[data-key="tab:${source.id}"]`);
  await expect(parent.locator('.container-indicator')).toHaveCount(0);
  await expect(parent).toHaveAccessibleName('Parent page, 1 nested tab');
  await expect(parent).not.toHaveAttribute('title', /Container:/);
  await parent.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
  let pin = page.locator('.pinned-tab').first();
  await openPicker(pin);
  await page.getByRole('radio', { name: 'Personal', exact: true }).check();
  await page.getByRole('button', { name: 'Reopen tab', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  state = await snapshot();
  source = state.tabs.find((tab) => tab.treeId === 'parent');
  expect(source.cookieStoreId).toBe('firefox-container-2');
  expect(source.pinned).toBe(true);
  await expect(page.locator('.pinned-tab')).toHaveCount(1);
  await expect(pin.locator('.container-indicator')).toHaveCSS(
    'background-color',
    'rgb(248, 156, 36)',
  );
  await expect(pin).toHaveAccessibleName('Parent page, pinned, container: Personal');
  await expect(pin).toHaveAttribute('title', /Container: Personal/);
  await expectFaviconUnderline(pin);
  check(
    'No container removes the container and pinned tabs use the same picker while staying pinned',
  );

  await page.evaluate(async () => {
    await window.containerTest.send('reopenInContainer', {
      id: 2,
      cookieStoreId: 'firefox-container-1',
    });
  });
  const child = page
    .locator('.tab-row')
    .filter({ has: page.locator('.label', { hasText: 'Child page' }) });
  await expect(child.locator('.container-indicator')).toHaveCSS(
    'background-color',
    'rgb(0, 167, 224)',
  );
  await page.screenshot({ path: 'test-results/container-indicators-light.png' });
  await page.evaluate(() => {
    window.containerTest.identities[1].name = 'Shopping';
    window.containerTest.identities[1].colorCode = '#af51f5';
    window.containerTest.notify();
  });
  await expect(pin.locator('.container-indicator')).toHaveCSS(
    'background-color',
    'rgb(175, 81, 245)',
  );
  await expect(pin).toHaveAccessibleName('Parent page, pinned, container: Shopping');
  await expect(pin).toHaveAttribute('title', /Container: Shopping/);
  check('Container colour and name changes refresh existing pin indicators without a tab event');

  await openPicker(pin);
  await page.getByRole('radio', { name: 'Work', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  expect((await snapshot()).tabs.find((tab) => tab.treeId === 'parent').id).toBe(source.id);
  await page.evaluate(() => {
    window.containerTest.failCreate = true;
  });
  await openPicker(pin);
  await page.getByRole('radio', { name: 'Work', exact: true }).check();
  await page.getByRole('button', { name: 'Reopen tab', exact: true }).click();
  await expect(page.locator('#dialog-error')).toContainText('Firefox refused');
  expect((await snapshot()).tabs.find((tab) => tab.treeId === 'parent').id).toBe(source.id);
  await page.locator('#dialog-cancel').click();
  await page.evaluate(() => {
    window.containerTest.failCreate = false;
    window.containerTest.failList = true;
  });
  await openPicker(pin);
  await expect(page.locator('#dialog-error')).toContainText('Container access is unavailable');
  await expect(page.getByRole('button', { name: 'Reopen tab', exact: true })).toBeDisabled();
  await page.locator('#dialog-cancel').click();
  check('Cancel and API failures retain the original tab and present an actionable dialog error');

  await page.evaluate(() => {
    window.containerTest.failList = false;
    window.containerTest.delayList = true;
  });
  await openPicker(pin);
  await expect(page.locator('#dialog-options')).toContainText('Loading containers');
  await page.locator('#dialog-cancel').click();
  await page.locator('#new-group').click();
  await page.evaluate(() => {
    window.containerTest.delayList = false;
    window.containerTest.finishList();
  });
  await expect(page.locator('#dialog-title')).toHaveText('New group');
  await expect(page.locator('#dialog-options')).toBeHidden();
  await page.locator('#dialog-cancel').click();
  check('A delayed container lookup cannot overwrite a different dialog after cancellation');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 240, height: 540 });
  await expect(child.locator('.container-indicator')).toHaveCSS(
    'background-color',
    'rgb(0, 167, 224)',
  );
  await expect(child).toHaveCSS('min-height', '26px');
  await expectFaviconUnderline(child);
  expect(
    await page.locator('.sidebar').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/container-indicators-dark-narrow.png' });
  await openPicker(pin);
  await page.getByRole('radio', { name: 'Project 28', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: 'Project 28', exact: true })).toBeChecked();
  expect(
    await page.locator('#dialog').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/container-picker-dark-narrow.png' });
  await page.locator('#dialog-cancel').click();

  const group = page.locator('[data-key="group:project"]');

  const openGroupPicker = async (row) => {
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Default container…', exact: true }).click();
    await expect(page.locator('#dialog-title')).toHaveText('Default container');
  };

  const saveDefault = async (name) => {
    await page.getByRole('radio', { name, exact: true }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  };

  const currentTab = async () => (await snapshot()).tabs.find((tab) => tab.active);
  const existingTabs = (await snapshot()).tabs;
  await openGroupPicker(group);
  await expect(page.getByRole('radio', { name: 'Inherit (No container) Current' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: 'Work', exact: true }).check();
  expect(
    await page.locator('#dialog').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/group-container-picker-dark-narrow.png' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect((await snapshot()).tabs).toEqual(existingTabs);
  await expect(group).toHaveAttribute('title', /Default container: Work/);
  await expect(group.locator('.folder-icon')).toHaveCSS('color', 'rgb(0, 167, 224)');
  await expect(group.locator('.container-indicator')).toHaveCount(0);
  await group.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New tab here', exact: true }).click();
  await expect.poll(async () => (await currentTab()).cookieStoreId).toBe('firefox-container-1');
  await page.getByRole('button', { name: 'New tab in Project', exact: true }).click();
  await expect.poll(async () => (await currentTab()).groupId).toBe('project');
  expect((await currentTab()).cookieStoreId).toBe('firefox-container-1');
  expect((await currentTab()).parentTabId).toBe(null);
  await pin.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New child tab', exact: true }).click();
  await expect.poll(async () => (await currentTab()).parentTabId).toBe(source.id);
  expect((await currentTab()).cookieStoreId).toBe('firefox-container-1');
  check(
    'Group defaults save without changing existing tabs and apply to New tab here and New child tab',
  );

  const subgroupId = await page.evaluate(
    async () =>
      (await window.containerTest.send('createGroup', { name: 'Nested', parentId: 'project' }))
        .createdGroupId,
  );
  const subgroup = page.locator(`[data-key="group:${subgroupId}"]`);
  await expect(subgroup).toHaveAttribute('title', /Default container: Work \(inherited\)/);
  await expect(subgroup.locator('.folder-icon')).toHaveCSS('color', 'rgb(0, 167, 224)');
  await expect(subgroup).toHaveAccessibleName(
    'Nested, 0 tabs, default container: Work (inherited)',
  );
  await openGroupPicker(subgroup);
  await expect(page.getByRole('radio', { name: 'Inherit (Work) Current' })).toBeChecked();
  await page.locator('#dialog-cancel').click();
  await subgroup.dblclick();
  const heading = page.locator('#scope-heading');
  await expect(heading).toHaveAttribute('title', 'Default container: Work (inherited)');
  await expect(heading.locator('.folder-icon')).toHaveCount(0);
  await page.getByRole('button', { name: 'New tab in Nested', exact: true }).click();
  await expect.poll(async () => (await currentTab()).groupId).toBe(subgroupId);
  expect((await currentTab()).cookieStoreId).toBe('firefox-container-1');
  await expect(page.getByRole('button', { name: 'New tab in Nested', exact: true })).toBeVisible();
  await page.locator('#new-tab').click();
  await expect.poll(async () => (await currentTab()).groupId).toBe(subgroupId);
  expect((await currentTab()).cookieStoreId).toBe('firefox-container-1');
  const tree = page.locator('#tree');
  const blankPosition = { x: 15, y: (await tree.boundingBox()).height - 15 };
  const countBeforeDoubleClick = (await snapshot()).tabs.length;
  await tree.dblclick({ position: blankPosition });
  await expect.poll(async () => (await snapshot()).tabs.length).toBe(countBeforeDoubleClick + 1);
  expect((await currentTab()).cookieStoreId).toBe('firefox-container-1');
  await tree.click({ button: 'right', position: blankPosition });
  await page.getByRole('menuitem', { name: 'Default container…', exact: true }).click();
  await saveDefault('No container');
  await expect(heading).toHaveAttribute('title', 'Default container: No container');
  await page.getByRole('button', { name: 'New tab in Nested', exact: true }).click();
  await expect.poll(async () => (await currentTab()).cookieStoreId).toBe('firefox-default');
  await tree.click({ button: 'right', position: blankPosition });
  await page.getByRole('menuitem', { name: 'New tab in container…', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'No container', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Work', exact: true }).check();
  await page.getByRole('button', { name: 'Create tab', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect((await currentTab()).cookieStoreId).toBe('firefox-container-1');
  await tree.click({ button: 'right', position: blankPosition });
  await page.getByRole('menuitem', { name: 'Default container…', exact: true }).click();
  await saveDefault('Inherit (Work)');
  await expect(page.locator('#scope-heading')).toHaveAttribute(
    'title',
    'Default container: Work (inherited)',
  );
  check(
    'Nested defaults work through toolbar and blank-area creation, with No container and explicit overrides',
  );

  await page.evaluate(() => {
    window.containerTest.identities[0].name = 'Team';
    window.containerTest.identities[0].colorCode = '#af51f5';
    window.containerTest.notify();
  });
  await expect(heading).toHaveAttribute('title', 'Default container: Team (inherited)');
  await page.locator('#home').click();
  await expect(subgroup).toHaveAttribute('title', /Default container: Team \(inherited\)/);
  await expect(subgroup.locator('.folder-icon')).toHaveCSS('color', 'rgb(175, 81, 245)');
  await page.screenshot({ path: 'test-results/group-container-inheritance.png' });
  for (const color of [undefined, 'not-a-colour']) {
    await page.evaluate((color) => {
      window.containerTest.identities[0].colorCode = color;
      window.containerTest.notify();
    }, color);
    await expect(group.locator('.folder-icon')).toHaveCSS('color', 'rgb(173, 173, 173)');
    await expect(subgroup.locator('.folder-icon')).toHaveCSS('color', 'rgb(173, 173, 173)');
  }
  await page.evaluate(() => {
    window.containerTest.identities[0].colorCode = '#af51f5';
    window.containerTest.notify();
  });
  await expect(group.locator('.folder-icon')).toHaveCSS('color', 'rgb(175, 81, 245)');
  check('Folder colours and breadcrumb tooltips follow inheritance and live updates');
  await page.evaluate(() => {
    window.containerTest.failList = true;
  });
  await openGroupPicker(group);
  await expect(page.locator('#dialog-error')).toContainText('Container access is unavailable');
  await saveDefault('Inherit (No container)');
  await page.evaluate(() => {
    window.containerTest.failList = false;
    window.containerTest.notify();
  });
  await expect(group.locator('.container-indicator')).toHaveCount(0);
  await expect(subgroup.locator('.container-indicator')).toHaveCount(0);
  await expect(group.locator('.folder-icon')).toHaveCSS('color', 'rgb(173, 173, 173)');
  await expect(subgroup.locator('.folder-icon')).toHaveCSS('color', 'rgb(173, 173, 173)');
  check(
    'Inherited group indicators follow container changes and defaults can be cleared with containers disabled',
  );

  await page.evaluate(() => {
    window.containerTest.identities.splice(0);
    window.containerTest.notify();
  });
  await openPicker(pin);
  await expect(page.getByRole('radio')).toHaveCount(1);
  await expect(page.locator('#dialog-options')).toContainText('No containers are configured');
  await expect(page.locator('.container-indicator')).toHaveCount(0);
  await expect(pin).toHaveAccessibleName('Parent page, pinned');
  expect(errors).toEqual([]);
  check('Picker supports keyboard selection, narrow dark panels and an empty container list');

  await page.getByRole('button', { name: 'New container…', exact: true }).click();
  await expect(page.locator('#dialog-title')).toHaveText('New container');
  await expectIconColor('rgb(55, 173, 255)');
  await page.getByLabel('Container name', { exact: true }).fill('Research');
  await colorChoice('Purple').check();
  await expectIconColor('rgb(175, 81, 245)');
  await iconChoice('Fingerprint').focus();
  await page.keyboard.press('ArrowRight');
  await expect(iconChoice('Briefcase')).toBeChecked();
  await expect(iconChoice('Briefcase')).toBeFocused();
  await iconChoice('Tree').hover();
  await expectIconColor('rgb(175, 81, 245)');
  await expect(page.locator('.container-choice-icon').nth(1)).toHaveCSS('width', '20px');
  await expect(colorChoice('Purple').locator('..').locator('.container-choice-color')).toHaveCSS(
    'background-color',
    'rgb(175, 81, 245)',
  );
  expect(
    await page.getByRole('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.evaluate(() => {
    window.containerTest.failIdentityCreate = true;
  });
  await page.getByRole('button', { name: 'Create container', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Firefox refused');
  await expect(page.getByLabel('Container name', { exact: true })).toHaveValue('Research');
  await expect(colorChoice('Purple')).toBeChecked();
  await expect(iconChoice('Briefcase')).toBeChecked();
  await expect(colorChoice('Purple')).toBeEnabled();
  await page.evaluate(() => {
    window.containerTest.failIdentityCreate = false;
  });
  const tabsBeforeCreate = (await snapshot()).tabs.length;
  await page.screenshot({ path: 'test-results/create-container-dark-narrow.png' });
  await page.getByRole('button', { name: 'Create container', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Research', exact: true })).toBeChecked();
  expect((await snapshot()).tabs.length).toBe(tabsBeforeCreate);
  check('Creating a Firefox container handles errors and returns to the picker with it selected');

  await page.getByRole('button', { name: 'Manage containers…', exact: true }).click();
  await expect(page.locator('#dialog-title')).toHaveText('Manage containers');
  await page.getByRole('button', { name: 'Edit Research', exact: true }).click();
  await expect(colorChoice('Purple')).toBeChecked();
  await expect(iconChoice('Briefcase')).toBeChecked();
  await expectIconColor('rgb(175, 81, 245)');
  await page.getByLabel('Container name', { exact: true }).fill('Reading');
  await colorChoice('Green').check();
  await expectIconColor('rgb(81, 205, 0)');
  await iconChoice('Tree').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Reading', exact: true })).toBeVisible();
  const reading = (await snapshot()).containers.find((item) => item.name === 'Reading');
  expect(reading.color).toBe('green');
  expect(reading.icon).toBe('tree');
  await page.screenshot({ path: 'test-results/manage-containers-dark-narrow.png' });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Reading', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  check('Management edits shared container details and preserves the picker selection');

  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New container…', exact: true }).click();
  await expect(page.getByLabel('Container name', { exact: true })).toBeFocused();
  await page.getByLabel('Container name', { exact: true }).fill('Temporary');
  await page.getByRole('button', { name: 'Create container', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage containers…', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Temporary', exact: true }).click();
  await expect(page.locator('#dialog-description')).toContainText('cookies and site data');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Remove Temporary', exact: true })).toBeVisible();
  const temporary = (await snapshot()).containers.find((item) => item.name === 'Temporary');
  await page.evaluate(async (cookieStoreId) => {
    await window.containerTest.send('newTab', { cookieStoreId });
  }, temporary.cookieStoreId);
  await page.getByRole('button', { name: 'Remove Temporary', exact: true }).click();
  await page.getByRole('button', { name: 'Remove container', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Close this container’s tabs');
  await page.evaluate(async (cookieStoreId) => {
    const state = await window.containerTest.snapshot();
    await window.containerTest.send('closeTab', {
      id: state.tabs.find((tab) => tab.cookieStoreId === cookieStoreId).id,
    });
  }, temporary.cookieStoreId);
  await page.getByRole('button', { name: 'Remove container', exact: true }).click();
  await expect(page.locator('#dialog-title')).toHaveText('Manage containers');
  await expect(page.getByRole('button', { name: 'Remove Temporary', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(errors).toEqual([]);
  check('More options exposes both actions; removal supports cancellation and protects open tabs');

  const longName = 'Research and reference for the Copenhagen weekend website project';
  await page.evaluate(async (name) => {
    await window.containerTest.send('createContainer', { name, color: 'blue', icon: 'briefcase' });
  }, longName);
  await openPicker(pin);
  const longChoice = page.getByRole('radio', { name: longName, exact: true });
  await longChoice.check();
  await expect(longChoice.locator('..')).toHaveAttribute('title', longName);
  expect(
    await page.getByRole('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  const pickerRow = await longChoice.locator('..').boundingBox();
  await page.getByRole('button', { name: 'Manage containers…', exact: true }).click();
  const longRow = page.locator('.container-management-row').filter({ hasText: longName });
  await expect(
    longRow.getByRole('button', { name: `Edit ${longName}`, exact: true }),
  ).toBeVisible();
  await expect(
    longRow.getByRole('button', { name: `Remove ${longName}`, exact: true }),
  ).toBeVisible();
  await expect(longRow.locator('.container-name')).toHaveAttribute('title', longName);
  expect((await longRow.boundingBox()).height).toBe(pickerRow.height);
  expect(
    await page.getByRole('dialog').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/manage-containers-long-name.png' });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('radio', { name: longName, exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  check('Long names retain accessible labels and tooltips while both lists stay compact and fit');
  console.log(`${checks} container UI checks passed.`);
} catch (error) {
  await page.screenshot({ path: 'test-results/container-picker-failure.png' });
  throw error;
} finally {
  await close();
}
