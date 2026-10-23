import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createController } from '../extension/src/controller.js';
import { memoryBrowser } from '../preview/browser.js';
import { MODEL_KEY, groupContainer } from '../extension/src/model.js';
import {
  folderIcons,
  folderAppearance,
  matchingFolderIcons,
} from '../extension/src/folder-appearance.js';

test('every selectable icon is bundled, and task keywords and categories filter the catalogue', async () => {
  const sprite = await readFile(
    new URL('../extension/icons/ui/folder-icons.svg', import.meta.url),
    'utf8',
  );
  assert.equal(new Set(folderIcons.map(({ id }) => id)).size, folderIcons.length);
  for (const { id } of folderIcons) assert.ok(sprite.includes(`id="${id}-16"`), id);
  assert.ok(matchingFolderIcons('HOLIDAY').some(({ id }) => id === 'plane'));
  assert.ok(matchingFolderIcons('coding').some(({ id }) => id === 'keyboard'));
  assert.deepEqual(matchingFolderIcons('holiday', 'Technology'), []);
  assert.deepEqual(matchingFolderIcons('no-such-icon'), []);
});

test('icon and colour overrides are independent and invalid saved values fall back safely', () => {
  const container = { colorCode: '#37adff' };
  assert.deepEqual(folderAppearance({}, container), { icon: undefined, color: '#37adff' });
  assert.deepEqual(folderAppearance({ appearance: { icon: 'plane' } }, container), {
    icon: 'plane',
    color: '#37adff',
  });
  assert.deepEqual(folderAppearance({ appearance: { color: 'purple' } }, container), {
    icon: undefined,
    color: '#a16bd4',
  });
  assert.deepEqual(
    folderAppearance({ appearance: { icon: '../bad', color: 'url(bad)' } }, container),
    {
      icon: undefined,
      color: '#37adff',
    },
  );
});

test('colours cascade from the nearest custom ancestor independently of icons and containers', () => {
  const root = { id: 'root', parentId: null, appearance: { icon: 'plane', color: 'purple' } };
  const child = { id: 'child', parentId: 'root', appearance: { icon: 'book' } };
  const leaf = { id: 'leaf', parentId: 'child' };
  const state = { groups: [root, child, leaf] };
  const container = { colorCode: '#37adff' };
  assert.deepEqual(folderAppearance(child, container, state), { icon: 'book', color: '#a16bd4' });
  assert.deepEqual(folderAppearance(leaf, container, state), { icon: undefined, color: '#a16bd4' });

  child.appearance.color = 'teal';
  assert.equal(folderAppearance(leaf, container, state).color, '#249b87');
  // A draft clearing its own colour must not read the saved override back.
  assert.equal(
    folderAppearance({ ...child, appearance: { icon: 'book' } }, container, state).color,
    '#a16bd4',
  );
  child.appearance.color = 'invalid';
  assert.equal(folderAppearance(leaf, container, state).color, '#a16bd4');
  root.appearance = {};
  assert.equal(folderAppearance(leaf, container, state).color, '#37adff');
  assert.equal(folderAppearance(leaf, undefined, state).color, undefined);
  leaf.parentId = 'missing';
  assert.equal(folderAppearance(leaf, container, state).color, '#37adff');
});

test('ancestor colour edits, resets and moves update descendants without storing inherited colours', async () => {
  const api = memoryBrowser({
    groups: [
      { id: 'work', name: 'Work', parentId: null, appearance: { color: 'purple' } },
      { id: 'personal', name: 'Personal', parentId: null, appearance: { color: 'green' } },
      { id: 'child', name: 'Child', parentId: 'work', appearance: { icon: 'book' } },
      { id: 'leaf', name: 'Leaf', parentId: 'child' },
    ],
  });
  const controller = createController(api);
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  const colour = (state, id) =>
    folderAppearance(
      state.groups.find((group) => group.id === id),
      undefined,
      state,
    ).color;
  try {
    let state = await send('createGroup', { name: 'New', parentId: 'leaf' });
    const createdId = state.createdGroupId;
    assert.equal(colour(state, createdId), '#a16bd4');
    state = await send('setGroupAppearance', { id: 'child', appearance: { color: 'teal' } });
    assert.equal(colour(state, createdId), '#249b87');
    state = await send('setGroupAppearance', { id: 'work', appearance: { color: 'red' } });
    assert.equal(colour(state, createdId), '#249b87');
    state = await send('setGroupAppearance', { id: 'child', appearance: { icon: 'book' } });
    assert.equal(colour(state, createdId), '#e05252');
    state = await send('moveGroup', { id: 'child', parentId: 'personal' });
    assert.equal(colour(state, createdId), '#45994d');
    state = await send('moveGroup', { id: 'child', parentId: null });
    assert.equal(colour(state, createdId), undefined);
    const stored = (await api.storage.local.get(MODEL_KEY))[MODEL_KEY];
    assert.deepEqual(stored.groups.find((group) => group.id === 'child').appearance, {
      icon: 'book',
    });
    for (const id of ['leaf', createdId]) {
      assert.equal(stored.groups.find((group) => group.id === id).appearance, undefined);
    }
  } finally {
    controller.dispose();
  }
});

