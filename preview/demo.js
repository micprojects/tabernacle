import { createController } from '../extension/src/controller.js';
import { VIEW_KEY } from '../extension/src/model.js';
import { memoryBrowser } from './browser.js';

export async function createDemo(notify) {
  const groups = [
    { id: 'work', name: 'Work', parentId: null },
    { id: 'design', name: 'Design', parentId: 'work' },
    { id: 'research', name: 'Research', parentId: 'work' },
    { id: 'personal', name: 'Personal', parentId: null },
    { id: 'later', name: 'Later', parentId: null },
  ];
  const entries = [
    ['Figma — Website', 'design', 'https://figma.com/design/tabernacle'],
    ['Typography reference', 'design', 'https://fonts.google.com'],
    ['Brand guidelines', 'design', 'https://notion.so/brand'],
    ['Launch checklist', 'design', 'https://docs.google.com'],
    ['Sidebar patterns', 'research', 'https://developer.mozilla.org'],
    ['Group navigation', 'research', 'https://support.apple.com'],
    ['Browser extensions', 'research', 'https://developer.mozilla.org'],
    ['Roadmap', 'work', 'https://linear.app'],
    ['Sprint notes', 'work', 'https://notion.so'],
    ['Weekend in Copenhagen', 'personal', 'https://visitcopenhagen.com'],
    ['A few good recipes', 'personal', 'https://bbcgoodfood.com'],
    ['Reading list', 'personal', 'https://openlibrary.org'],
    ['The creative act', 'later', 'https://openlibrary.org'],
    ['Small spaces', 'later', 'https://are.na'],
    ['Photography notes', 'later', 'https://notion.so'],
    ['A quieter internet', 'later', 'https://example.com'],
    ['Objects of interest', 'later', 'https://are.na'],
  ];
  const memberships = {};
  const parents = { 2: [1], 3: [1], 4: [3, 1], 6: [5], 7: [5] };
  const tabs = entries.map(([title, groupId, url], index) => {
    memberships[index + 1] = {
      groupId,
      treeId: `demo-tab-${index + 1}`,
      ancestors: (parents[index + 1] ?? []).map((id) => `demo-tab-${id}`),
    };
    return {
      id: index + 1,
      index,
      windowId: 1,
      title,
      url,
      active: index === 0,
      pinned: [10, 11, 12, 13].includes(index + 1),
      groupId: -1,
    };
  });
  const containers = [
    { cookieStoreId: 'firefox-container-1', name: 'Personal', colorCode: '#00a7e0' },
    { cookieStoreId: 'firefox-container-2', name: 'Work', colorCode: '#f89c24' },
    { cookieStoreId: 'firefox-container-3', name: 'Banking', colorCode: '#00a465' },
    { cookieStoreId: 'firefox-container-4', name: 'Shopping', colorCode: '#d65780' },
  ];
  const api = memoryBrowser({ groups, tabs, memberships, containers });
  await api.sessions.setWindowValue(1, VIEW_KEY, {
    scopeId: null,
    collapsed: ['research', 'personal', 'later'],
  });
  const controller = createController(api, notify);
  api.testing.setCreatedHandler((tab) => {
    controller.created(tab).catch(() => {});
  });
  return controller;
}
