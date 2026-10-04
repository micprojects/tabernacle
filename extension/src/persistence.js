// Keep the original groups/groupId storage format. Accept the former folder
// field names at this boundary, including records restored from closed tabs.
export function deserializeModel(value) {
  if (value == null) return value;
  const { folders, appearance, combinedLook, compact, ...rest } = value;
  // Retain the former Combined preferences while retiring the appearance selector.
  if (!Object.hasOwn(value, 'look') && combinedLook !== undefined) rest.look = combinedLook;
  return Object.hasOwn(value, 'groups') ? rest : { ...rest, groups: folders };
}

export function serializeModel(value) {
  return deserializeModel(value);
}

export function deserializeMembership(value) {
  if (value == null) return value;
  const { folderId, ...rest } = value;
  // An absent membership means a newly created tab still needs placement.
  if (Object.hasOwn(value, 'groupId')) return rest;
  return Object.hasOwn(value, 'folderId') ? { ...rest, groupId: folderId } : rest;
}

export function serializeMembership(value) {
  return deserializeMembership(value);
}
