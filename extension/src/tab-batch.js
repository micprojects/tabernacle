import { matchesTarget, inCollection, duplicateKey } from './tab-collection.js';
import { isSavedForLater } from './model.js';

// Runs inside the controller queue. Native state is checked again for every
// target; a failure never expands the reviewed set or hides partial success.
export async function applyTabBatch(
  message,
  { state, freshTab, save, close, isClosed = async () => false },
) {
  const { type, targets, scope } = message;
  if (
    !Array.isArray(targets) ||
    targets.some((target) => !Number.isInteger(target?.id) || typeof target.treeId !== 'string') ||
    new Set(targets.map((target) => target.id)).size !== targets.length
  )
    throw new Error('Choose the tabs to update.');
  const result = { completed: [], skipped: [], failed: [], undo: [] };
  const saving = type === 'saveTabsForLater';
  const undoing = type === 'undoSaveTabsForLater';
  const duplicate = type === 'closeDuplicateTabs';
  if (duplicate && !Array.isArray(message.keepers)) throw new Error('Choose a copy to keep.');
  let time =
    state.tabs.reduce((latest, tab) => Math.max(latest, tab.savedForLaterAt || 0), Date.now()) +
    targets.length;
  const selected = new Set(targets.map((target) => target.id));
  for (const target of targets) {
    let attempted = false;
    try {
      const validate = async () => {
        const tab = await freshTab(target.id);
        if (
          !matchesTarget(tab, target) ||
          (!undoing && !inCollection(state, tab, scope)) ||
          (saving && isSavedForLater(tab)) ||
          (undoing && !isSavedForLater(tab))
        ) {
          return false;
        }
        if (duplicate) {
          const key = duplicateKey(tab);
          let keeper = false;
          for (const expected of message.keepers) {
            if (selected.has(expected.id)) continue;
            const candidate = await freshTab(expected.id);
            if (
              matchesTarget(candidate, expected) &&
              inCollection(state, candidate, scope) &&
              key &&
              duplicateKey(candidate) === key
            ) {
              keeper = true;
              break;
            }
          }
          if (!keeper) {
            return false;
          }
        }
        // Keeper and metadata reads can yield to a native navigation or move.
        const current = await freshTab(target.id);
        return matchesTarget(current, target) && (undoing || inCollection(state, current, scope));
      };

      if (!(await validate())) {
        result.skipped.push(target.id);
        continue;
      }
      attempted = true;
      let changed;
      if (saving) {
        const savedForLaterAt = time--;
        changed = await save(target.id, savedForLaterAt, validate);
        if (changed !== false) result.undo.push({ ...target, savedForLaterAt });
      } else if (undoing) changed = await save(target.id, null, validate);
      else changed = await close(target.id, validate);
      result[changed === false ? 'skipped' : 'completed'].push(target.id);
    } catch (error) {
      // A browser call can report a failure after it has already closed a tab.
      const closed =
        attempted && !saving && !undoing && (await isClosed(target.id).catch(() => false));
      if (closed) result.completed.push(target.id);
      else result.failed.push({ id: target.id, error: error.message });
    }
  }
  return result;
}
