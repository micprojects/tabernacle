import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Key } from 'selenium-webdriver';
import sharp from 'sharp';
import { ScreenshotBrowser } from '../../scripts/screenshot-browser.js';

const browser = new ScreenshotBrowser();
const server = createServer((request, response) => {
  if (request.url === '/icon.svg') {
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="red"/><path d="M12 8 24 16 12 24Z" fill="white"/></svg>',
    );
  } else if (request.url === '/reader-article') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><html lang="en"><title>A quiet walk through the garden</title>' +
        '<link rel="icon" href="/icon.svg"><article><h1>A quiet walk through the garden</h1>' +
        Array.from(
          { length: 18 },
          (_, index) =>
            `<p>Section ${index}. The garden paths were quiet in the early morning. We followed ` +
            'the old stone wall towards the trees, where sunlight reached the leaves and birds ' +
            'moved between the branches. The walk gave us time to consider the changing ' +
            'seasons, the work of planting and tending each bed, and the patient care that ' +
            'helps a place grow. This local article exercises the browser reader view.</p>',
        ).join('') +
        '</article></html>',
    );
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const topic = request.url.includes('?second') ? 'Restoring' : 'Building';
    response.end(
      `<!doctype html><title>${topic} a small oak writing desk from start to finish — choosing timber, cutting traditional joints, assembling the frame and applying a durable hand-rubbed finish | Maker Workshop</title><link rel="icon" href="/icon.svg"><p>Local domain test</p>`,
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const size = { width: 320, height: 620 };
try {
  await mkdir('test-results', { recursive: true });
  await browser.open(
    {
      window: { width: 1100, height: 850 },
      sidebarWidth: size.width,
      capture: { sourceSize: size },
    },
    'test-results/firefox-domain-filter.log',
  );
  const fixture = await browser.evaluate(async (port) => {
    const { id: windowId } = await browser.windows.getCurrent();
    window.domainSend = async (type, args = {}) => {
      const response = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!response.ok) throw new Error(response.error);
      return response.data;
    };
    const url = `http://127.0.0.1:${port}/preview/index.html`;
    const otherUrl = `http://localhost:${port}/preview/index.html`;
    const groupA = (await domainSend('createGroup', { name: 'First folder' })).createdGroupId;
    const groupB = (await domainSend('createGroup', { name: 'Second folder' })).createdGroupId;
    const parent = await browser.tabs.create({ windowId, url, active: false });
    await domainSend('moveTab', { id: parent.id, groupId: groupA });
    const child = await browser.tabs.create({ windowId, url: otherUrl, active: false });
    await domainSend('nestTab', { id: child.id, parentTabId: parent.id });
    const grandchild = await browser.tabs.create({ windowId, url: `${url}?second`, active: false });
    await domainSend('nestTab', { id: grandchild.id, parentTabId: child.id });
    const elsewhere = await browser.tabs.create({ windowId, url, active: false });
    await domainSend('moveTab', { id: elsewhere.id, groupId: groupB });
    const pinned = await browser.tabs.create({ windowId, url, pinned: true, active: false });
    await domainSend('toggleTab', { id: parent.id });
    await domainSend('toggleTab', { id: child.id });
    await domainSend('enterGroup', { id: groupA });
    const otherWindow = await browser.windows.create({ url });
    await browser.windows.update(windowId, { focused: true });
    return {
      parent: parent.id,
      child: child.id,
      grandchild: grandchild.id,
      elsewhere: elsewhere.id,
      pinned: pinned.id,
      groupA,
      groupB,
      otherWindow: otherWindow.id,
      otherUrl,
      url,
    };
  }, server.address().port);

  const wait = async (fn, ...args) => {
    try {
      await browser.driver.wait(
        () => browser.evaluate(fn, ...args),
        10000,
        `${fn.toString()} (${args.join(', ')})`,
      );
    } catch (error) {
      console.error(
        await browser.evaluate(async () => ({
          domain: document.getElementById('domain-name').textContent,
          filterHidden: document.getElementById('domain-header').hidden,
          rows: [...document.querySelectorAll('#tree .tab-row')].map((row) => [
            row.dataset.id,
            row.getAttribute('aria-selected'),
          ]),
          tabs: (await browser.tabs.query({ currentWindow: true })).map((tab) => ({
            id: tab.id,
            active: tab.active,
            pinned: tab.pinned,
            url: tab.url,
          })),
          error: document.getElementById('toast').textContent,
        })),
      );
      throw error;
    }
  };

  const read = () => browser.evaluate(() => domainSend('snapshot'));
  await wait(async (id) => Boolean((await browser.tabs.get(id)).favIconUrl), fixture.parent);
  await wait(
    (id) =>
      document.querySelector(`[data-key="tab:${id}"]`)?.getAttribute('aria-expanded') === 'false',
    fixture.parent,
  );
  await browser.evaluate((id) => {
    document
      .querySelector(`[data-key="tab:${id}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 120 }));
    [...document.querySelectorAll('#menu button')]
      .find((button) => button.textContent === 'Filter by domain')
      .click();
  }, fixture.parent);
  await wait(() => document.querySelectorAll('#tree > .tab-row').length === 4);
  let ids = await browser.evaluate(() =>
    [...document.querySelectorAll('#tree .tab-row')].map((row) => Number(row.dataset.id)),
  );
  assert.deepEqual(ids, [fixture.pinned, fixture.elsewhere, fixture.grandchild, fixture.parent]);
  assert.equal(
    await browser.evaluate(() => document.getElementById('domain-sort').value),
    'newest',
  );
  await wait(() => document.getElementById('domain-name').textContent === 'Maker Workshop');
  assert.equal(
    await browser.evaluate(() => document.getElementById('domain-address').textContent),
    '127.0.0.1',
  );
  assert.equal(
    await browser.evaluate(() => document.getElementById('domain-address').hidden),
    false,
  );
  await wait(() => {
    const image = document.querySelector('#domain-icon img');
    return image?.complete && image.naturalWidth > 0;
  });
  await wait(() =>
    [...document.querySelectorAll('#tree .tab-row .label')].every((label) => {
      return (
        getComputedStyle(label).whiteSpace === 'nowrap' &&
        label.closest('.tab-row').getBoundingClientRect().height === 30 &&
        label.scrollWidth > label.clientWidth
      );
    }),
  );
  const capture = await browser.screenshot({ sourceSize: size, scale: 2 });
  await writeFile('test-results/domain-header-firefox.png', capture);
  const { data } = await sharp(capture)
    .extract({ left: 4, top: 4, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert(
    data[0] > data[1] + 5 && Math.abs(data[1] - data[2]) < 3,
    'Native remote favicon produces a red wash',
  );
  assert.equal(
    await browser.evaluate(() => document.getElementById('navigation-capsule').hidden),
    true,
  );
  assert.equal(await browser.evaluate(() => document.getElementById('search-wrap').inert), true);
  assert.equal(await browser.evaluate(() => document.activeElement.id), 'domain-close');
  await browser.evaluate(
    (id) => document.querySelector(`#tree [data-key="tab:${id}"]`).click(),
    fixture.grandchild,
  );
  await wait(
    (id) =>
      document.querySelector(`#tree [data-key="tab:${id}"]`)?.getAttribute('aria-selected') ===
      'true',
    fixture.grandchild,
  );
  let state = await read();
  assert(state.tabs.filter((tab) => tab.url === fixture.url).every((tab) => tab.openedAt > 0));
  await browser.evaluate(() => {
    const sort = document.getElementById('domain-sort');
    sort.value = 'viewed';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(
    (id) => Number(document.querySelector('#tree .tab-row')?.dataset.id) === id,
    fixture.grandchild,
  );
  await browser.evaluate(() => {
    const sort = document.getElementById('domain-sort');
    sort.value = 'newest';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  for (const id of [fixture.parent, fixture.child])
    assert.equal(state.tabs.find((tab) => tab.id === id).collapsed, true);
  assert.equal(state.view.scopeId, fixture.groupA);
  await browser.evaluate(
    (id) => document.querySelector(`#tree [data-key="tab:${id}"] .close-tab`).click(),
    fixture.parent,
  );
  await wait((id) => !document.querySelector(`#tree [data-key="tab:${id}"]`), fixture.parent);
  state = await read();
  assert(state.tabs.some((tab) => tab.id === fixture.child));
  assert(state.tabs.some((tab) => tab.id === fixture.grandchild));
  assert.equal(await browser.evaluate(() => document.getElementById('dialog').open), false);
  assert.equal(
    await browser.evaluate(() => document.getElementById('domain-header').hidden),
    false,
  );

  await browser.evaluate(
    (id, url) => browser.tabs.update(id, { url }),
    fixture.elsewhere,
    fixture.otherUrl,
  );
  await wait((id) => !document.querySelector(`#tree [data-key="tab:${id}"]`), fixture.elsewhere);
  await browser.evaluate(
    (id, url) => browser.tabs.update(id, { url }),
    fixture.elsewhere,
    fixture.url,
  );
  await wait(
    (id) => Boolean(document.querySelector(`#tree [data-key="tab:${id}"]`)),
    fixture.elsewhere,
  );
  await browser.evaluate(() => document.getElementById('domain-close').click());
  await wait(
    () =>
      document.getElementById('domain-header').hidden &&
      !document.getElementById('breadcrumbs').inert,
  );
  state = await read();
  assert.equal(state.view.scopeId, fixture.groupA);
  assert.equal(state.tabs.find((tab) => tab.id === fixture.child).collapsed, true);
  await browser.evaluate((id) => {
    document
      .querySelector(`[data-key="tab:${id}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 120 }));
    [...document.querySelectorAll('#menu button')]
      .find((button) => button.textContent === 'Filter by domain')
      .click();
  }, fixture.pinned);
  await wait(() => !document.getElementById('domain-header').hidden);
  ids = await browser.evaluate(() =>
    [...document.querySelectorAll('#tree .tab-row')].map((row) => Number(row.dataset.id)),
  );
  assert.deepEqual(ids, [fixture.pinned, fixture.elsewhere, fixture.grandchild]);
  await browser.evaluate(
    async (closing, outside) => {
      document.querySelector(`#tree [data-key="tab:${closing}"]`).click();
      await browser.tabs.update(closing, { successorTabId: outside });
    },
    fixture.grandchild,
    fixture.child,
  );
  await wait(
    (id) =>
      document.querySelector(`#tree [data-key="tab:${id}"]`)?.getAttribute('aria-selected') ===
      'true',
    fixture.grandchild,
  );
  await browser.evaluate(
    (id) => document.querySelector(`#tree [data-key="tab:${id}"] .close-tab`).click(),
    fixture.grandchild,
  );
  await wait(
    (id) =>
      document.querySelector(`#tree [data-key="tab:${id}"]`)?.getAttribute('aria-selected') ===
      'true',
    fixture.elsewhere,
  );
  state = await read();
  assert.equal(state.view.scopeId, fixture.groupA);
  assert.equal(state.tabs.find((tab) => tab.id === fixture.child).collapsed, true);

  // Use an unpinned tab: Firefox's close shortcut leaves pinned tabs open.
  // The browser shortcut must use the same live filter as a sidebar close.
  await browser.evaluate(
    async (closing, outside) => {
      document.querySelector(`#tree [data-key="tab:${closing}"]`).click();
      await browser.tabs.update(closing, { successorTabId: outside });
    },
    fixture.elsewhere,
    fixture.child,
  );
  await wait(
    (id) =>
      document.querySelector(`#tree [data-key="tab:${id}"]`)?.getAttribute('aria-selected') ===
      'true',
    fixture.elsewhere,
  );
  const modifier = process.platform === 'darwin' ? Key.META : Key.CONTROL;
  await browser.chrome(() => gBrowser.selectedBrowser.focus());
  await browser.driver.actions().keyDown(modifier).sendKeys('w').keyUp(modifier).perform();
  await wait(
    (id) =>
      document.querySelector(`#tree [data-key="tab:${id}"]`)?.getAttribute('aria-selected') ===
      'true',
    fixture.pinned,
  );
  assert.equal((await read()).tabs.find((tab) => tab.active).id, fixture.pinned);
  await browser.evaluate(
    (closing, outside) => browser.tabs.update(closing, { successorTabId: outside }),
    fixture.pinned,
    fixture.child,
  );
  await browser.evaluate(
    (id) => document.querySelector(`#tree [data-key="tab:${id}"] .close-tab`).click(),
    fixture.pinned,
  );
  await wait(() => document.querySelectorAll('#tree .tab-row').length === 0);
  assert.equal((await read()).tabs.find((tab) => tab.active).id, fixture.child);
  assert.equal(
    await browser.evaluate(() => document.getElementById('domain-header').hidden),
    false,
  );
  assert.equal(
    await browser.evaluate(() => document.getElementById('toast').classList.contains('error')),
    false,
  );
  console.log(
    '✓ Native Firefox: creation/viewed sorting, current-window filtering, safe closing, live navigation, and sorted selection for sidebar and shortcut closes',
  );

  // Native Reader View changes isInReaderMode without a dedicated changeInfo
  // property. Keep complete native data, relationships and domain visibility.
  const reader = await browser.evaluate(
    async (port, predecessor, groupId) => {
      const { id: windowId } = await browser.windows.getCurrent();
      const originalActive = (await browser.tabs.query({ windowId, active: true }))[0].id;
      const url = `http://127.0.0.1:${port}/reader-article`;
      const tab = await browser.tabs.create({ windowId, url, active: true });
      await domainSend('moveTab', { id: tab.id, groupId });
      const child = await browser.tabs.create({
        windowId,
        url: 'about:blank',
        active: false,
        openerTabId: tab.id,
      });
      await browser.tabs.update(predecessor, { successorTabId: tab.id });
      return { id: tab.id, child: child.id, predecessor, originalActive, url };
    },
    server.address().port,
    fixture.child,
    fixture.groupB,
  );
  await wait(async (id) => {
    const tab = await browser.tabs.get(id);
    return tab.status === 'complete' && tab.isArticle;
  }, reader.id);
  // Creation can precede the child's final dimensions. Start the Reader checks
  // after a real structural event has refreshed the complete native window.
  await wait(async (id) => (await browser.tabs.get(id)).status === 'complete', reader.child);
  await browser.evaluate((id) => browser.tabs.move(id, { index: 1 }), reader.child);

  const inspectReader = async (inReader) => {
    let observed;
    await browser.driver
      .wait(
        async () => {
          observed = await browser.evaluate(
            async (ids, inReader) => {
              const { id: windowId } = await browser.windows.getCurrent();
              const before = await browser.tabs.query({ windowId });
              const snapshot = await domainSend('snapshot');
              const native = await browser.tabs.query({ windowId });
              const stableFields = (tab) =>
                Object.fromEntries(Object.entries(tab).filter(([key]) => key !== 'lastAccessed'));
              const stable =
                JSON.stringify(before.map(stableFields)) ===
                JSON.stringify(native.map(stableFields));
              const mismatches = [];
              for (const tab of native) {
                const row = snapshot.tabs.find((item) => item.id === tab.id);
                if (!row) {
                  mismatches.push({ id: tab.id, key: 'missing-row' });
                  continue;
                }
                for (const key of Object.keys(tab)) {
                  if (key === 'lastAccessed') continue;
                  const field = key === 'groupId' ? 'nativeGroupId' : key;
                  if (JSON.stringify(tab[key]) !== JSON.stringify(row[field]))
                    mismatches.push({ id: tab.id, key, native: tab[key], snapshot: row[field] });
                }
                for (const key of ['favIconUrl', 'openerTabId'])
                  if (!Object.hasOwn(tab, key) && Object.hasOwn(row, key))
                    mismatches.push({ id: tab.id, key, stale: true });
              }
              const tab = native.find((item) => item.id === ids.id);
              const expectedUrl = inReader
                ? `about:reader?url=${encodeURIComponent(ids.url)}`
                : ids.url;
              return {
                native,
                snapshot,
                mismatches,
                stable,
                expectedUrl,
                ready:
                  stable &&
                  !mismatches.length &&
                  tab?.status === 'complete' &&
                  tab.url === expectedUrl &&
                  tab.isInReaderMode === inReader,
              };
            },
            reader,
            inReader,
          );
          return observed.ready;
        },
        10000,
        'Complete native Reader View records must reach the sidebar',
      )
      .catch((error) => {
        const fields = ({ id, url, isInReaderMode, status, successorTabId }) => ({
          id,
          url,
          isInReaderMode,
          status,
          successorTabId,
        });
        console.error({
          inReader,
          ready: observed?.ready,
          stable: observed?.stable,
          expectedUrl: observed?.expectedUrl,
          mismatches: observed?.mismatches,
          native: observed?.native.map(fields),
          snapshot: observed?.snapshot.tabs.map(fields),
        });
        throw error;
      });
    const tab = observed.native.find((item) => item.id === reader.id);
    await wait(
      (id, title) => {
        const row = document.querySelector(`#tree [data-key="tab:${id}"]`);
        return (
          row?.getAttribute('aria-selected') === 'true' &&
          row.querySelector('.label')?.textContent === title
        );
      },
      reader.id,
      tab.title,
    );
    assert.equal(observed.native.find((item) => item.id === reader.child).openerTabId, reader.id);
    assert.equal(
      observed.native.find((item) => item.id === reader.predecessor).successorTabId,
      reader.id,
    );
    return observed.snapshot;
  };

  const organisation = (snapshot) => ({
    groups: snapshot.groups,
    tabs: snapshot.tabs.map(
      ({ id, groupId, order, treeId, ancestors, collapsed, parentTabId }) => ({
        id,
        groupId,
        order,
        treeId,
        ancestors,
        collapsed,
        parentTabId,
      }),
    ),
  });
  const beforeReader = organisation(await inspectReader(false));
  for (const inReader of [true, false, true, false]) {
    await browser.evaluate((id) => browser.tabs.toggleReaderMode(id), reader.id);
    assert.deepEqual(organisation(await inspectReader(inReader)), beforeReader);
  }
  await browser.evaluate(async (ids) => {
    await browser.tabs.update(ids.originalActive, { active: true });
    await browser.tabs.remove([ids.child, ids.id]);
  }, reader);
  console.log(
    '✓ Native Reader View preserves complete tab records, native links, organisation and domain-filter rows',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
