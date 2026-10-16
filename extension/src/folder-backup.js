import { cleanName } from './model.js';
import { requireGroupAppearance } from './folder-appearance.js';

export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const format = 'tabernacle-folders';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;

function invalid(detail) {
  throw new Error(`This folder backup is invalid: ${detail}.`);
}

// Rebuild allowlisted records rather than importing extension storage wholesale.
export function parseFolderBackup(input) {
  let value = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > MAX_BACKUP_BYTES)
      invalid('the file is larger than 5 MB');
    try {
      value = JSON.parse(input);
    } catch {
      invalid('choose a JSON file exported by Tabernacle');
    }
  }
  if (!object(value) || value.format !== format) invalid('choose a Tabernacle folder backup');
  if (value.version !== 1) throw new Error('This backup needs a newer version of Tabernacle.');
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt)))
    invalid('the export date is missing');
  if (!Array.isArray(value.folders) || value.folders.length > 10000)
    invalid('expected up to 10,000 folders');
  if (!Array.isArray(value.containers) || value.containers.length > 10000)
    invalid('the container list is missing or too large');
  const containerIds = new Set();
  const containers = value.containers.map((item) => {
    if (!object(item) || !identifier(item.id) || item.id === 'none' || containerIds.has(item.id))
      invalid('container identifiers must be unique');
    containerIds.add(item.id);
    if (item.unavailable === true) return { id: item.id, unavailable: true };
    if (
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      typeof item.color !== 'string' ||
      !item.color ||
      typeof item.icon !== 'string' ||
      !item.icon
    )
      invalid('a container definition is incomplete');
    return { id: item.id, name: item.name, color: item.color, icon: item.icon };
  });
  const byId = new Map();
  const folders = value.folders.map((item) => {
    if (!object(item) || !identifier(item.id) || byId.has(item.id))
      invalid('folder identifiers must be unique');
    if (typeof item.name !== 'string' || cleanName(item.name) !== item.name)
      invalid('a folder name is invalid');
    if (item.parentId !== null && !identifier(item.parentId)) invalid('a parent is invalid');
    const folder = { id: item.id, name: item.name, parentId: item.parentId };
    if (item.appearance !== undefined) folder.appearance = requireGroupAppearance(item.appearance);
    if (item.container !== undefined && item.container !== null) {
      if (item.container !== 'none' && !containerIds.has(item.container))
        invalid('a folder refers to a missing container');
      folder.container = item.container;
    }
    byId.set(item.id, folder);
    return folder;
  });
  const finished = new Set();
  for (const folder of folders) {
    const path = new Set();
    let id = folder.id;
    while (id !== null && !finished.has(id)) {
      if (path.has(id)) invalid('folders cannot contain themselves');
      if (!byId.has(id)) invalid('a parent folder is missing');
      path.add(id);
      id = byId.get(id).parentId;
    }
    for (const key of path) finished.add(key);
  }
  return { format, version: 1, exportedAt: value.exportedAt, folders, containers };
}

export function exportFolderBackup(groups, identities, now = new Date()) {
  const ids = new Map(groups.map((group, index) => [group.id, `folder-${index + 1}`]));
  const stores = new Map();
  const containers = [];
  const folders = groups.map((group) => {
    const folder = {
      id: ids.get(group.id),
      name: group.name,
      parentId: group.parentId === null ? null : ids.get(group.parentId),
      ...(group.appearance ? { appearance: requireGroupAppearance(group.appearance) } : {}),
    };
    const store = group.defaultCookieStoreId;
    if (store === 'firefox-default') folder.container = 'none';
    else if (store != null) {
      if (!stores.has(store)) {
        const id = `container-${stores.size + 1}`;
        stores.set(store, id);
        const identity = identities.find((item) => item.cookieStoreId === store);
        containers.push(
          identity
            ? { id, name: identity.name, color: identity.color, icon: identity.icon }
            : { id, unavailable: true },
        );
      }
      folder.container = stores.get(store);
    }
    return folder;
  });
  return parseFolderBackup({
    format,
    version: 1,
    exportedAt: now.toISOString(),
    folders,
    containers,
  });
}

