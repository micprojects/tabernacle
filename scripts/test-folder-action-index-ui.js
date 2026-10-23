import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startUiTest } from './ui-test.js';

const { page, close, base } = await startUiTest({ viewport: { width: 360, height: 720 } });
const errors = [];
const workCounts = [];
page.on('pageerror', (error) => errors.push(error.message));
const source = await readFile('extension/src/sidebar.js', 'utf8');
await page.route('**/extension/src/sidebar.js', (route) =>
  route.fulfill({
    contentType: 'application/javascript',
    body:
      source +
      '\nwindow.folderActions = {setState(value) {state = value;}, copyUrls, contextMenu, closeGroupTabsDialog, moveDialog};',
  }),
);
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async (value) => {
        window.copied = value;
      },
    },
  });
});
try {
  await page.goto(`${base}/extension/sidebar.html?demo`);
  await page.waitForFunction(() => window.folderActions && document.querySelector('.tab-row'));
  for (const shape of ['flat', 'deep']) {
    const result = await page.evaluate(async (shape) => {
      const count = shape === 'flat' ? 1000 : 400;
      let reads = 0;
      const groups = Array.from({ length: count }, (_, i) => ({
        get id() {
          reads++;
          return `g${i}`;
        },

        get parentId() {
          reads++;
          return shape === 'deep' && i > 1 ? `g${i - 1}` : null;
        },

        name: i < 3 ? 'Duplicate name' : `Folder ${i}`,
      }));
      const tabs = Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        treeId: `t${i}`,
        groupId: `g${i % count}`,
        parentTabId: null,
        index: i,
        order: 1000 - i,
        url: `https://same.test/${i % 10}`,
        savedForLaterAt: i % 17 === 0 ? 1 : null,
        pinned: i % 19 === 0,
      }));
      const state = {
        groups,
        tabs,
        containers: [],
        folderPins: [],
        pins: [],
        view: { scopeId: null, collapsed: groups.map((group) => group.id) },
      };
      folderActions.setState(state);
      const member = (tab) => (shape === 'flat' ? tab.groupId === 'g1' : tab.groupId !== 'g0');
      const expected = tabs
        .filter((tab) => !tab.savedForLaterAt && member(tab))
        .sort((a, b) => a.order - b.order)
        .map((tab) => tab.url)
        .join('\n');
      reads = 0;
      await folderActions.copyUrls('group', 'g1');
      const copy = { actual: window.copied, expected, reads };
      reads = 0;
      folderActions.closeGroupTabsDialog('g1');
      const confirmation = {
        text: document.querySelector('#dialog-description').textContent,
        expected: tabs.filter((tab) => !tab.savedForLaterAt && member(tab)).length,
        reads,
      };
      document.querySelector('#dialog').close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      reads = 0;
      folderActions.moveDialog('contents', 'g0');
      const choices = [...document.querySelectorAll('#dialog-select option')].map((option) => ({
        value: option.value,
        label: option.textContent,
      }));
      const move = { reads, choices, count };
      document.querySelector('#dialog').close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The next action must rebuild from mutable current hierarchy.
      groups[2] = { id: 'g2', parentId: 'g0', name: 'Moved' };
      folderActions.moveDialog('contents', 'g0');
      const afterMove = [...document.querySelectorAll('#dialog-select option')].map(
        (option) => option.value,
      );
      document.querySelector('#dialog').close();
      groups.push({ id: 'empty', parentId: null, name: 'Empty' });
      reads = 0;
      folderActions.contextMenu('group', 'empty', 10, 10);
      const menu = {
        reads,
        disabled: [...document.querySelectorAll('#menu button')].find((button) =>
          button.textContent.startsWith('Close all tabs'),
        ).disabled,
      };
      const closeItem = () =>
        [...document.querySelectorAll('#menu button')].find((button) =>
          button.textContent.startsWith('Close all tabs'),
        );
      tabs.push({ ...tabs[0], id: 1001, treeId: 'empty-pin', groupId: 'empty', pinned: true });
      folderActions.contextMenu('group', 'empty', 10, 10);
      menu.savedOnlyDisabled = closeItem().disabled;
      tabs.at(-1).savedForLaterAt = null;
      folderActions.contextMenu('group', 'empty', 10, 10);
      menu.pinEnabled = !closeItem().disabled;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // A missing folder must not reopen confirmation or overwrite the clipboard.
      await new Promise((resolve) => setTimeout(resolve, 0));
      window.copied = 'clipboard sentinel';
      await folderActions.copyUrls('group', 'missing');
      folderActions.closeGroupTabsDialog('missing');
      const stale = { copied: window.copied, open: document.querySelector('#dialog').open };
      return { copy, confirmation, move, afterMove, menu, stale };
    }, shape);
    workCounts.push({
      shape,
      copy: result.copy.reads,
      close: result.confirmation.reads,
      contents: result.move.reads,
      menu: result.menu.reads,
    });
    expect(result.menu.disabled).toBe(true);
    expect(result.menu.savedOnlyDisabled).toBe(true);
    expect(result.menu.pinEnabled).toBe(true);
    expect(result.menu.reads).toBeLessThan(40000);
    expect(result.stale).toEqual({ copied: 'clipboard sentinel', open: false });
    expect(result.copy.actual).toBe(result.copy.expected);
    expect(result.copy.reads).toBeLessThan(20000);
    expect(result.confirmation.text).toContain(
      `Close ${result.confirmation.expected} ${result.confirmation.expected === 1 ? 'tab' : 'tabs'}`,
    );
    expect(result.confirmation.reads).toBeLessThan(20000);
    expect(result.move.reads).toBeLessThan(20000);
    expect(result.move.choices.map((choice) => choice.value)).toEqual([
      '',
      ...Array.from({ length: result.move.count - 1 }, (_, i) => `g${i + 1}`),
    ]);
    expect(result.move.choices[2].label).toBe(`${shape === 'deep' ? '　' : ''}Duplicate name`);
    expect(result.afterMove).not.toContain('g2');
    if (shape === 'deep') expect(result.afterMove).toEqual(['', 'g1']);
  }
  expect(errors).toEqual([]);
  console.log('Hierarchy field reads:', JSON.stringify(workCounts));
  console.log(
    '✓ Indexed folder actions bound hierarchy visits and preserve copy order, pins, Saved exclusion, deep labels and mutable destinations',
  );
} finally {
  await close();
}