test('folder appearance persists, broadcasts to all windows, and resets to the current container', async () => {
  const notices = [];
  const api = memoryBrowser({
    groups: [
      { id: 'work', name: 'Work', parentId: null, defaultCookieStoreId: 'firefox-container-1' },
      { id: 'child', name: 'Child', parentId: 'work' },
    ],
    containers: [
      {
        cookieStoreId: 'firefox-container-1',
        name: 'Work',
        icon: 'briefcase',
        color: 'blue',
        colorCode: '#37adff',
      },
    ],
  });
  let controller = createController(api, (notice) => notices.push(notice));
  const send = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
  await send('setGroupAppearance', { id: 'work', appearance: { icon: 'plane', color: 'purple' } });
  assert.equal(notices.at(-1).windowId, undefined);
  const stored = (await api.storage.local.get(MODEL_KEY))[MODEL_KEY];
  assert.deepEqual(stored.groups[0].appearance, { icon: 'plane', color: 'purple' });
  controller.dispose();
  controller = createController(api);
  let state = await send('snapshot');
  assert.deepEqual(state.groups[0].appearance, { icon: 'plane', color: 'purple' });
  assert.equal(state.groups[1].appearance, undefined);
  assert.equal(groupContainer(state, 'child'), 'firefox-container-1');
  await send('updateContainer', {
    cookieStoreId: 'firefox-container-1',
    name: 'Team',
    icon: 'cart',
    color: 'green',
  });
  await send('setGroupAppearance', { id: 'work', appearance: {} });
  state = await send('snapshot');
  assert.equal(state.groups[0].appearance, undefined);
  assert.equal(state.groups[0].defaultCookieStoreId, 'firefox-container-1');
  assert.equal(state.containers[0].icon, 'cart');
  assert.equal(state.containers[0].color, 'green');
  assert.deepEqual(state.tabs, []);
  controller.dispose();
});

test('customisation creates no container and validates before any folder or container writes', async () => {
  const api = memoryBrowser();
  const controller = createController(api);
  const send = (type, args) => controller.request({ type, windowId: 1, ...args });
  const state = await send('createGroup', {
    name: 'Books',
    appearance: { icon: 'book', color: 'teal' },
  });
  assert.deepEqual(state.groups[0].appearance, { icon: 'book', color: 'teal' });
  assert.equal(state.groups[0].defaultCookieStoreId, undefined);
  assert.deepEqual(state.containers, []);
  for (const appearance of [{ icon: 'made-up' }, { color: '#123456' }, []]) {
    await assert.rejects(
      send('setGroupAppearance', { id: state.createdGroupId, appearance }),
      /Choose a folder/,
    );
    await assert.rejects(
      send('createGroup', {
        name: 'Invalid',
        appearance,
        newContainer: { name: 'Unused', color: 'blue', icon: 'briefcase' },
      }),
      /Choose a folder/,
    );
  }
  await assert.rejects(send('setGroupAppearance', { id: null, appearance: {} }), /Choose a folder/);
  await assert.rejects(
    send('setGroupAppearance', { id: 'missing', appearance: {} }),
    /no longer exists/,
  );
  assert.equal((await send('snapshot')).groups.length, 1);
  assert.deepEqual(await api.contextualIdentities.query({}), []);
  controller.dispose();
});

test('row masks preserve the canonical Acorn path geometry and fill rules', async () => {
  const sprite = await readFile(
    new URL('../extension/icons/ui/acorn.svg', import.meta.url),
    'utf8',
  );
  for (const name of ['close-12', 'globe-16']) {
    const standalone = await readFile(
      new URL(`../extension/icons/ui/${name}.svg`, import.meta.url),
      'utf8',
    );
    const symbol = sprite.match(
      new RegExp(`<symbol id="${name}" viewBox="([^"]+)">([\\s\\S]*?)</symbol>`),
    );
    assert(symbol, name);
    assert.equal(standalone.match(/viewBox="([^"]+)"/)[1], symbol[1]);
    const paths = (source) =>
      [...source.matchAll(/<path\s+([\s\S]*?)\/>/g)].map(([, attributes]) =>
        Object.fromEntries(
          [...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
        ),
      );
    assert.deepEqual(paths(standalone), paths(symbol[2]), name);
  }
});
