// Retired site preferences and Hacker News routing are ignored and omitted on save.
// Keep the original groups/groupId storage format. Accept the former folder
// field names at this boundary, including records restored from closed tabs.
export function deserializeModel(value) {
  if (value == null) return value;
  const {
    folders,
    appearance,
    combinedLook,
    compact,
    siteModes,
    siteEnhancementsEnabled,
    youtubeMode,
    ...rest
  } = value;
  // Retain the former Combined preferences while retiring the appearance selector.
  if (!Object.hasOwn(value, 'look') && combinedLook !== undefined) rest.look = combinedLook;
  return Object.hasOwn(value, 'groups') ? rest : { ...rest, groups: folders };
}

export function serializeModel(value) {
  return deserializeModel(value);
}

export function deserializeMembership(value) {
  if (value == null) return value;
  // Retiring Later restores the original placement without a migration write.
  // Old open/closed sessions may retain the marker until their next normal save.
  const { folderId, hnStory, savedForLaterAt, ...rest } = value;
  // An absent membership means a newly created tab still needs placement.
  if (Object.hasOwn(value, 'groupId')) return rest;
  return Object.hasOwn(value, 'folderId') ? { ...rest, groupId: folderId } : rest;
}

export function serializeMembership(value) {
  return deserializeMembership(value);
}
