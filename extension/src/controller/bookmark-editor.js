import {
  indexBookmarks,
  bookmarkRecord,
  bookmarkSubtree,
  bookmarkEditable,
  bookmarkMove,
  bookmarkAddress,
} from '../bookmark-edit.js';

export const BOOKMARK_EDITS_KEY = 'tabernacle.bookmark-edits.v1';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const marker = (id) => `Tabernacle unfinished bookmark ${id}`;
const stale = () =>
  new Error('These bookmarks have changed. Close this dialog and review them before trying again.');

function validRecord(record) {
  const { command, plan, phase } = record || {};
  if (
    !record ||
    typeof record.operationId !== 'string' ||
    !['pending', 'complete'].includes(phase) ||
    !command ||
    !plan
  )
    return false;
  const entry = (node) =>
    node &&
    typeof node.id === 'string' &&
    typeof node.parentId === 'string' &&
    typeof node.title === 'string' &&
    ['folder', 'bookmark', 'separator'].includes(node.type) &&
    (node.type !== 'bookmark' || typeof node.url === 'string');
  if (record.createdId !== undefined && typeof record.createdId !== 'string') return false;
  if (command.kind === 'create')
    return (
      typeof plan.parentId === 'string' &&
      typeof plan.title === 'string' &&
      ['folder', 'bookmark'].includes(plan.type) &&
      (plan.type !== 'bookmark' || typeof plan.url === 'string')
    );
  if (!entry(command.expected) || command.expected.id !== command.id) return false;
  if (command.kind === 'delete')
    return (
      Array.isArray(plan.entries) &&
      plan.entries.length &&
      plan.entries.every(entry) &&
      same(plan.entries, command.contents) &&
      same(plan.entries[0], command.expected)
    );
  if (!entry(plan.before) || !same(plan.before, command.expected)) return false;
  if (command.kind === 'update')
    return (
      entry(plan.after) &&
      plan.after.id === command.id &&
      plan.after.parentId === plan.before.parentId &&
      plan.after.type === plan.before.type
    );
  return (
    command.kind === 'move' &&
    typeof plan.parentId === 'string' &&
    (plan.beforeId === null || typeof plan.beforeId === 'string') &&
    Number.isInteger(plan.beforeIndex) &&
    plan.beforeIndex >= 0
  );
}

