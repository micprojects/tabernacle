import assert from 'node:assert/strict';
import test from 'node:test';
import { upgradeOrganisation } from './helpers/upgrade-state.js';

const fixture = () => [
  {
    groups: [{ id: 'work', name: 'Work', parentId: null }],
    folderPins: [{ id: 'work', action: 'open' }],
    look: { colorScheme: 'dark' },
    view: { scopeId: 'work', collapsed: [] },
    pins: [{ kind: 'group', id: 'work' }],
    tabs: [
      { id: 1, treeId: 'parent', index: 0, windowId: 1, groupId: 'work', ancestors: [] },
      {
        id: 2,
        treeId: 'child',
        index: 1,
        windowId: 1,
        groupId: 'work',
        ancestors: ['parent'],
        parentTabId: 1,
      },
    ],
  },
];

test('upgrade comparisons ignore transient metadata but retain organisation and native identities', () => {
  const before = fixture();
  const keys = ['parent', 'child'];
  const expected = upgradeOrganisation(before, keys);
  const transient = structuredClone(before);
  transient[0].tabs[0].title = 'New title';
  transient[0].tabs[0].lastAccessed = Date.now();
  transient[0].tabs.push({ id: 99, treeId: 'test-driver', index: 2 });
  assert.deepEqual(upgradeOrganisation(transient, keys), expected);
  for (const field of ['id', 'windowId', 'treeId', 'groupId', 'order', 'cookieStoreId', 'pinned']) {
    const changed = structuredClone(before);
    changed[0].tabs[1][field] = 'changed';
    assert.notDeepEqual(upgradeOrganisation(changed, keys), expected, field);
  }
  const moved = structuredClone(before);
  moved[0].tabs[1].ancestors = [];
  moved[0].tabs[1].parentTabId = null;
  assert.notDeepEqual(upgradeOrganisation(moved, keys), expected);
  const reordered = structuredClone(before);
  reordered[0].tabs[0].index = 2;
  assert.notDeepEqual(upgradeOrganisation(reordered, keys), expected);
});

test('upgrade comparisons retain folder properties, settings, window views and mixed pin order', () => {
  const before = fixture();
  const keys = ['parent', 'child'];
  const expected = upgradeOrganisation(before, keys);
  for (const change of [
    (state) => (state.groups[0].parentId = 'other'),
    (state) => (state.groups[0].defaultCookieStoreId = 'container'),
    (state) => (state.look.colorScheme = 'light'),
    (state) => state.view.collapsed.push('work'),
    (state) => (state.folderPins[0].action = 'reveal'),
    (state) => state.pins.unshift({ kind: 'tab', id: 'parent' }),
  ]) {
    const changed = structuredClone(before);
    change(changed[0]);
    assert.notDeepEqual(upgradeOrganisation(changed, keys), expected);
  }
});
