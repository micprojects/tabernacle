import { matchesTarget, inCollection, duplicateKey } from './tab-collection.js';
import { isSavedForLater } from './model.js';
import { createFolderIndex } from './folder-index.js';

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
  // Folder topology is fixed by the controller queue for this operation.
  // Native tab membership is still checked afresh before each write.
  const folders = !undoing && scope?.kind === 'folder' ? createFolderIndex(state) : undefined;
  let time =
    state.tabs.reduce((latest, tab) => Math.max(latest, tab.savedForLaterAt || 0), Date.now()) +
    targets.length;
  const selected = new Set(targets.map((target) => target.id));
  const keepers = new Map();
  if (duplicate)
    for (const expected of message.keepers) {
      const key = duplicateKey(expected);
      if (!key || selected.has(expected.id)) continue;
      if (!keepers.has(key)) keepers.set(key, []);
      keepers.get(key).push(expected);
    }
  for (const target of targets) {
    let attempted = false;
    try {
      const validate = async () => {
        const tab = await freshTab(target.id);
        if (
          !matchesTarget(tab, target) ||
          (!undoing && !inCollection(state, tab, scope, folders)) ||
          (saving && isSavedForLater(tab)) ||
          (undoing && !isSavedForLater(tab))
        ) {
          return false;
        }
        if (duplicate) {
          const key = duplicateKey(tab);
          let keeper = false;
          // The index narrows reviewed candidates only. Read matching keepers
          // again on every validation, including immediately before removal.
          for (const expected of keepers.get(key) || []) {
            const candidate = await freshTab(expected.id);
            if (
              matchesTarget(candidate, expected) &&
              inCollection(state, candidate, scope, folders) &&
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
        return (
          matchesTarget(current, target) &&
          (undoing || inCollection(state, current, scope, folders))
        );
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
