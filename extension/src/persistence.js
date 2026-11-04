import { normalizeNewTab } from './new-tab/preferences.js';

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

const retiredPreferences = {
  look: ['themeSource', 'colorLabels', 'centerNewTab', 'leftAlignNewTab'],
  newTab: ['showLater'],
};

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

function retainPreference(value, source, fields, retired) {
  let saved = source === undefined ? value : source;
  if (saved && retired.some((key) => Object.hasOwn(saved, key))) {
    saved = { ...saved };
    for (const key of retired) delete saved[key];
  }
  const edited = (fields || []).filter((key) => Object.hasOwn(value, key));
  if (!edited.length) return saved;
  return {
    // Add defaults only when preferences are edited. Existing raw values win
    // unless this action explicitly changes that field.
    ...value,
    ...(record(saved) ? saved : {}),
    ...Object.fromEntries(edited.map((key) => [key, value[key]])),
  };
}

export function serializeModel(value, preferences, edits = {}) {
  const result = deserializeModel(value);
  if (!preferences) return result;
  for (const [key, retired] of Object.entries(retiredPreferences))
    result[key] = retainPreference(value[key], preferences[key], edits[key], retired);
  if (edits.newTab?.includes('links')) {
    const previous = preferences.newTab?.links;
    if (
      previous !== undefined &&
      (!Array.isArray(previous) ||
        normalizeNewTab({ links: previous }).links.length !== previous.length)
    )
      throw new Error(
        'Some saved new-tab links are unsupported. Your saved links have not been changed.',
      );
    const byId = new Map((previous || []).map((link) => [link.id, link]));
    result.newTab.links = value.newTab.links.map((link) => ({ ...byId.get(link.id), ...link }));
  }
  if (edits.newTab?.includes('location') && value.newTab.location) {
    const previous = preferences.newTab?.location;
    result.newTab.location = {
      ...(record(previous) ? previous : {}),
      ...value.newTab.location,
    };
  }
  return result;
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
