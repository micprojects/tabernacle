import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/src/controller.js';
import { BOOKMARK_EDITS_KEY } from '../extension/src/controller/bookmark-editor.js';
import {
  indexBookmarks,
  bookmarkRecord,
  bookmarkSubtree,
  bookmarkMove,
} from '../extension/src/bookmark-edit.js';
import { memoryBrowser } from '../preview/browser.js';
import { MODEL_KEY } from '../extension/src/model.js';

function fixture() {
  const api = memoryBrowser({
    tabs: [
      { id: 1, windowId: 1, active: true, url: 'about:blank' },
      { id: 2, windowId: 2, url: 'about:blank' },
    ],
  });
  let controller = createController(api);
  return {
    api,
    send: (type, args = {}, windowId = 1) => controller.request({ type, windowId, ...args }),
    index: async () => indexBookmarks(await api.bookmarks.getTree()),

    async restart() {
      await controller.dispose();
      controller = createController(api);
    },
  };
}

async function operation(f, kind, id = 'mdn-bookmark', extra = {}) {
  const index = await f.index();
  return {
    operationId: crypto.randomUUID(),
    command:
      kind === 'create'
        ? {
            kind,
            parentId: 'design-bookmarks',
            type: 'bookmark',
            title: 'New reference',
            url: 'https://example.test',
            ...extra,
          }
        : {
            kind,
            id,
            expected: bookmarkRecord(index.byId.get(id)),
            ...(kind === 'delete' ? { contents: bookmarkSubtree(index, id) } : {}),
            ...extra,
          },
  };
}

test('bookmark create, rename, address edit, move and delete preserve native identities and tab data', async () => {
  const f = fixture();
  const before = await f.send('snapshot');
  const saved = structuredClone(f.api.testing.saved[MODEL_KEY]);
  const folder = await f.send(
    'editBookmark',
    await operation(f, 'create', null, { type: 'folder', title: 'Research' }),
  );
  const created = await f.send(
    'editBookmark',
    await operation(f, 'create', null, { parentId: folder.id }),
  );
  let node = (await f.index()).byId.get(created.id);
  assert.equal(node.url, 'https://example.test/');
  await f.send(
    'editBookmark',
    await operation(f, 'update', created.id, { title: 'Edited', url: 'https://edited.test/path' }),
  );
  await f.send(
    'editBookmark',
    await operation(f, 'move', created.id, { targetId: 'news-bookmark', position: 'before' }),
  );
  node = (await f.index()).byId.get(created.id);
  assert.equal(node.title, 'Edited');
  assert.equal(node.url, 'https://edited.test/path');
  assert.equal(node.parentId, 'toolbar_____');
  assert.equal(node.index, 1);
  await f.send('editBookmark', await operation(f, 'delete', folder.id));
  assert((await f.index()).byId.has(created.id));
  assert.deepEqual((await f.send('snapshot')).tabs, before.tabs);
  assert.deepEqual(f.api.testing.saved[MODEL_KEY], saved);
});

for (const kind of ['create', 'update', 'move', 'delete']) {
  const boundaries =
    kind === 'create'
      ? ['pending', 'create', 'identity', 'update', 'complete']
      : ['pending', kind === 'delete' ? 'remove' : kind, 'complete'];
  for (const boundary of boundaries)
    for (const lostReply of [false, true]) {
      test(`${kind}: retries after ${boundary} ${lostReply ? 'lost reply' : 'failure'} and controller restart`, async () => {
        const f = fixture();
        await f.send('snapshot');
        const op = await operation(
          f,
          kind,
          kind === 'delete' ? 'design-bookmarks' : 'mdn-bookmark',
          kind === 'update'
            ? { title: 'Changed', url: 'https://changed.test/' }
            : kind === 'move'
              ? { targetId: 'reading-bookmarks', position: 'inside' }
              : {},
        );
        const storage = ['pending', 'identity', 'complete'].includes(boundary);
        const owner = storage ? f.api.storage.local : f.api.bookmarks;
        const method = storage ? 'set' : boundary;
        const original = owner[method];
        let failed = false;
        owner[method] = async (...args) => {
          const record = args[0]?.[BOOKMARK_EDITS_KEY]?.records.find(
            (entry) => entry.operationId === op.operationId,
          );
          const matches =
            !storage ||
            (record &&
              (boundary === 'complete'
                ? record.phase === 'complete'
                : record.phase === 'pending' &&
                  Boolean(record.createdId) === (boundary === 'identity')));
          if (!failed && matches) {
            failed = true;
            if (lostReply) await original(...args);
            throw new Error('Interrupted change');
          }
          return original(...args);
        };
        await assert.rejects(f.send('editBookmark', op), /Interrupted change/);
        assert(failed);
        owner[method] = original;
        await f.restart();
        const result = await f.send('editBookmark', op);
        assert.deepEqual(await f.send('editBookmark', op, 2), result);
        const index = await f.index();
        if (kind === 'create')
          assert.equal(
            [...index.byId.values()].filter((node) => node.title === 'New reference').length,
            1,
          );
        if (kind === 'update') assert.equal(index.byId.get('mdn-bookmark').title, 'Changed');
        if (kind === 'move')
          assert.equal(index.byId.get('mdn-bookmark').parentId, 'reading-bookmarks');
        if (kind === 'delete')
          for (const id of ['design-bookmarks', 'mdn-bookmark', 'fonts-bookmark'])
            assert(!index.byId.has(id));
        assert.deepEqual(await f.send('getBookmarkEdits'), []);
      });
    }
}

