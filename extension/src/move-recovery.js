import { validGroups } from './model.js';

export const PENDING_MOVE_KEY = 'tabernacle.pending-move.v1';

function validExtras(value) {
  const receipt = value.receipt;
  if (
    !receipt ||
    !Number.isInteger(receipt.windowId) ||
    typeof receipt.operationId !== 'string' ||
    !receipt.operationId ||
    receipt.operationId.length > 128 ||
    !['tab', 'group', 'pin-group'].includes(receipt.source?.kind) ||
    (receipt.source.kind === 'tab'
      ? !Number.isInteger(receipt.source.id) ||
        typeof receipt.source.treeId !== 'string' ||
        !receipt.source.treeId
      : typeof receipt.source.id !== 'string' || !receipt.source.id) ||
    typeof receipt.label !== 'string'
  )
    return false;
  const effects = value.effects;
  if (effects == null) return true;
  if (effects.windowId !== receipt.windowId) return false;
  const item = (value) =>
    ['tab', 'group'].includes(value?.kind) && typeof value.id === 'string' && value.id.length > 0;
  const items = (value) =>
    Array.isArray(value) &&
    value.every(item) &&
    new Set(value.map((item) => `${item.kind}:${item.id}`)).size === value.length;
  const pins = (value) =>
    Array.isArray(value) &&
    value.every((item) => typeof item?.id === 'string' && ['open', 'reveal'].includes(item.action));
  const pair = (value, valid) => value == null || (valid(value.before) && valid(value.after));
  const native = (value) =>
    value &&
    typeof value.pinned === 'boolean' &&
    (value.beforeTreeId === null || typeof value.beforeTreeId === 'string');
  return (
    pair(effects.layout, items) &&
    (effects.layout == null || item(effects.layout.item)) &&
    pair(effects.folderPins, pins) &&
    (effects.pin == null || (typeof effects.pin.treeId === 'string' && pair(effects.pin, native)))
  );
}

// One serialized move at a time. This record contains only changed memberships
// and (for Move contents) the group hierarchy, never pages or saved tab lists.
export function createMoveRecovery({
  api,
  readRecords,
  saveMembership,
  saveGroups,
  publish,
  applyEffects,
  saveReceipt,
}) {
  let pending;

  async function store(value) {
    await api.storage.local.set({ [PENDING_MOVE_KEY]: value });
    pending = value;
  }

  async function write(id, value) {
    try {
      await saveMembership(id, value);
    } catch (error) {
      // Only an independently confirmed close makes a failed write harmless.
      if ((await api.tabs.query({})).some((tab) => tab.id === id)) throw error;
    }
  }

  async function replay() {
    const records = await readRecords(await api.tabs.query({}));
    const byKey = new Map();
    const needed = new Set(pending.changes.map((change) => change.treeId));
    for (const { tab, value } of records) {
      if (!needed.has(value.treeId)) continue;
      if (byKey.has(value.treeId))
        throw new Error(
          'Move recovery found duplicated tab identities. Close the duplicate tabs and try again.',
        );
      byKey.set(value.treeId, { tab, value });
    }
    for (const change of pending.changes) {
      const current = byKey.get(change.treeId);
      if (current && JSON.stringify(current.value) !== JSON.stringify(change[pending.direction])) {
        const value = pending.version === 2 ? { ...current.value } : change[pending.direction];
        if (pending.version === 2)
          for (const key of new Set([
            ...Object.keys(change.before),
            ...Object.keys(change.after),
          ])) {
            if (JSON.stringify(change.before[key]) === JSON.stringify(change.after[key])) continue;
            if (Object.hasOwn(change[pending.direction], key))
              value[key] = change[pending.direction][key];
            else delete value[key];
          }
        await write(current.tab.id, value);
      }
    }
    if (pending.groups)
      await saveGroups(
        pending.groups[pending.direction],
        pending.version === 2 ? pending.receipt.source : null,
      );
    if (pending.effects) await applyEffects(pending.effects, pending.direction);
  }

  return {
    hasPending: () => Boolean(pending),

    async load() {
      const value = (await api.storage.local.get(PENDING_MOVE_KEY))[PENDING_MOVE_KEY];
      if (value != null) {
        const membership = (item, treeId) =>
          item &&
          item.treeId === treeId &&
          (item.groupId == null || typeof item.groupId === 'string') &&
          Number.isFinite(item.order) &&
          (item.ancestors === undefined ||
            (Array.isArray(item.ancestors) &&
              item.ancestors.every((key) => typeof key === 'string')));
        if (
          ![1, 2].includes(value.version) ||
          (value.version === 2 && !validExtras(value)) ||
          !['before', 'after'].includes(value.direction) ||
          !Array.isArray(value.changes) ||
          !value.changes.every(
            (change) =>
              change &&
              typeof change.treeId === 'string' &&
              change.treeId.length > 0 &&
              membership(change.before, change.treeId) &&
              membership(change.after, change.treeId),
          ) ||
          new Set(value.changes.map((change) => change.treeId)).size !== value.changes.length ||
          (value.groups != null &&
            (!validGroups(value.groups.before) || !validGroups(value.groups.after)))
        )
          throw new Error('The pending move could not be read. Your data has been kept.');
      }
      pending = value;
    },

    async recover() {
      if (!pending) return;
      await replay();
      if (pending.receipt && pending.direction === 'after') await saveReceipt(pending.receipt);
      await store(null);
      publish();
    },

    async apply(changes, groups = null, extras = null) {
      if (groups && JSON.stringify(groups.before) === JSON.stringify(groups.after)) groups = null;
      if (!extras && !groups && changes.length <= 1) {
        if (changes.length) await saveMembership(changes[0].id, changes[0].after);
        return;
      }
      await store({
        version: extras ? 2 : 1,
        direction: 'after',
        changes: changes.map(({ before, after }) => ({ treeId: before.treeId, before, after })),
        groups,
        ...(extras || {}),
      });
      try {
        for (const change of changes) await write(change.id, change.after);
        if (groups) await saveGroups(groups.after, extras?.receipt.source);
        if (pending.effects) await applyEffects(pending.effects, 'after');
      } catch (error) {
        // Persist compensation before touching anything: a restart must finish
        // a rollback, rather than resume the move that already reported failure.
        try {
          await store({ ...pending, direction: 'before' });
          await replay();
          await store(null);
        } catch {
          throw new Error(
            'The move could not finish recovery. Your recovery record has been kept; try again.',
          );
        } finally {
          publish();
        }
        throw error;
      }
      // Cleanup is outside the rollback boundary. Failure here must never undo
      // a committed move, and the next queued action must clear it first.
      if (pending.receipt) await saveReceipt(pending.receipt);
      await store(null);
    },
  };
}
