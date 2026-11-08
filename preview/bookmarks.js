import { memoryEvent } from './browser.js';

export const demoBookmarks = [
  {
    id: 'root________',
    type: 'folder',
    title: '',
    children: [
      {
        id: 'toolbar_____',
        type: 'folder',
        title: 'Bookmarks Toolbar',
        children: [
          {
            id: 'design-bookmarks',
            type: 'folder',
            title: 'Design references',
            children: [
              {
                id: 'mdn-bookmark',
                type: 'bookmark',
                title: 'MDN Web Docs',
                url: 'https://developer.mozilla.org/',
              },
              {
                id: 'fonts-bookmark',
                type: 'bookmark',
                title: 'Google Fonts',
                url: 'https://fonts.google.com/',
              },
            ],
          },
          {
            id: 'news-bookmark',
            type: 'bookmark',
            title: 'BBC News',
            url: 'https://www.bbc.co.uk/news',
          },
        ],
      },
      {
        id: 'menu________',
        type: 'folder',
        title: 'Bookmarks Menu',
        children: [
          {
            id: 'reading-bookmarks',
            type: 'folder',
            title: 'Reading',
            children: [
              {
                id: 'library-bookmark',
                type: 'bookmark',
                title: 'Open Library',
                url: 'https://openlibrary.org/',
              },
            ],
          },
        ],
      },
      { id: 'unfiled_____', type: 'folder', title: 'Other Bookmarks', children: [] },
    ],
  },
];

export function memoryBookmarks(initial = demoBookmarks) {
  const tree = structuredClone(initial);
  let granted = true;

  function reindex() {
    for (const parent of nodes())
      parent.children?.forEach((node, index) =>
        Object.assign(node, { parentId: parent.id, index }),
      );
  }

  const nodes = () => {
    const result = [];
    const stack = [...tree];
    while (stack.length) {
      const node = stack.pop();
      result.push(node);
      stack.push(...(node.children || []));
    }
    return result;
  };

  const requireAccess = () => {
    if (!granted) throw new Error('Bookmark permission is required.');
  };

  reindex();

  const permissions = {
    contains: async () => granted,

    request: async () => {
      granted = true;
      permissions.onAdded.emit({ permissions: ['bookmarks'] });
      return true;
    },

    remove: async () => {
      granted = false;
      permissions.onRemoved.emit({ permissions: ['bookmarks'] });
      return true;
    },

    onAdded: memoryEvent(),
    onRemoved: memoryEvent(),
  };
  const bookmarks = {
    async getTree() {
      requireAccess();
      return structuredClone(tree);
    },

    async get(id) {
      requireAccess();
      const node = nodes().find((node) => node.id === id);
      if (!node) throw new Error('Bookmark not found.');
      return [structuredClone(node)];
    },

    async update(id, changes) {
      requireAccess();
      const node = nodes().find((node) => node.id === id);
      if (!node) throw new Error('Bookmark not found.');
      Object.assign(node, changes);
      bookmarks.onChanged.emit(id, structuredClone(changes));
      return structuredClone(node);
    },

    async create(details) {
      requireAccess();
      const parent = nodes().find((node) => node.id === details.parentId);
      if (!parent?.children || parent === tree[0]) throw new Error('Invalid parent.');
      const node = {
        id: crypto.randomUUID(),
        type: details.url ? 'bookmark' : 'folder',
        ...details,
      };
      if (node.type === 'folder') node.children = [];
      parent.children.splice(details.index ?? parent.children.length, 0, node);
      reindex();
      bookmarks.onCreated.emit(node.id, structuredClone(node));
      return structuredClone(node);
    },

    async move(id, { parentId, index }) {
      requireAccess();
      const node = nodes().find((node) => node.id === id);
      const oldParent = nodes().find((entry) => entry.id === node?.parentId);
      const parent = nodes().find((entry) => entry.id === (parentId ?? node?.parentId));
      if (!oldParent || oldParent === tree[0] || !parent?.children || parent === tree[0])
        throw new Error('Invalid move.');
      for (
        let ancestor = parent;
        ancestor;
        ancestor = nodes().find((entry) => entry.id === ancestor.parentId)
      )
        if (ancestor.id === id) throw new Error('Cannot move a folder inside itself.');
      const oldIndex = node.index;
      oldParent.children.splice(oldIndex, 1);
      parent.children.splice(index ?? parent.children.length, 0, node);
      reindex();
      bookmarks.onMoved.emit(id, {
        parentId: parent.id,
        index: node.index,
        oldParentId: oldParent.id,
        oldIndex,
      });
      return structuredClone(node);
    },

    async remove(id) {
      requireAccess();
      const node = nodes().find((node) => node.id === id);
      const parent = nodes().find((entry) => entry.id === node?.parentId);
      if (!parent || parent === tree[0] || node.children?.length)
        throw new Error('Cannot remove this bookmark.');
      parent.children.splice(node.index, 1);
      reindex();
      bookmarks.onRemoved.emit(id, {
        parentId: parent.id,
        index: node.index,
        node: structuredClone(node),
      });
    },

    onCreated: memoryEvent(),
    onRemoved: memoryEvent(),
    onChanged: memoryEvent(),
    onMoved: memoryEvent(),
    onChildrenReordered: memoryEvent(),
    onImportEnded: memoryEvent(),
  };
  return { permissions, bookmarks };
}