test('failed receipt and bookmark reads do not mutate either store', async () => {
  for (const [ownerName, method] of [
    ['storage', 'get'],
    ['bookmarks', 'getTree'],
  ]) {
    const f = fixture();
    await f.send('snapshot');
    const op = await operation(f, 'delete', 'design-bookmarks');
    const bookmarks = await f.api.bookmarks.getTree();
    const saved = structuredClone(f.api.testing.saved);
    const owner = ownerName === 'storage' ? f.api.storage.local : f.api.bookmarks;
    const original = owner[method];
    owner[method] = async () => {
      throw new Error('Read unavailable');
    };
    await assert.rejects(f.send('editBookmark', op), /Read unavailable/);
    owner[method] = original;
    assert.deepEqual(await f.api.bookmarks.getTree(), bookmarks);
    assert.deepEqual(f.api.testing.saved, saved);
  }
});

test('unsupported recovery records are preserved and unrelated saved fields survive edits', async () => {
  const f = fixture();
  const op = await operation(f, 'update', 'mdn-bookmark', {
    title: 'Edited',
    url: 'https://example.test/',
  });
  for (const value of [
    { version: 2, records: [], future: true },
    { version: 1, records: [null] },
    {
      version: 1,
      records: [
        {
          operationId: op.operationId,
          phase: 'pending',
          command: op.command,
          plan: { before: op.command.expected, after: { id: 'unrelated' } },
        },
      ],
    },
  ]) {
    f.api.testing.saved[BOOKMARK_EDITS_KEY] = value;
    await assert.rejects(f.send('editBookmark', op), /unsupported/);
    assert.deepEqual(f.api.testing.saved[BOOKMARK_EDITS_KEY], value);
  }
  f.api.testing.saved[BOOKMARK_EDITS_KEY] = { version: 1, records: [], future: { keep: true } };
  await f.send('editBookmark', op);
  assert.deepEqual(f.api.testing.saved[BOOKMARK_EDITS_KEY].future, { keep: true });
});

