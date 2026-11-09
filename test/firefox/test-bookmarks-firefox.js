import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { ScreenshotBrowser } from '../../scripts/screenshot-browser.js';
import { Button } from 'selenium-webdriver';
import {
  indexBookmarks,
  bookmarkRecord,
  bookmarkSubtree,
} from '../../extension/src/bookmark-edit.js';

const session = new ScreenshotBrowser();
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Bookmark reference</title><p>Local bookmark fixture</p>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/reference`;
const fixture = {
  window: { width: 1040, height: 760 },
  sidebarWidth: 320,
  capture: { sourceSize: { width: 320, height: 600 }, scale: 2 },
};
await mkdir('test-results', { recursive: true });
const wait = (fn, message) => session.driver.wait(() => session.evaluate(fn), 10000, message);
const send = (type, args = {}) =>
  session.evaluate(
    async ({ type, args }) => {
      const reply = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId: (await browser.windows.getCurrent()).id,
        ...args,
      });
      if (!reply.ok) throw new Error(reply.error);
      return reply.data;
    },
    { type, args },
  );

try {
  await session.open(fixture, 'test-results/bookmarks-firefox.log');
  await wait(() => !document.querySelector('#bookmarks-toggle').disabled);
  await session.evaluate(() => document.querySelector('#bookmarks-toggle').click());
  await wait(() =>
    document
      .querySelector('#bookmarks-view [role="status"]')
      .textContent.includes('Allow Tabernacle'),
  );
  assert.equal(
    await session.evaluate(() => browser.permissions.contains({ permissions: ['bookmarks'] })),
    false,
  );
  assert.deepEqual(
    await session.evaluate(() =>
      ['new-tab', 'new-group'].map((id) => document.getElementById(id).disabled),
    ),
    [true, true],
  );
  // Grant only this optional permission in the owned temporary Firefox profile.
  await session.chrome(async () => {
    const id = 'tabernacle@michaelprojects.com';
    const { ExtensionPermissions } = ChromeUtils.importESModule(
      'resource://gre/modules/ExtensionPermissions.sys.mjs',
    );
    await ExtensionPermissions.add(
      id,
      { permissions: ['bookmarks'], origins: [] },
      WebExtensionPolicy.getByID(id).extension,
    );
  });
  const bookmarks = await session.evaluate(async (url) => {
    const folder = await browser.bookmarks.create({
      parentId: 'toolbar_____',
      title: 'Project references',
    });
    const nested = await browser.bookmarks.create({ parentId: folder.id, title: 'Research' });
    const first = await browser.bookmarks.create({
      parentId: nested.id,
      title: 'Reference café',
      url,
    });
    const second = await browser.bookmarks.create({
      parentId: nested.id,
      title: 'Second reference',
      url: `${url}?second`,
    });
    return { folder: folder.id, nested: nested.id, first: first.id, second: second.id };
  }, url);
  await wait(() => document.querySelector('.bookmark-location[aria-selected="true"]'));
  assert.equal(
    await session.evaluate(
      () =>
        document.querySelector('.bookmark-location[aria-selected="true"]').dataset.bookmarkRootId,
    ),
    'menu________',
  );
  await session.evaluate(() =>
    document.querySelector('[data-bookmark-root-id="toolbar_____"]').click(),
  );
  await wait(() => document.querySelector('#bookmarks-tree [aria-label="Project references"]'));
  await session.evaluate(() => document.querySelector('#bookmarks-toggle').click());
  const container = await send('createContainer', {
    name: 'Bookmark work',
    color: 'blue',
    icon: 'briefcase',
  });
  const folder = await send('createGroup', {
    name: 'Current work',
    cookieStoreId: container.createdCookieStoreId,
  });
  const child = await send('createGroup', {
    name: 'Research tabs',
    parentId: folder.createdGroupId,
  });
  await send('enterGroup', { id: child.createdGroupId });
  const before = await send('snapshot');
  const savedBookmarks = await session.evaluate(() => browser.bookmarks.getTree());
  await session.evaluate(() => document.querySelector('#bookmarks-toggle').click());
  await wait(() => document.querySelector('#bookmarks-tree [aria-label="Project references"]'));
  await wait(
    () =>
      document.querySelector('.bookmarks-destination-label').textContent ===
      'Open in Research tabs',
  );
  // The shared footer toggle expands every bookmark depth without changing the tab tree.
  await session.evaluate(() => document.getElementById('tree-toggle').click());
  assert.deepEqual(
    await session.evaluate(() => ({
      open: !document.getElementById('bookmarks-view').hidden,
      expanded: [...document.querySelectorAll('.bookmark-row.group-row')].map((node) =>
        node.getAttribute('aria-expanded'),
      ),
      controls: document.getElementById('tree-toggle').getAttribute('aria-controls'),
    })),
    { open: true, expanded: ['true', 'true'], controls: 'bookmarks-tree' },
  );
  await session.evaluate(() => document.getElementById('tree-toggle').click());
  assert.equal(await session.evaluate(() => document.querySelectorAll('.bookmark-row').length), 1);
  assert.equal(
    await session.evaluate(() => document.getElementById('tree-toggle').getAttribute('aria-label')),
    'Expand all in Bookmarks Toolbar',
  );
  assert.deepEqual((await send('snapshot')).view, before.view);
  assert.deepEqual(await session.evaluate(() => browser.bookmarks.getTree()), savedBookmarks);
  await session.evaluate(() => {
    const search = document.getElementById('bookmarks-search');
    search.value = 'CAFÉ';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await session.evaluate(() => document.getElementById('tree-toggle').disabled), true);
  const search = await session.evaluate(() =>
    [...document.querySelectorAll('#bookmarks-tree [role="treeitem"]')].map((node) => ({
      label: node.getAttribute('aria-label'),
      level: node.getAttribute('aria-level'),
    })),
  );
  assert.deepEqual(
    search.map((item) => item.label),
    ['Project references', 'Research', 'Reference café'],
  );
  assert.deepEqual(
    search.map((item) => item.level),
    ['1', '2', '3'],
  );
  await session.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await writeFile('test-results/bookmarks-firefox.png', await session.screenshot(fixture.capture));
  const layout = await session.evaluate(() => {
    const heading = document.querySelector('#bookmarks-view .pane-heading').getBoundingClientRect();
    const footer = document.querySelector('.sidebar > footer').getBoundingClientRect();
    return {
      headingTop: heading.top,
      headingHeight: heading.height,
      footerBottom: footer.bottom,
      viewportHeight: innerHeight,
      scrollY,
    };
  });
  assert.equal(layout.headingTop, 0);
  assert(layout.headingHeight > 0);
  assert.equal(layout.footerBottom, layout.viewportHeight);
  assert.equal(layout.scrollY, 0);
  await session.evaluate(() =>
    document
      .getElementById('bookmarks-search')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  await wait(() => document.getElementById('bookmarks-view').hidden);
  await session.driver.wait(
    async () => (await send('snapshot')).tabs.some((tab) => tab.url === url),
    10000,
  );
  const after = await send('snapshot');
  const created = after.tabs.find((tab) => !before.tabs.some((old) => old.id === tab.id));
  assert(created);
  assert.equal(created.url, url);
  assert.equal(created.cookieStoreId, container.createdCookieStoreId);
  assert.equal(created.groupId, child.createdGroupId);
  assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(after.domainPins, before.domainPins);
  assert.deepEqual(await session.evaluate(() => browser.bookmarks.getTree()), savedBookmarks);
  console.log('✓ Native bookmark creation and inherited container verified');

  const operationId = crypto.randomUUID();
  const opened = await send('openBookmark', {
    id: bookmarks.second,
    groupId: child.createdGroupId,
    operationId,
  });
  await session.reloadSidebar();
  await wait(() => !document.querySelector('#bookmarks-toggle').disabled);
  const retried = await send('openBookmark', {
    id: bookmarks.second,
    groupId: child.createdGroupId,
    operationId,
  });
  assert.equal(retried.createdTabId, opened.createdTabId);
  assert.equal(retried.tabs.length, opened.tabs.length);
  console.log('✓ Native bookmark opening retry after sidebar reload verified');

  const other = await session.evaluate(
    async ({ bookmarkId, url }) => {
      const win = await browser.windows.create({ url: 'about:blank', focused: false });
      const operationId = crypto.randomUUID();
      const response = await browser.runtime.sendMessage({
        type: 'tabernacle:openBookmark',
        windowId: win.id,
        id: bookmarkId,
        groupId: null,
        operationId,
      });
      if (!response.ok) throw new Error(response.error);
      let tab = await browser.tabs.get(response.data.createdTabId);
      const deadline = Date.now() + 10000;
      while (tab.url !== url && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        tab = await browser.tabs.get(tab.id);
      }
      const placed = response.data.tabs.find((item) => item.id === tab.id);
      const result = {
        groupId: placed.groupId,
        cookieStoreId: tab.cookieStoreId,
        url: tab.url,
        correctUrl: tab.url === url,
      };
      await browser.windows.remove(win.id);
      return result;
    },
    { bookmarkId: bookmarks.first, url },
  );
  assert.equal(other.groupId, null);
  assert.equal(other.cookieStoreId, 'firefox-default');
  assert(other.correctUrl);
  console.log('✓ Native second-window destination verified');

  // Native reordering leaves the displayed children alphabetical.
  await session.evaluate(({ folder, nested, second }) => {
    document.getElementById('bookmarks-toggle').click();
    return browser.bookmarks.move(second, { parentId: nested, index: 0 });
  }, bookmarks);
  await wait(() => document.querySelector('[data-bookmark-root-id="toolbar_____"]'));
  await session.evaluate(() =>
    document.querySelector('[data-bookmark-root-id="toolbar_____"]').click(),
  );
  await wait(() => document.querySelector('#bookmarks-tree [aria-label="Project references"]'));
  await session.evaluate(() => {
    const field = document.getElementById('bookmarks-search');
    field.value = 'reference';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(() => document.querySelector('#bookmarks-tree [aria-label="Second reference"]'));
  await session.driver.wait(
    () =>
      session.evaluate(
        (id) => document.querySelector('#bookmarks-tree .tab-row')?.dataset.bookmarkId === id,
        bookmarks.first,
      ),
    10000,
    'Bookmark move did not retain alphabetical display',
  );
  assert.deepEqual(
    await session.evaluate(() =>
      [...document.querySelectorAll('#bookmarks-tree .tab-row')].map(
        (node) => node.dataset.bookmarkId,
      ),
    ),
    [bookmarks.first, bookmarks.second],
  );
  assert.deepEqual(
    await session.evaluate(
      async (id) => (await browser.bookmarks.getChildren(id)).map((node) => node.id),
      bookmarks.nested,
    ),
    [bookmarks.second, bookmarks.first],
  );
  // Edit through the same dialog used in the native sidebar.
  await session.evaluate((id) => {
    const row = document.querySelector(`[data-bookmark-id="${id}"]`);
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  }, bookmarks.first);
  await wait(() => document.getElementById('dialog').open);
  await session.evaluate((url) => {
    document.querySelector('#dialog-content input[aria-label="Name"]').value =
      'Edited café reference';
    document.querySelector('#dialog-content input[aria-label="Address"]').value = `${url}?edited`;
    document.getElementById('dialog-form').requestSubmit();
  }, url);
  await wait(() => !document.getElementById('dialog').open);
  const edited = await session.evaluate(
    async (id) => (await browser.bookmarks.get(id))[0],
    bookmarks.first,
  );
  assert.equal(edited.title, 'Edited café reference');
  assert.equal(edited.url, `${url}?edited`);

  const nativeIndex = async () =>
    indexBookmarks(await session.evaluate(() => browser.bookmarks.getTree()));

  const change = async (kind, id, extra = {}) => {
    const index = await nativeIndex();
    const operation = {
      operationId: crypto.randomUUID(),
      command:
        kind === 'create'
          ? { kind, ...extra }
          : {
              kind,
              id,
              expected: bookmarkRecord(index.byId.get(id)),
              ...(kind === 'delete' ? { contents: bookmarkSubtree(index, id) } : {}),
              ...extra,
            },
    };
    return { operation, result: await send('editBookmark', operation) };
  };

  // Footer creation starts in the selected location and keeps the searchable picker.
  const beforeFooter = await send('snapshot');
  await session.evaluate(() => document.getElementById('new-group').click());
  await wait(() => document.getElementById('dialog').open);
  assert.equal(
    await session.evaluate(() => document.getElementById('bookmark-create-in').textContent),
    'Bookmarks Toolbar',
  );
  assert.equal(
    await session.evaluate(() => document.getElementById('bookmarks-view').hidden),
    false,
  );
  await session.evaluate(() => {
    document.querySelector('#dialog-content input[aria-label="Name"]').value = 'Saved references';
    document.getElementById('bookmark-create-in').click();
    const search = document.querySelector('#dialog-content input[aria-label="Find a folder"]');
    search.value = 'Project references';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(() =>
    document.querySelector('#bookmark-folder-picker-tree [aria-label="Project references"]'),
  );
  assert.equal(
    await session.evaluate(() =>
      document.querySelector('#bookmark-folder-picker-tree [aria-label="Home"]'),
    ),
    null,
  );
  await session.evaluate(() => {
    document
      .querySelector('#bookmark-folder-picker-tree [aria-label="Project references"]')
      .click();
    document.getElementById('dialog-form').requestSubmit();
  });
  await wait(() => !document.getElementById('dialog').open);
  const newFolder = {
    result: [...(await nativeIndex()).byId.values()].find(
      (node) => node.title === 'Saved references',
    ),
  };
  assert.equal(newFolder.result.parentId, bookmarks.folder);
  // The footer plus also creates bookmarks, with the selected root as its default.
  await session.evaluate(() => {
    const search = document.getElementById('bookmarks-search');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await session.evaluate(
    (id) => document.querySelector(`[data-bookmark-id="${id}"]`).click(),
    newFolder.result.id,
  );
  await session.evaluate(() => document.getElementById('new-tab').click());
  await wait(() => document.getElementById('dialog').open);
  assert.equal(
    await session.evaluate(() => document.getElementById('bookmark-create-in').textContent),
    'Bookmarks Toolbar',
  );
  await session.evaluate(() => {
    document.getElementById('bookmark-create-in').click();
    const search = document.querySelector('#dialog-content input[aria-label="Find a folder"]');
    search.value = 'Saved references';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(() =>
    document.querySelector('#bookmark-folder-picker-tree [aria-label="Saved references"]'),
  );
  await session.evaluate(() =>
    document.querySelector('#bookmark-folder-picker-tree [aria-label="Saved references"]').click(),
  );
  await session.evaluate((url) => {
    document.querySelector('#dialog-content input[aria-label="Name"]').value = 'Quick reference';
    document.querySelector('#dialog-content input[aria-label="Address"]').value = `${url}?quick`;
    document.getElementById('dialog-form').requestSubmit();
  }, url);
  await wait(() => !document.getElementById('dialog').open);
  const quick = [...(await nativeIndex()).byId.values()].find(
    (node) => node.title === 'Quick reference',
  );
  assert.equal(quick.parentId, newFolder.result.id);
  const afterFooter = await send('snapshot');
  assert.deepEqual(afterFooter.groups, beforeFooter.groups);
  assert.deepEqual(afterFooter.tabs, beforeFooter.tabs);
  for (const visible of [true, false]) {
    await send('setLook', { value: { folderCounts: visible }, partial: true });
    await session.driver.wait(
      () =>
        session.evaluate(
          ({ id, visible }) => {
            const count = document.querySelector(`[data-bookmark-id="${id}"] .bookmark-count`);
            return count && (getComputedStyle(count).display !== 'none') === visible;
          },
          { id: newFolder.result.id, visible },
        ),
      10000,
      'Bookmark counts should follow the broadcast appearance setting',
    );
  }
  assert.equal(
    await session.evaluate(() => document.querySelectorAll('.bookmark-row button').length),
    0,
  );
  assert.match(
    await session.evaluate((id) => {
      const add = document.querySelector(`[data-bookmark-parent-id="${id}"]`);
      return getComputedStyle(add, '::before').maskImage;
    }, newFolder.result.id),
    /tree-guide-end.svg/,
  );
  await writeFile(
    'test-results/bookmarks-tree-controls-firefox.png',
    await session.screenshot(fixture.capture),
  );
  await session.evaluate((id) => browser.bookmarks.remove(id), quick.id);
  const newBookmark = await change('create', null, {
    type: 'bookmark',
    parentId: newFolder.result.id,
    title: 'Created reference',
    url: `${url}?created`,
  });
  // A lost completion write leaves the saved operation pending across a sidebar reload.
  await session.evaluate(async (operationId) => {
    const key = 'tabernacle.bookmark-edits.v1';
    const store = (await browser.storage.local.get(key))[key];
    store.records.find((record) => record.operationId === operationId).phase = 'pending';
    await browser.storage.local.set({ [key]: store });
  }, newBookmark.operation.operationId);
  await session.reloadSidebar();
  await wait(() => !document.querySelector('#bookmarks-toggle').disabled);
  await session.evaluate(() => document.querySelector('#bookmarks-toggle').click());
  await wait(() => !document.querySelector('.bookmark-recovery-status').hidden);
  await session.evaluate(() =>
    document.querySelector('.bookmark-recovery-status [aria-label="Review changes"]').click(),
  );
  await wait(() => document.getElementById('dialog').open);
  await session.evaluate(() =>
    document.querySelector('#dialog [aria-label="Retry change"]').click(),
  );
  await wait(() =>
    document.getElementById('dialog-content').textContent.includes('Change completed.'),
  );
  await session.evaluate(() => document.getElementById('dialog-cancel').click());
  await wait(() => document.querySelector('.bookmark-recovery-status').hidden);
  await session.evaluate(() => document.querySelector('#bookmarks-view .pane-back').click());
  assert.deepEqual(await send('editBookmark', newBookmark.operation), newBookmark.result);
  assert.equal(
    [...(await nativeIndex()).byId.values()].filter((node) => node.title === 'Created reference')
      .length,
    1,
  );

  // Moving to the end of the same parent uses Firefox's final index semantics.
  await change('move', bookmarks.second, { targetId: bookmarks.first, position: 'after' });
  assert.deepEqual(
    (await nativeIndex()).byId.get(bookmarks.nested).children.map((node) => node.id),
    [bookmarks.first, bookmarks.second],
  );
  await change('move', bookmarks.second, { targetId: bookmarks.first, position: 'before' });
  assert.deepEqual(
    (await nativeIndex()).byId.get(bookmarks.nested).children.map((node) => node.id),
    [bookmarks.second, bookmarks.first],
  );

  const savedOrder = await session.evaluate(() => browser.bookmarks.getTree());
  // The sorted view preserves Firefox's saved order and uses folder drop targets.
  await session.evaluate(() => document.querySelector('#bookmarks-toggle').click());
  await wait(() => document.querySelector('[data-bookmark-root-id="toolbar_____"]'));
  await session.evaluate(() =>
    document.querySelector('[data-bookmark-root-id="toolbar_____"]').click(),
  );
  await wait(() => document.querySelector('#bookmarks-tree [aria-label="Project references"]'));
  await session.evaluate(() => {
    const search = document.getElementById('bookmarks-search');
    search.value = 'reference';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(() => document.querySelector('#bookmarks-tree [aria-label="Created reference"]'));
  assert.deepEqual(await session.evaluate(() => browser.bookmarks.getTree()), savedOrder);
  assert.deepEqual(
    await session.evaluate(
      (id) =>
        [
          ...document
            .querySelector(`[data-bookmark-id="${id}"]`)
            .parentElement.querySelectorAll('.bookmark-row'),
        ].map((row) => row.getAttribute('aria-label')),
      bookmarks.nested,
    ),
    ['Research', 'Edited café reference', 'Second reference'],
  );
  const offset = await session.chrome(() => {
    const sidebar = document.getElementById('sidebar');
    const outer = sidebar.getBoundingClientRect();
    const inner = sidebar.contentDocument
      .getElementById('webext-panels-browser')
      .getBoundingClientRect();
    return { x: outer.x + inner.x, y: outer.y + inner.y };
  });

  const point = async (id, fraction) => {
    const rect = await session.evaluate((id) => {
      const rect = document.querySelector(`[data-bookmark-id="${id}"]`).getBoundingClientRect();
      return { x: rect.x, y: rect.y, height: rect.height };
    }, id);
    return {
      x: Math.round(offset.x + rect.x + 50),
      y: Math.round(offset.y + rect.y + rect.height * fraction),
    };
  };

  const start = await point(newBookmark.result.id, 0.5);
  await session.driver
    .actions()
    .move(start)
    .press(Button.LEFT)
    .move({ ...start, y: start.y + 7, duration: 120 })
    .move({ ...(await point(bookmarks.second, 0.1)), duration: 180 })
    .perform();
  await wait(() =>
    document
      .querySelector('#bookmarks-view .move-preview')
      ?.textContent.includes('Into “Research”'),
  );
  await session.driver.actions().release(Button.LEFT).perform();
  await session.driver.wait(
    async () => (await nativeIndex()).byId.get(newBookmark.result.id).parentId === bookmarks.nested,
    10000,
  );
  assert.deepEqual(
    (await nativeIndex()).byId.get(bookmarks.nested).children.map((node) => node.id),
    [bookmarks.second, bookmarks.first, newBookmark.result.id],
  );
  assert.deepEqual(
    await session.evaluate(
      (id) =>
        [
          ...document
            .querySelector(`[data-bookmark-id="${id}"]`)
            .parentElement.querySelectorAll('.bookmark-row'),
        ].map((row) => row.getAttribute('aria-label')),
      bookmarks.nested,
    ),
    ['Research', 'Created reference', 'Edited café reference', 'Second reference'],
  );
  await writeFile(
    'test-results/bookmark-editing-firefox.png',
    await session.screenshot(fixture.capture),
  );

  // Dropping on a location segment moves to its native root and reveals the bookmark there.
  const crossRoot = await change('create', null, {
    type: 'bookmark',
    parentId: bookmarks.folder,
    title: 'Cross-root reference',
    url: `${url}?cross-root`,
  });
  await wait(() => document.querySelector('#bookmarks-tree [aria-label="Cross-root reference"]'));
  await wait(
    () => document.getElementById('toast').hidden,
    'The previous move notice covered the next drag source',
  );
  await session.evaluate(() =>
    document
      .querySelector('#bookmarks-tree [aria-label="Cross-root reference"]')
      .scrollIntoView({ block: 'nearest' }),
  );
  const crossStart = await point(crossRoot.result.id, 0.5);
  const rootTarget = await session.evaluate(() => {
    const rect = document
      .querySelector('[data-bookmark-root-id="unfiled_____"]')
      .getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await session.driver
    .actions()
    .move(crossStart)
    .press(Button.LEFT)
    .move({ ...crossStart, y: crossStart.y + 7, duration: 120 })
    .move({
      x: Math.round(offset.x + rootTarget.x),
      y: Math.round(offset.y + rootTarget.y),
      duration: 220,
    })
    .perform();
  await wait(
    () => document.querySelector('[data-bookmark-root-id="unfiled_____"].drop-inside'),
    'The Other location did not become a drop target',
  );
  await session.driver.actions().release(Button.LEFT).perform();
  await wait(
    () =>
      document
        .querySelector('[data-bookmark-root-id="unfiled_____"]')
        .getAttribute('aria-selected') === 'true',
    'The completed root drop did not reveal Other bookmarks',
  );
  assert.equal((await nativeIndex()).byId.get(crossRoot.result.id).parentId, 'unfiled_____');
  await wait(() => document.querySelector('#bookmarks-tree [aria-label="Cross-root reference"]'));
  assert.equal(
    await session.evaluate(() =>
      document
        .querySelector('#bookmarks-tree [aria-label="Cross-root reference"]')
        .getAttribute('aria-level'),
    ),
    '1',
  );
  await change('delete', crossRoot.result.id);
  await session.evaluate(() =>
    document.querySelector('[data-bookmark-root-id="toolbar_____"]').click(),
  );
  await wait(
    () =>
      document.querySelector('#bookmarks-tree [aria-label="Reference café"]') ||
      document.querySelector('#bookmarks-tree [aria-label="Edited café reference"]'),
  );
  console.log('✓ Native cross-root segment drop and destination reveal verified');

  // Edits from another window are seen here and cannot overwrite a stale draft.
  const draft = bookmarkRecord((await nativeIndex()).byId.get(bookmarks.first));
  const external = await session.evaluate(async (id) => {
    const win = await browser.windows.create({ url: 'about:blank', focused: false });
    const { bookmarkRecord, indexBookmarks } = await import(
      browser.runtime.getURL('src/bookmark-edit.js')
    );
    const index = indexBookmarks(await browser.bookmarks.getTree());
    const response = await browser.runtime.sendMessage({
      type: 'tabernacle:editBookmark',
      windowId: win.id,
      operationId: crypto.randomUUID(),
      command: {
        kind: 'update',
        id,
        expected: bookmarkRecord(index.byId.get(id)),
        title: 'Changed in another window',
        url: index.byId.get(id).url,
      },
    });
    await browser.windows.remove(win.id);
    return response;
  }, bookmarks.first);
  assert.equal(external.ok, true);
  await assert.rejects(
    send('editBookmark', {
      operationId: crypto.randomUUID(),
      command: {
        kind: 'update',
        id: bookmarks.first,
        expected: draft,
        title: 'Stale draft',
        url: draft.url,
      },
    }),
    /have changed/,
  );
  await session.evaluate(() => {
    const search = document.getElementById('bookmarks-search');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(() =>
    document.querySelector('#bookmarks-tree [aria-label="Changed in another window"]'),
  );

  // Only the confirmed subtree is removed; the moved bookmark keeps its identity.
  await session.evaluate((id) => {
    document
      .querySelector(`[data-bookmark-id="${id}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const remove = [...document.querySelectorAll('#menu [role="menuitem"]')].find(
      (node) => node.textContent === 'Delete folder',
    );
    if (!remove) throw new Error('Missing immediate empty-folder action');
    remove.click();
  }, newFolder.result.id);
  await session.driver.wait(
    async () => !(await nativeIndex()).byId.has(newFolder.result.id),
    10000,
  );
  assert.equal(await session.evaluate(() => document.getElementById('dialog').open), false);
  assert((await nativeIndex()).byId.has(newBookmark.result.id));
  await session.evaluate((id) => {
    document
      .querySelector(`[data-bookmark-id="${id}"]`)
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  }, bookmarks.nested);
  await wait(() => document.getElementById('dialog').open);
  assert.match(
    await session.evaluate(() => document.getElementById('dialog-description').textContent),
    /3 bookmarks, 0 folders/,
  );
  await session.evaluate(() => document.getElementById('dialog-cancel').click());
  assert((await nativeIndex()).byId.has(bookmarks.nested));
  await session.evaluate((id) => {
    document
      .querySelector(`[data-bookmark-id="${id}"]`)
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    document.getElementById('dialog-form').requestSubmit();
  }, bookmarks.nested);
  await wait(() => !document.getElementById('dialog').open);
  for (const id of [bookmarks.nested, bookmarks.first, bookmarks.second, newBookmark.result.id])
    assert(!(await nativeIndex()).byId.has(id));
  assert((await nativeIndex()).byId.has(bookmarks.folder));
  assert.deepEqual(await send('getBookmarkEdits'), []);
  console.log(
    '✓ Native bookmark dialogs, creation, retry after reload, same-parent ordering, pointer moves, multi-window conflicts, immediate empty-folder deletion and confirmed subtree deletion',
  );

  await session.evaluate(() => browser.permissions.remove({ permissions: ['bookmarks'] }));
  await wait(() =>
    document
      .querySelector('#bookmarks-view [role="status"]')
      .textContent.includes('Allow Tabernacle'),
  );
  assert.equal(await session.evaluate(() => document.querySelectorAll('.bookmark-row').length), 0);
  console.log(
    '✓ Native Firefox bookmarks, Unicode search, hierarchy/order, inherited containers, two windows, sidebar reload, idempotent retry and permission revocation',
  );
} catch (error) {
  console.log(
    'Native bookmark failure state:',
    await session
      .evaluate(() => ({
        status: document.querySelector('#bookmarks-view [role="status"]')?.textContent,
        hidden: document.getElementById('bookmarks-view')?.hidden,
        selectedRoot: document.querySelector('.bookmark-location[aria-selected="true"]')?.dataset
          .bookmarkRootId,
        dragPreview: document.querySelector('#bookmarks-view .move-preview')?.textContent,
        toast: document.getElementById('toast')?.textContent,
        rows: [...document.querySelectorAll('.bookmark-row')].map((node) => ({
          id: node.dataset.bookmarkId,
          title: node.textContent,
        })),
      }))
      .catch(() => null),
  );
  throw error;
} finally {
  await session.close();
  await new Promise((resolve) => server.close(resolve));
}
