import {
  children,
  groupById,
  groupPath,
  isWithin,
  sortTabs,
  tabAncestors,
  tabSubtree,
  unpinnedTabTree,
} from './model.js';
import { movePin, pinKey } from './pinned-items.js';

export function moveSource(state, kind, id) {
  if (kind === 'tab') {
    const tab = state.tabs.find((item) => item.id === id);
    if (!tab) throw new Error('That tab has closed or moved to another window.');
    return { kind, id, treeId: tab.treeId };
  }
  if (!['group', 'pin-group'].includes(kind) || !groupById(state, id))
    throw new Error('That folder no longer exists.');
  return { kind, id };
}

function folderDestinationName(state, id) {
  return ['Home', ...groupPath(state, id).map((group) => group.name)].join(' / ');
}

function placement(tab) {
  return [tab.treeId, tab.groupId, tab.parentTabId, tab.ancestors, tab.order, Boolean(tab.pinned)];
}

export function sourcePlacement(state, source) {
  if (source.kind === 'tab') {
    const tab = state.tabs.find((tab) => tab.id === source.id && tab.treeId === source.treeId);
    if (!tab) throw new Error('The source tab has changed. Try again.');
    return JSON.stringify(tabSubtree(state.tabs, tab.id).map(placement));
  }
  const group = groupById(state, source.id);
  if (!group) throw new Error('That folder no longer exists.');
  return JSON.stringify([
    source.kind,
    groupPath(state, group.id).map((group) => group.id),
    children(state, group.parentId).map((group) => group.id),
  ]);
}