function folderImportDestination(groups, value = {}) {
  if (!object(value)) throw new Error('Choose where to import the folders.');
  const parentId = value.parentId ?? null;
  if (parentId !== null && !groups.some((group) => group.id === parentId))
    throw new Error('That destination no longer exists. Choose another folder.');
  if (value.newFolderName !== undefined && typeof value.newFolderName !== 'string')
    throw new Error('Give your new folder a name.');
  return {
    parentId,
    ...(value.newFolderName !== undefined ? { newFolderName: cleanName(value.newFolderName) } : {}),
  };
}

// A parent-first traversal retains sibling order even when a file lists children first.
export function planFolderImport(backup, groups, destination) {
  destination = folderImportDestination(groups, destination);
  const importedChildren = new Map();
  for (const folder of backup.folders) {
    if (!importedChildren.has(folder.parentId)) importedChildren.set(folder.parentId, []);
    importedChildren.get(folder.parentId).push(folder);
  }
  const existingChildren = new Map();
  for (const group of groups) {
    if (!existingChildren.has(group.parentId)) existingChildren.set(group.parentId, new Map());
    const names = existingChildren.get(group.parentId);
    if (!names.has(group.name)) names.set(group.name, []);
    names.get(group.name).push(group.id);
  }
  const rows = [];
  const required = new Set();
  const stack = [
    {
      sourceParent: null,
      targetParent: destination.newFolderName ? null : destination.parentId,
      newParent: Boolean(destination.newFolderName),
      depth: 0,
    },
  ];
  while (stack.length) {
    const { sourceParent, targetParent, newParent, depth } = stack.pop();
    const siblings = importedChildren.get(sourceParent) ?? [];
    const offsets = new Map();
    const branches = [];
    for (const folder of siblings) {
      const offset = offsets.get(folder.name) ?? 0;
      offsets.set(folder.name, offset + 1);
      const existingId = newParent
        ? undefined
        : existingChildren.get(targetParent)?.get(folder.name)?.[offset];
      rows.push({ folder, existingId: existingId ?? null, depth });
      if (!existingId && folder.container && folder.container !== 'none')
        required.add(folder.container);
      branches.push({
        sourceParent: folder.id,
        targetParent: existingId,
        newParent: !existingId,
        depth: depth + 1,
      });
    }
    // Insert descendants directly after their parents in the display below.
    for (const branch of branches.reverse()) stack.push(branch);
  }
  const bySource = new Map(rows.map((row) => [row.folder.id, row]));
  const ordered = [];
  const pending = [...(importedChildren.get(null) ?? [])].reverse();
  while (pending.length) {
    const folder = pending.pop();
    ordered.push(bySource.get(folder.id));
    const children = importedChildren.get(folder.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return {
    destination,
    rows: ordered,
    createCount: rows.filter((row) => !row.existingId).length,
    reuseCount: rows.filter((row) => row.existingId).length,
    containers: backup.containers.filter((item) => required.has(item.id)),
  };
}

export function materializeFolderImport(plan, containerMap, createId = () => crypto.randomUUID()) {
  const groups = [];
  let destinationId = plan.destination.parentId;
  if (plan.destination.newFolderName) {
    destinationId = createId();
    groups.push({
      id: destinationId,
      name: plan.destination.newFolderName,
      parentId: plan.destination.parentId,
    });
  }
  const ids = new Map();
  for (const { folder, existingId } of plan.rows) {
    const id = existingId ?? createId();
    ids.set(folder.id, id);
    if (existingId) continue;
    const group = {
      id,
      name: folder.name,
      parentId: folder.parentId === null ? destinationId : ids.get(folder.parentId),
    };
    if (folder.appearance) group.appearance = { ...folder.appearance };
    if (folder.container)
      group.defaultCookieStoreId =
        folder.container === 'none' ? 'firefox-default' : containerMap.get(folder.container);
    groups.push(group);
  }
  return { groups, destinationId };
}