test('two windows cannot overwrite a bookmark using an old draft', async () => {
  const f = fixture();
  const a = await operation(f, 'update', 'mdn-bookmark', {
    title: 'Window one',
    url: 'https://one.test/',
  });
  const b = await operation(f, 'update', 'mdn-bookmark', {
    title: 'Window two',
    url: 'https://two.test/',
  });
  const results = await Promise.allSettled([
    f.send('editBookmark', a, 1),
    f.send('editBookmark', b, 2),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal((await f.index()).byId.get('mdn-bookmark').title, 'Window one');
});

test('confirmed deletion protects new and changed children and can retain partial progress', async () => {
  const f = fixture();
  const op = await operation(f, 'delete', 'design-bookmarks');
  const original = f.api.bookmarks.remove;
  let once = false;
  f.api.bookmarks.remove = async (id) => {
    await original(id);
    if (!once) {
      once = true;
      throw new Error('Remove reply lost');
    }
  };
  await assert.rejects(f.send('editBookmark', op), /reply lost/);
  f.api.bookmarks.remove = original;
  await f.api.bookmarks.update('mdn-bookmark', { title: 'Changed elsewhere' });
  const added = await f.api.bookmarks.create({
    parentId: 'design-bookmarks',
    title: 'Keep me',
    url: 'https://new.test/',
  });
  await f.restart();
  await assert.rejects(f.send('editBookmark', op), /have changed/);
  assert((await f.index()).byId.has(added.id));
  assert.equal((await f.index()).byId.get('mdn-bookmark').title, 'Changed elsewhere');
  assert.equal((await f.send('getBookmarkEdits')).length, 1);
  const before = await f.api.bookmarks.getTree();
  await f.send('dismissBookmarkEdit', op);
  assert.deepEqual(await f.send('getBookmarkEdits'), []);
  assert.deepEqual(await f.api.bookmarks.getTree(), before);
});

test('new children added during folder deletion are never removed', async () => {
  const f = fixture();
  const op = await operation(f, 'delete', 'design-bookmarks');
  const original = f.api.bookmarks.remove;
  let added;
  f.api.bookmarks.remove = async (id) => {
    if (id === 'design-bookmarks')
      added = await f.api.bookmarks.create({
        parentId: id,
        title: 'Concurrent child',
        url: 'https://keep.test/',
      });
    return original(id);
  };
  await assert.rejects(f.send('editBookmark', op), /Cannot remove/);
  assert((await f.index()).byId.has(added.id));
  assert((await f.index()).byId.has('design-bookmarks'));
});

test('moves preserve hidden siblings and separators and reject root edits and cycles', async () => {
  const f = fixture();
  const separator = await f.api.bookmarks.create({
    parentId: 'design-bookmarks',
    type: 'separator',
    title: '',
  });
  await f.send(
    'editBookmark',
    await operation(f, 'move', 'mdn-bookmark', { targetId: 'fonts-bookmark', position: 'after' }),
  );
  assert.deepEqual(
    (await f.index()).byId.get('design-bookmarks').children.map((node) => node.id),
    ['fonts-bookmark', 'mdn-bookmark', separator.id],
  );
  await f.send(
    'editBookmark',
    await operation(f, 'move', 'mdn-bookmark', { targetId: 'fonts-bookmark', position: 'before' }),
  );
  assert.equal((await f.index()).byId.get('mdn-bookmark').index, 0);
  const index = await f.index();
  assert.throws(() => bookmarkMove(index, 'toolbar_____', 'menu________'), /editable/);
  assert.throws(() => bookmarkMove(index, 'design-bookmarks', 'design-bookmarks'), /itself/);
  assert.throws(() => bookmarkMove(index, 'mdn-bookmark', 'toolbar_____', 'before'), /destination/);
  const nested = await f.api.bookmarks.create({ parentId: 'design-bookmarks', title: 'Nested' });
  await assert.rejects(
    f.send(
      'editBookmark',
      await operation(f, 'move', 'design-bookmarks', { targetId: nested.id, position: 'inside' }),
    ),
    /itself/,
  );
});

test('permission revocation preserves unfinished changes for an authorised retry', async () => {
  const f = fixture();
  const op = await operation(f, 'create');
  const original = f.api.bookmarks.create;
  f.api.bookmarks.create = async (args) => {
    const node = await original(args);
    await f.api.permissions.remove();
    return node;
  };
  await assert.rejects(f.send('editBookmark', op), /permission/);
  await f.restart();
  assert.equal((await f.send('getBookmarkEdits')).length, 1);
  f.api.bookmarks.create = original;
  await f.api.permissions.request();
  await f.send('editBookmark', op);
  assert.equal(
    [...(await f.index()).byId.values()].filter((node) => node.title === 'New reference').length,
    1,
  );
});

test('a staged bookmark moved elsewhere after a lost create reply is preserved without duplication', async () => {
  const f = fixture();
  const op = await operation(f, 'create');
  const original = f.api.bookmarks.create;
  let created;
  f.api.bookmarks.create = async (details) => {
    created = await original(details);
    throw new Error('Lost create reply');
  };
  await assert.rejects(f.send('editBookmark', op), /Lost create reply/);
  f.api.bookmarks.create = original;
  await f.api.bookmarks.move(created.id, { parentId: 'reading-bookmarks' });
  await f.restart();
  const before = await f.api.bookmarks.getTree();
  await assert.rejects(f.send('editBookmark', op), /have changed/);
  assert.deepEqual(await f.api.bookmarks.getTree(), before);
  assert.equal((await f.send('getBookmarkEdits')).length, 1);
});

test('an empty-folder deletion cannot consume children added after the request was prepared', async () => {
  const f = fixture();
  const folder = await f.api.bookmarks.create({ parentId: 'design-bookmarks', title: 'Empty' });
  const op = await operation(f, 'delete', folder.id);
  const child = await f.api.bookmarks.create({
    parentId: folder.id,
    title: 'Added elsewhere',
    url: 'https://keep.test/',
  });
  const before = await f.api.bookmarks.getTree();
  await assert.rejects(f.send('editBookmark', op, 2), /have changed/);
  assert.deepEqual(await f.api.bookmarks.getTree(), before);
  assert((await f.index()).byId.has(child.id));
});