// All calls run inside the existing controller queue. Pending records survive
// restarts; completed receipts make lost response retries idempotent.
export function createBookmarkEditor(api) {
  async function readStore() {
    const value = (await api.storage.local.get(BOOKMARK_EDITS_KEY))[BOOKMARK_EDITS_KEY];
    if (value === undefined) return { version: 1, records: [] };
    if (
      !value ||
      value.version !== 1 ||
      !Array.isArray(value.records) ||
      value.records.some((record) => !validRecord(record)) ||
      new Set(value.records.map((record) => record.operationId)).size !== value.records.length
    )
      throw new Error(
        'The saved bookmark changes are unsupported. Their records have not been changed.',
      );
    return value;
  }

  async function save(store, record) {
    const records = store.records.filter((entry) => entry.operationId !== record.operationId);
    records.push(record);
    // Keep every unfinished operation and the latest completed receipts.
    const completed = records.filter((entry) => entry.phase === 'complete').slice(-32);
    store.records = records.filter(
      (entry) => entry.phase === 'pending' || completed.includes(entry),
    );
    await api.storage.local.set({ [BOOKMARK_EDITS_KEY]: store });
  }

  const readTree = async () => indexBookmarks(await api.bookmarks.getTree());

  function folder(index, id) {
    const node = index.byId.get(id);
    if (!node || node.type !== 'folder' || id === index.rootId || node.unmodifiable)
      throw new Error('That bookmark folder is unavailable. Choose another destination.');
    return node;
  }

  function name(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a name.');
    return value.trim();
  }

  function plan(command, index) {
    if (command.kind === 'create') {
      folder(index, command.parentId);
      if (!['folder', 'bookmark'].includes(command.type))
        throw new Error('Choose a bookmark or folder.');
      return {
        parentId: command.parentId,
        type: command.type,
        title: name(command.title),
        ...(command.type === 'bookmark' ? { url: bookmarkAddress(command.url) } : {}),
      };
    }
    const node = index.byId.get(command.id);
    if (!bookmarkEditable(index, command.id))
      throw new Error('Firefox’s built-in bookmark folders cannot be changed.');
    if (!same(bookmarkRecord(node), command.expected)) throw stale();
    if (command.kind === 'update') {
      const after = { ...bookmarkRecord(node), title: name(command.title) };
      if (node.type === 'bookmark') after.url = bookmarkAddress(command.url);
      return { before: bookmarkRecord(node), after };
    }
    if (command.kind === 'move') {
      const target = bookmarkMove(index, node.id, command.targetId, command.position);
      return { before: bookmarkRecord(node), beforeIndex: node.index, ...target };
    }
    if (command.kind === 'delete') {
      const entries = bookmarkSubtree(index, node.id);
      if (!same(entries, command.contents)) throw stale();
      if (entries.some((entry) => !bookmarkEditable(index, entry.id))) throw stale();
      return { entries };
    }
    throw new Error('Unknown bookmark action.');
  }

  async function apply(record, store) {
    const { command, plan: desired } = record;
    let index = await readTree();
    if (command.kind === 'create') {
      folder(index, desired.parentId);
      let node = record.createdId && index.byId.get(record.createdId);
      if (record.createdId && !node) throw stale();
      if (!node) {
        const candidates = [...index.byId.values()].filter(
          (entry) => entry.title === marker(record.operationId),
        );
        if (candidates.length > 1) throw stale();
        node =
          candidates[0] ||
          (await api.bookmarks.create({
            parentId: desired.parentId,
            type: desired.type,
            title: marker(record.operationId),
            ...(desired.url ? { url: desired.url } : {}),
          }));
        record = { ...record, createdId: node.id };
        await save(store, record);
      }
      if (
        node.parentId !== desired.parentId ||
        node.type !== desired.type ||
        (node.title !== marker(record.operationId) && node.title !== desired.title) ||
        (desired.url !== undefined && node.url !== desired.url)
      )
        throw stale();
      if (node.title !== desired.title)
        await api.bookmarks.update(node.id, { title: desired.title });
      record = { ...record, result: { id: node.id } };
    } else if (command.kind === 'update') {
      const node = index.byId.get(command.id);
      if (!node) throw stale();
      const current = bookmarkRecord(node);
      if (!same(current, desired.after)) {
        if (!same(current, desired.before)) throw stale();
        await api.bookmarks.update(node.id, {
          title: desired.after.title,
          ...(desired.after.url !== undefined ? { url: desired.after.url } : {}),
        });
      }
      record = { ...record, result: { id: command.id } };
    } else if (command.kind === 'move') {
      const node = index.byId.get(command.id);
      const parent = folder(index, desired.parentId);
      if (!node) throw stale();
      const siblings = parent.children.filter((entry) => entry.id !== node.id);
      const at =
        desired.beforeId === null
          ? siblings.length
          : siblings.findIndex((entry) => entry.id === desired.beforeId);
      if (at < 0) throw stale();
      const placed = node.parentId === parent.id && node.index === at;
      if (!placed) {
        if (!same(bookmarkRecord(node), desired.before) || node.index !== desired.beforeIndex)
          throw stale();
        // Recheck ancestry against live Firefox data before applying the move.
        bookmarkMove(index, node.id, parent.id, 'inside');
        await api.bookmarks.move(node.id, { parentId: parent.id, index: at });
      }
      record = { ...record, result: { id: node.id } };
    } else {
      for (const expected of [...desired.entries].reverse()) {
        index = await readTree();
        const node = index.byId.get(expected.id);
        if (!node) continue; // Includes a remove whose successful reply was lost.
        if (!same(bookmarkRecord(node), expected) || !bookmarkEditable(index, node.id))
          throw stale();
        // remove(), not removeTree(): Firefox refuses a folder with new children.
        // Newly added or changed bookmarks are never included in an old confirmation.
        if (node.children?.length) throw stale();
        await api.bookmarks.remove(node.id);
      }
      record = { ...record, result: { id: command.id, deleted: true } };
    }
    await save(store, { ...record, phase: 'complete' });
    return record.result;
  }

  async function edit({ operationId, command }) {
    if (typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(operationId) || !command)
      throw new Error('Choose a bookmark action.');
    const store = await readStore();
    const previous = store.records.find((entry) => entry.operationId === operationId);
    if (previous) {
      if (!same(previous.command, command))
        throw new Error('This retry belongs to another bookmark change.');
      return previous.phase === 'complete' ? previous.result : apply(previous, store);
    }
    const record = {
      operationId,
      command,
      plan: plan(command, await readTree()),
      phase: 'pending',
    };
    await save(store, record);
    return apply(record, store);
  }

  return {
    edit,

    async dismiss({ operationId }) {
      const store = await readStore();
      const record = store.records.find((entry) => entry.operationId === operationId);
      if (record?.phase === 'pending')
        await save(store, { ...record, phase: 'complete', result: { abandoned: true } });
    },

    async pending() {
      return (await readStore()).records
        .filter((entry) => entry.phase === 'pending')
        .map(({ operationId, command }) => ({ operationId, command }));
    },
  };
}