// All entry points resolve intent to the same legal slot. Geometry belongs to
// the pointer UI; this function is also authoritative in the background page.
export function resolveMove(state, source, intent) {
  const identity = moveSource(state, source?.kind, source?.id);
  if (source.kind === 'tab' && identity.treeId !== source.treeId)
    throw new Error('The source tab has changed. Try again.');
  const tab = source.kind === 'tab' ? state.tabs.find((tab) => tab.id === source.id) : null;
  const title = tab?.title || groupById(state, source.id)?.name || 'New tab';
  const branch = tab ? tabSubtree(state.tabs, tab.id) : [];
  const moving = new Set(branch.map((tab) => tab.id));
  const count = tab
    ? branch.length
    : state.tabs.filter((tab) => isWithin(state, tab.groupId, source.id)).length;
  const sourceState = sourcePlacement(state, source);
  let destination,
    siblings,
    parent,
    target,
    position = intent?.position || 'inside';

  if (intent?.kind === 'pins') {
    if (source.kind === 'group') throw new Error('Use Pin folder to add a folder shortcut.');
    const item = { kind: tab ? 'tab' : 'group', id: tab ? tab.treeId : source.id };
    const pins = state.pins || [];
    if (!tab && !pins.some((pin) => pinKey(pin) === pinKey(item)))
      throw new Error('That folder is no longer pinned.');
    const items = pins.some((pin) => pinKey(pin) === pinKey(item)) ? pins : [...pins, item];
    const before = intent.before ?? null;
    const next = movePin(items, item, before);
    destination = { kind: 'pins', before };
    const noOp = (!tab || tab.pinned) && JSON.stringify(next) === JSON.stringify(pins);
    const following = next[next.findIndex((pin) => pinKey(pin) === pinKey(item)) + 1];
    const followingName =
      following?.kind === 'tab'
        ? state.tabs.find((tab) => tab.treeId === following.id)?.title || 'New tab'
        : groupById(state, following?.id)?.name;
    return {
      source: identity,
      destination,
      count: tab ? 1 : count,
      title,
      pinned: tab ? true : undefined,
      noOp,
      pinItems: next,
      label: `${tab && !tab.pinned ? 'Pin' : 'Reorder'} ${tab ? 'tab' : 'folder shortcut'} ${following ? `before ${followingName}` : 'at the end'} in pinned items`,
      expected: JSON.stringify([sourceState, destination, pins]),
    };
  }
  if (source.kind === 'pin-group')
    throw new Error('Drag this shortcut within pinned items. Move the folder from the tree.');

  if (intent?.kind === 'group') {
    target = groupById(state, intent.id);
    if (!target) throw new Error('That folder no longer exists.');
    if (tab || position === 'inside') {
      destination = tab
        ? { kind: 'tree', groupId: target.id, parentTabId: null, beforeId: null }
        : { kind: 'folder', parentId: target.id, beforeId: null };
      position = 'inside';
    } else {
      const groups = children(state, target.parentId);
      destination = {
        kind: 'folder',
        parentId: target.parentId,
        beforeId:
          position === 'before' ? target.id : (groups[groups.indexOf(target) + 1]?.id ?? null),
      };
    }
  } else if (intent?.kind === 'tab') {
    if (!tab)
      throw new Error('Folders cannot be nested under tabs. Drop onto a folder or Home instead.');
    target = unpinnedTabTree(state.tabs).find((tab) => tab.id === intent.id);
    if (!target) throw new Error('The destination tab has moved or closed.');
    const peers = sortTabs(
      unpinnedTabTree(state.tabs).filter(
        (tab) => tab.groupId === target.groupId && tab.parentTabId === target.parentTabId,
      ),
    );
    destination = {
      kind: 'tree',
      groupId: target.groupId,
      parentTabId: position === 'inside' ? target.id : target.parentTabId,
      beforeId:
        position === 'inside'
          ? null
          : position === 'before'
            ? target.id
            : (peers[peers.findIndex((tab) => tab.id === target.id) + 1]?.id ?? null),
    };
  } else if (intent?.kind === 'tree') {
    destination = tab
      ? {
          kind: 'tree',
          groupId: intent.groupId ?? null,
          parentTabId: intent.parentTabId ?? null,
          beforeId: intent.beforeId ?? null,
        }
      : { kind: 'folder', parentId: intent.groupId ?? null, beforeId: intent.beforeId ?? null };
  } else if (intent?.kind === 'folder' && !tab) {
    destination = {
      kind: 'folder',
      parentId: intent.parentId ?? null,
      beforeId: intent.beforeId ?? null,
    };
  } else throw new Error('Choose a destination in this sidebar.');

  const groupId = tab ? destination.groupId : destination.parentId;
  if (groupId !== null && !groupById(state, groupId))
    throw new Error('That folder no longer exists.');
  if (tab) {
    parent = state.tabs.find((tab) => tab.id === destination.parentTabId);
    if (
      destination.parentTabId !== null &&
      (!parent || parent.pinned || parent.groupId !== groupId)
    )
      throw new Error('The parent tab has moved. Try again.');
    if (moving.has(destination.parentTabId))
      throw new Error('A tab cannot nest under itself or one of its children.');
    siblings = sortTabs(
      unpinnedTabTree(state.tabs).filter(
        (tab) => tab.groupId === groupId && tab.parentTabId === destination.parentTabId,
      ),
    );
  } else {
    if (isWithin(state, groupId, source.id))
      throw new Error('A folder cannot go inside itself or one of its subfolders.');
    siblings = children(state, groupId);
  }
  const ids = siblings.map((item) => item.id);
  if (destination.beforeId !== null && !ids.includes(destination.beforeId))
    throw new Error('The destination has moved. Try again.');
  // Dropping immediately before oneself denotes the existing slot.
  if (destination.beforeId === source.id)
    destination.beforeId = ids[ids.indexOf(source.id) + 1] ?? null;
  if (tab && destination.beforeId !== null && moving.has(destination.beforeId))
    throw new Error('A tab cannot move inside its own children.');
  const remaining = ids.filter((id) => id !== source.id);
  const insertion =
    destination.beforeId === null ? remaining.length : remaining.indexOf(destination.beforeId);
  const next = [...remaining];
  next.splice(insertion, 0, source.id);
  const sameParent = tab
    ? !tab.pinned && tab.groupId === groupId && tab.parentTabId === destination.parentTabId
    : groupById(state, source.id).parentId === groupId;
  const noOp = sameParent && JSON.stringify(ids) === JSON.stringify(next);
  const path = folderDestinationName(state, groupId);
  const parentPath = parent
    ? [...tabAncestors(state.tabs, parent.id).reverse(), parent]
        .map((tab) => tab.title || 'New tab')
        .join(' / ')
    : '';
  const subject = tab ? `${count} ${count === 1 ? 'tab' : 'tabs'}` : 'folder';
  const verb = tab?.pinned ? 'Unpin and move' : 'Move';
  const before = siblings.find((item) => item.id === destination.beforeId);
  const boundary = before ? `before ${before.title || before.name || 'New tab'}` : 'at the end';
  const label =
    position !== 'inside' && target
      ? `${verb} ${subject} ${position} ${target.title || target.name || 'New tab'} in ${path}`
      : `${verb} ${subject} into ${path}${parentPath ? ` / ${parentPath}` : ''}, ${boundary}`;
  return {
    source: identity,
    destination,
    title,
    count,
    pinned: tab ? false : undefined,
    noOp,
    label,
    expected: JSON.stringify([
      sourceState,
      destination,
      groupPath(state, groupId).map((group) => group.id),
      parent ? placement(parent) : null,
      siblings.map((item) => (tab ? placement(item) : [item.id, item.parentId])),
    ]),
  };
}
