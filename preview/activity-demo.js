import { memoryBrowser } from './browser.js';
import { createController } from '../extension/src/controller.js';
import { VIEW_KEY } from '../extension/src/model.js';

// Sample activity uses the real controller, but only this in-memory browser,
// never personal history.
export async function createActivityDemo(notify) {
  const now = Date.now();
  const ago = (minutes) => now - minutes * 60000;
  const groups = [
    { id: 'work', name: 'Work', parentId: null },
    { id: 'website', name: 'Website refresh', parentId: 'work' },
    { id: 'research', name: 'CSS reference', parentId: 'website' },
    { id: 'personal', name: 'Personal', parentId: null },
    { id: 'copenhagen', name: 'Copenhagen weekend', parentId: 'personal' },
    { id: 'reading', name: 'Reading list', parentId: 'personal' },
  ];
  const entries = [
    [
      'CSS grid layout — MDN',
      'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout',
      'research',
      3,
    ],
    ['Acorn — Firefox design system', 'https://acorn.firefox.com', 'website', 12],
    ['Tabernacle · Issues', 'https://github.com/micprojects/tabernacle/issues', 'work', 28],
    ['A guide to Copenhagen', 'https://visitcopenhagen.com', 'copenhagen', 46],
    [
      'The Creative Act: A Way of Being',
      'https://openlibrary.org/books/creative-act',
      'reading',
      90,
    ],
    [
      'Accessible colour and contrast',
      'https://developer.mozilla.org/en-US/docs/Web/Accessibility',
      'research',
      160,
    ],
    ['The Louisiana Museum of Modern Art', 'https://louisiana.dk/en/', 'copenhagen', 1500],
    ['A few good recipes', 'https://bbcgoodfood.com/recipes', 'personal', 1600],
    [
      'A complete guide to Flexbox',
      'https://css-tricks.com/snippets/css/a-guide-to-flexbox/',
      'research',
      7,
    ],
    ['Restaurant Barr', 'https://restaurantbarr.com', 'copenhagen', 34],
    ['Nyhavn — Wikipedia', 'https://en.wikipedia.org/wiki/Nyhavn', 'copenhagen', 70],
    ['The Copenhagen Metro', 'https://m.dk/en/', 'copenhagen', 1520],
    [
      'Understanding WCAG contrast',
      'https://webaim.org/resources/contrastchecker/',
      'research',
      1720,
    ],
  ];
  const memberships = Object.fromEntries(entries.map(([, , groupId], i) => [i + 1, { groupId }]));
  const tabs = entries.map(([title, url, , minutes], i) => ({
    id: i + 1,
    index: i,
    windowId: 1,
    title,
    url,
    groupId: -1,
    active: i === 0,
    lastAccessed: ago(minutes),
  }));
  const api = memoryBrowser({ groups, tabs, memberships, events: true });
  await api.sessions.setWindowValue(1, VIEW_KEY, {
    scopeId: null,
    collapsed: ['reading'],
    recentFolders: [
      { id: 'website', enteredAt: ago(5) },
      { id: 'copenhagen', enteredAt: ago(40) },
      { id: 'reading', enteredAt: ago(1490) },
    ],
    recentExpandedFolders: [
      { id: 'research', expandedAt: ago(9) },
      { id: 'work', expandedAt: ago(24) },
      { id: 'copenhagen', expandedAt: ago(1500) },
    ],
  });
  for (const id of [9, 10, 11, 12, 13]) await api.tabs.remove(id);
  const history = api.sessions.getRecentlyClosed;
  api.sessions.getRecentlyClosed = async () =>
    (await history()).map((entry) => ({
      ...entry,
      lastModified: ago(entries[entry.tab.id - 1][3]),
    }));
  const controller = createController(api, notify);
  api.testing.setCreatedHandler((tab) => controller.created(tab).catch(() => {}));
  return controller;
}
