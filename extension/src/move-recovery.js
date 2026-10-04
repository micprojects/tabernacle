export const PENDING_MOVE_KEY = 'tabernacle.pending-move.v1';

function validGroups(groups) {
  if (!Array.isArray(groups)) return false;
  const byId = new Map();
  for (const group of groups) {
    if (
      !group ||
      typeof group.id !== 'string' ||
      !group.id ||
      byId.has(group.id) ||
      typeof group.name !== 'string' ||
      (group.parentId !== null && typeof group.parentId !== 'string')
    )
      return false;
    byId.set(group.id, group);
  }
  for (const group of groups) {
    const seen = new Set([group.id]);
    let id = group.parentId;
    while (id !== null) {
      if (seen.has(id) || !byId.has(id)) return false;
      seen.add(id);
      id = byId.get(id).parentId;
    }
  }
  return true;
}

// One serialized move at a time. This record contains only changed memberships
// and (for Move contents) the group hierarchy, never pages or saved tab lists.
export function createMoveRecovery({ api, readRecords, saveMembership, saveGroups, publish }) {
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
      if (current && JSON.stringify(current.value) !== JSON.stringify(change[pending.direction]))
        await write(current.tab.id, change[pending.direction]);
    }
    if (pending.groups) await saveGroups(pending.groups[pending.direction]);
  }

  return {
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
          value.version !== 1 ||
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
      await store(null);
      publish();
    },

    async apply(changes, groups = null) {
      if (groups && JSON.stringify(groups.before) === JSON.stringify(groups.after)) groups = null;
      if (!groups && changes.length <= 1) {
        if (changes.length) await saveMembership(changes[0].id, changes[0].after);
        return;
      }
      await store({
        version: 1,
        direction: 'after',
        changes: changes.map(({ before, after }) => ({ treeId: before.treeId, before, after })),
        groups,
      });
      try {
        for (const change of changes) await write(change.id, change.after);
        if (groups) await saveGroups(groups.after);
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
      await store(null);
    },
  };
}
