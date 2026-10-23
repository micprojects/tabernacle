import { instrumentDialog, instrumentDemo } from '../helpers/probes/tab-collection.js';
import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from '../helpers/ui-test.js';

const { page, close, base } = await startUiTest({
  viewport: { width: 320, height: 740 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const dialogSource = await readFile('extension/src/dialogs.js', 'utf8');
await page.route('**/extension/src/dialogs.js', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: instrumentDialog(dialogSource),
  }),
);
const demo = await readFile('preview/demo.js', 'utf8');
await page.route('**/preview/demo.js', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body: instrumentDemo(demo),
  }),
);
const send = (type, args = {}) =>
  page.evaluate(([type, args]) => collectionTest.send(type, args), [type, args]);
const row = (id) => page.locator(`#tree .tab-row[data-id="${id}"]`);
const later = page.locator('#later-view');
const snapshot = () => send('snapshot');

const captureLayouts = async (name) => {
  for (const mode of ['light', 'dark', 'forced']) {
    await page.emulateMedia({
      colorScheme: mode === 'dark' ? 'dark' : 'light',
      forcedColors: mode === 'forced' ? 'active' : 'none',
    });
    for (const width of [220, 320, 480]) {
      await page.setViewportSize({ width, height: 740 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: `test-results/collection-${name}-${mode}-${width}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
  await page.setViewportSize({ width: 320, height: 740 });
};

try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await expect(row(1)).toBeVisible();
  await send('saveForLater', { id: 4 });
  await send('saveForLater', { id: 5 });
  await send('enterGroup', { id: 'work' });
  await page.keyboard.press('Control+k');
  await page.locator('#search').fill('Shared');
  await expect(page.locator('.saved-search-results .tab-row')).toHaveCount(1);
  await expect(row(4)).toBeVisible();
  await captureLayouts('saved-search');
  await row(4).click();
  await expect(page.locator('#search')).toHaveValue('Shared');
  expect((await snapshot()).tabs.find((tab) => tab.id === 4).savedForLaterAt).toBeTruthy();
  await row(4).click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#search')).toHaveValue('Shared');
  await row(4).getByRole('button', { name: 'Return to original folder' }).click();
  await expect(page.locator('#search')).toHaveValue('Shared');
  await expect(page.locator('.saved-search-results')).toHaveCount(0);
  await expect(row(4)).toBeVisible();
  await page.keyboard.press('Escape');

  await row(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
  await page.keyboard.press('Control+k');
  await expect(page.locator('#domain-search')).toBeFocused();
  await page.locator('#domain-search').fill('Shared');
  await expect(page.locator('#domain-count')).toHaveText('4 of 4 tabs');
  await page.locator('#domain-search').fill('page');
  await expect(page.locator('#tree .tab-row')).toHaveCount(3);
  await page.locator('#domain-sort').selectOption('least-viewed');
  await captureLayouts('domain-search');
  await page.locator('#domain-actions').click();
  await page.getByRole('menuitem', { name: 'Save 3 tabs for later', exact: true }).click();
  await expect(page.locator('#domain-count')).toHaveText('0 of 1 tab');
  const saved = (await snapshot()).tabs.filter((tab) => tab.savedForLaterAt);
  expect(saved.map((tab) => tab.id).sort()).toEqual([1, 2, 3, 5]);
  await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#tree .tab-row')).toHaveCount(3);
  expect((await snapshot()).tabs.filter((tab) => tab.savedForLaterAt).map((tab) => tab.id)).toEqual(
    [5],
  );

  await page.locator('#domain-actions').click();
  await page.getByRole('menuitem', { name: 'Review duplicates…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(3);
  await expect(
    dialog.getByRole('checkbox', { name: 'Close Shared page first', exact: true }),
  ).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Close 2 tabs', exact: true })).toBeEnabled();
  await dialog.getByRole('checkbox', { name: 'Close Shared page first', exact: true }).check();
  await expect(page.locator('#dialog-submit')).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Close Shared page first', exact: true }).uncheck();
  // Navigation removes stale candidates; a new duplicate is never silently added.
  await page.evaluate(() =>
    collectionTest.api.tabs.update(3, { url: 'https://example.test/changed' }),
  );
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(2);
  await page.evaluate(() =>
    collectionTest.api.tabs.create({
      windowId: 1,
      url: 'https://example.test/same',
      title: 'New duplicate',
      active: false,
    }),
  );
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(2);
  for (const mode of ['light', 'dark', 'forced']) {
    await page.emulateMedia({
      colorScheme: mode === 'dark' ? 'dark' : 'light',
      forcedColors: mode === 'forced' ? 'active' : 'none',
    });
    for (const width of [220, 320, 480]) {
      await page.setViewportSize({ width, height: 740 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/collection-duplicates-${mode}-${width}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
  await dialog.getByRole('button', { name: 'Close 1 tab', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await snapshot()).tabs.some((tab) => tab.id === 2)).toBe(false);
  expect((await snapshot()).tabs.some((tab) => tab.id === 3)).toBe(true);
  await page.locator('#domain-search').fill('article');
  await page.locator('#domain-actions').click();
  await page.getByRole('menuitem', { name: 'Close 1 tab…', exact: true }).click();
  await expect(page.locator('#dialog-cancel')).toBeFocused();
  await page.getByRole('button', { name: 'Close 1 tab', exact: true }).click();
  expect((await snapshot()).tabs.some((tab) => tab.id === 4)).toBe(false);

  await page.locator('#later-toggle').click();
  await page.keyboard.press('Control+k');
  await expect(page.locator('#later-search')).toBeFocused();
  await page.locator('#later-search').fill('Shared');
  await later
    .locator('.later-row')
    .getByRole('button', { name: 'Return to Personal', exact: true })
    .click();
  await expect(later).toBeVisible();
  await expect(page.locator('#later-search')).toHaveValue('Shared');
  await expect(page.locator('#later-search')).toBeFocused();
  await page.locator('#toast').getByRole('button', { name: 'Show in folder' }).click();
  await expect(later).toBeHidden();
  await expect(page.locator('#scope-heading')).toHaveText('Personal');
  // The result set includes rows outside the viewport. A batch must process them all.
  await page.evaluate(async () => {
    for (let i = 0; i < 240; i++)
      await collectionTest.api.tabs.create({
        windowId: 1,
        url: `https://large.test/${i}`,
        title: `Large collection ${i}`,
        active: false,
      });
  });
  await send('enterGroup', { id: null });
  const large = page.locator('#tree .tab-row').filter({ hasText: 'Large collection 0' }).first();
  await expect(large).toBeVisible();
  await large.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter by domain', exact: true }).click();
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  expect(await page.locator('#tree .tab-row').count()).toBeLessThan(100);
  const traverseResults = () =>
    page.evaluate(async () => {
      const tree = document.getElementById('tree');
      const titles = new Set();
      for (let top = 0; top < tree.scrollHeight; top += tree.clientHeight / 2) {
        tree.scrollTop = top;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        for (const row of tree.querySelectorAll('.tab-row .label')) titles.add(row.textContent);
      }
      return [...titles];
    });
  expect((await traverseResults()).sort()).toEqual(
    Array.from({ length: 240 }, (_, i) => `Large collection ${i}`).sort(),
  );
  await page.locator('#domain-actions').click();
  await page.getByRole('menuitem', { name: 'Save 240 tabs for later', exact: true }).click();
  await expect(page.locator('#tree .tab-row')).toHaveCount(0);
  expect((await snapshot()).tabs.filter((tab) => tab.savedForLaterAt).length).toBe(240);
  await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#tree')).toHaveClass(/viewport-tree/);
  expect(await page.locator('#tree .tab-row').count()).toBeLessThan(100);

  expect((await traverseResults()).sort()).toEqual(
    Array.from({ length: 240 }, (_, i) => `Large collection ${i}`).sort(),
  );
  await page.locator('#domain-close').click();
  await send('enterGroup', { id: null });
  const folderState = await snapshot();
  const expectedFolderIds = folderState.tabs
    .filter((tab) => ['work', 'design', 'research'].includes(tab.groupId) && !tab.savedForLaterAt)
    .map((tab) => tab.id);
  await page.locator('[data-key="group:work"]').click({ button: 'right' });
  const folderSave = page.getByRole('menuitem', {
    name: `Save tabs for later (${expectedFolderIds.length})`,
    exact: true,
  });
  await expect(folderSave).toBeVisible();
  const opened = await send('newTab', { groupId: 'work' });
  const newId = opened.tabs.find(
    (tab) => !folderState.tabs.some((before) => before.id === tab.id),
  ).id;
  await folderSave.click();
  const afterFolderSave = await snapshot();
  expect(
    afterFolderSave.tabs
      .filter((tab) => tab.savedForLaterAt)
      .map((tab) => tab.id)
      .sort(),
  ).toEqual(expectedFolderIds.sort());
  expect(afterFolderSave.tabs.find((tab) => tab.id === newId).savedForLaterAt).toBeFalsy();
  await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await snapshot()).tabs.some((tab) => tab.savedForLaterAt)).toBe(false);
  const releasedDialog = {
    action: false,
    cancel: false,
    complete: false,
    cleanup: false,
    context: false,
    controls: false,
    back: false,
    pickerHandlers: 0,
    options: 0,
    choices: 0,
    content: 0,
  };
  const beforeCancelled = await snapshot();
  await page.locator('#home').focus();
  await page.evaluate(() => dialogLifecycleProbe.bulk());
  expect(await page.evaluate(() => dialogLifecycleProbe.inspect().action)).toBe(true);
  await page.locator('#dialog-cancel').click();
  await expect
    .poll(() => page.evaluate(() => dialogLifecycleProbe.inspect()))
    .toEqual(releasedDialog);
  expect((await snapshot()).tabs).toEqual(beforeCancelled.tabs);
  await expect(page.locator('#home')).toBeFocused();

  for (const replace of [false, true]) {
    await page.evaluate(() => dialogLifecycleProbe.container());
    await expect(page.locator('#container-search')).toBeEnabled();
    expect(await page.evaluate(() => dialogLifecycleProbe.inspect().pickerHandlers)).toBe(6);
    if (replace) {
      await page.evaluate(() =>
        dialogLifecycleProbe.show({
          title: 'Plain replacement',
          input: false,

          onSubmit: () => {},
        }),
      );
      expect(await page.evaluate(() => dialogLifecycleProbe.inspect())).toMatchObject({
        pickerHandlers: 0,
        options: 0,
        choices: 0,
      });
    }
    await page.locator('#dialog-cancel').click();
    await expect
      .poll(() => page.evaluate(() => dialogLifecycleProbe.inspect()))
      .toEqual(releasedDialog);
  }

  for (const replacement of ['cancel', 'cleanup']) {
    await page.evaluate((replacement) => {
      const openNext = () =>
        dialogLifecycleProbe.show({
          title: 'Replacement ' + replacement,
          input: false,
          content: document.createElement('span'),

          onSubmit: () => {},
        });
      dialogLifecycleProbe.show({
        title: 'First dialog',
        input: false,

        onSubmit: () => {},

        ...(replacement === 'cancel' ? { onCancel: openNext } : { cleanup: openNext }),
      });
    }, replacement);
    await page.locator('#dialog-cancel').click();
    await expect(page.locator('#dialog-title')).toHaveText('Replacement ' + replacement);
    await expect(page.locator('#dialog')).toBeVisible();
    await expect(page.locator('#dialog-submit')).toBeFocused();
    expect(await page.evaluate(() => dialogLifecycleProbe.inspect())).toMatchObject({
      action: true,
      context: true,
      content: 1,
    });
    await page.locator('#dialog-cancel').click();
    await expect
      .poll(() => page.evaluate(() => dialogLifecycleProbe.inspect()))
      .toEqual(releasedDialog);
  }
  // Replacement initialisation restores the old submission's controls first.
  // A late old completion must not overwrite the replacement's deliberate state.
  for (const kind of ['input', 'choices'])
    for (const fail of [false, true]) {
      await page.evaluate(() => {
        window.oldDialogDone = false;
        dialogLifecycleProbe.show({
          title: 'Old pending dialog',
          input: false,
          onSubmit: () =>
            new Promise((resolve, reject) => {
              window.settleOldDialog = (fail) =>
                fail ? reject(new Error('Old failure')) : resolve('old result');
            }),

          afterSubmit: () => {
            oldDialogDone = true;
          },
        });
      });
      await page.locator('#dialog-submit').click();
      await page.evaluate((kind) => {
        dialogLifecycleProbe.show({
          title: 'New live dialog',
          value: 'editable',
          ...(kind === 'choices' ? { choices: [{ value: 'editable', label: 'Editable' }] } : {}),

          onBack: () => {},

          onSubmit: () => {},
        });
        document.getElementById('dialog-close').hidden = false;
      }, kind);
      for (const id of [
        'dialog-input',
        'dialog-select',
        'dialog-back',
        'dialog-close',
        'dialog-submit',
        'dialog-cancel',
      ])
        await expect(page.locator('#' + id)).toBeEnabled();
      await expect(
        page.locator(kind === 'input' ? '#dialog-input' : '#dialog-select'),
      ).toBeFocused();
      await page.evaluate(() => {
        for (const id of [
          'dialog-input',
          'dialog-select',
          'dialog-back',
          'dialog-close',
          'dialog-submit',
        ])
          document.getElementById(id).disabled = true;
      });
      await page.evaluate(async (fail) => {
        settleOldDialog(fail);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }, fail);
      await expect(page.locator('#dialog-title')).toHaveText('New live dialog');
      await expect(page.locator('#dialog')).toBeVisible();
      await expect(page.locator('#dialog-error')).toBeHidden();
      for (const id of [
        'dialog-input',
        'dialog-select',
        'dialog-back',
        'dialog-close',
        'dialog-submit',
      ])
        await expect(page.locator('#' + id)).toBeDisabled();
      expect(await page.evaluate(() => oldDialogDone)).toBe(!fail);
      // Restore only this test's intentional flags before the next scenario.
      await page.evaluate(() => {
        for (const id of [
          'dialog-input',
          'dialog-select',
          'dialog-back',
          'dialog-close',
          'dialog-submit',
        ])
          document.getElementById(id).disabled = false;
      });
      await page.locator('#dialog-cancel').click();
      await expect
        .poll(() => page.evaluate(() => dialogLifecycleProbe.inspect()))
        .toEqual(releasedDialog);
    }
  for (const outcome of ['success', 'failure', 'replacement', 'disposed']) {
    await page.evaluate((outcome) => {
      window.dialogCompletion = [];
      window.dialogSubmitted = false;
      window.dialogAttempts = 0;
      dialogLifecycleProbe.show({
        title: 'Pending dialog',
        input: false,

        onSubmit: async () => {
          dialogSubmitted = true;
          dialogAttempts++;
          await new Promise((resolve, reject) => {
            window.settleDialog = () =>
              outcome === 'failure' && dialogAttempts === 1
                ? reject(new Error('Try the dialog again'))
                : resolve();
          });
          if (outcome === 'replacement')
            dialogLifecycleProbe.show({
              title: 'Completion replacement',
              input: true,

              onBack: () => {},

              onSubmit: () => {},
            });
          return 'preserved result';
        },

        afterSubmit: (result) => {
          dialogCompletion.push(result);
          if (outcome === 'disposed') {
            dialogLifecycleProbe.show({
              title: 'Must not reopen',

              onSubmit: () => {},
            });
            dialogLifecycleProbe.resumeUi();
          }
        },
      });
    }, outcome);
    await page.locator('#dialog-submit').click();
    await expect.poll(() => page.evaluate(() => dialogSubmitted)).toBe(true);
    if (outcome === 'disposed')
      await page.evaluate(() => {
        window.dispatchEvent(new Event('pagehide'));
        window.lateDialogFocus = [];
        window.lateDialogMutations = [];
        document.addEventListener('focusin', (event) => lateDialogFocus.push(event.target.id));
        window.dialogMutationObserver = new MutationObserver((records) =>
          lateDialogMutations.push(...records.map((record) => record.type)),
        );
        dialogMutationObserver.observe(document.getElementById('dialog'), {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        });
      });
    await page.evaluate(() => settleDialog());
    if (outcome === 'failure') {
      await expect(page.locator('#dialog-error')).toHaveText('Try the dialog again');
      await expect(page.locator('#dialog-submit')).toBeEnabled();
      expect(await page.evaluate(() => dialogCompletion)).toEqual([]);
      expect(await page.evaluate(() => dialogLifecycleProbe.inspect().action)).toBe(true);
      await page.locator('#dialog-submit').click();
      await expect.poll(() => page.evaluate(() => dialogAttempts)).toBe(2);
      await page.evaluate(() => settleDialog());
      await expect.poll(() => page.evaluate(() => dialogCompletion)).toEqual(['preserved result']);
      await expect(page.locator('#dialog')).toBeHidden();
    } else {
      await expect.poll(() => page.evaluate(() => dialogCompletion)).toEqual(['preserved result']);
      if (outcome === 'replacement') {
        await expect(page.locator('#dialog-title')).toHaveText('Completion replacement');
        await expect(page.locator('#dialog')).toBeVisible();
        await expect(page.locator('#dialog-submit')).toBeEnabled();
        await expect(page.locator('#dialog-input')).toBeEnabled();
        await expect(page.locator('#dialog-input')).toBeFocused();
        await expect(page.locator('#dialog-select')).toBeEnabled();
        await expect(page.locator('#dialog-back')).toBeEnabled();
        await expect(page.locator('#dialog-close')).toBeEnabled();
        expect(await page.evaluate(() => dialogLifecycleProbe.inspect().action)).toBe(true);
        await page.locator('#dialog-cancel').click();
      }
    }
    await expect
      .poll(() => page.evaluate(() => dialogLifecycleProbe.inspect()))
      .toEqual(releasedDialog);
    if (outcome === 'disposed') {
      expect(
        await page.evaluate(() => ({ focus: lateDialogFocus, mutations: lateDialogMutations })),
      ).toEqual({ focus: [], mutations: [] });
      await page.evaluate(() => dialogMutationObserver.disconnect());
    }
  }
  console.log(
    '✓ Closed dialogs release captured collections and content; cancellation/replacement, retry and in-flight completion remain intact through disposal',
  );
  expect(errors).toEqual([]);
  console.log(
    '✓ Scoped saved search, domain search/sort, batch save/undo/close, stable duplicate review and Later return',
  );
} finally {
  await close();
}
