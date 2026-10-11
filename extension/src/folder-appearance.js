import { groupPath } from './model.js';

// Pictogram IDs match the official 16px Acorn desktop assets; letter and number
// IDs use Tabernacle's custom symbols. Keywords also describe common browsing tasks.
const categories = {
  General: [
    ['folder', 'Folder', 'organise collection'],
    ['bookmark', 'Bookmark', 'favourites favorites saved star'],
    ['heart', 'Heart', 'favourites favorites love'],
    ['pin', 'Pin', 'important reminder'],
    ['globe', 'Globe', 'web internet world international'],
    ['lightbulb', 'Light bulb', 'ideas inspiration'],
    ['sparkles', 'Sparkles', 'ai inspiration magic'],
    ['diamond', 'Diamond', 'special valuable collection'],
  ],
  'Work & people': [
    ['briefcase', 'Briefcase', 'work business career jobs office'],
    ['users', 'People', 'team family friends community social'],
    ['single-user', 'Person', 'personal profile account'],
    ['email', 'Email', 'mail inbox messages'],
    ['comment', 'Chat', 'messages conversation forum social'],
    ['notifications', 'Bell', 'notifications alerts reminders'],
    ['list', 'List', 'tasks todo checklist planning'],
    ['checkmark', 'Tick', 'done complete tasks check'],
  ],
  'Reading & learning': [
    ['book', 'Book', 'reading study school education university courses'],
    ['library', 'Library', 'books reference learning research'],
    ['reader-mode', 'Article', 'reading blog writing text'],
    ['newsfeed', 'News', 'newspaper headlines current affairs politics'],
    ['search', 'Search', 'research discover investigate'],
    ['labs', 'Flask', 'science experiments research chemistry'],
    ['translate', 'Languages', 'translate translation learning dictionary'],
    ['highlighter', 'Highlighter', 'notes study revision annotation'],
  ],
  'Media & creativity': [
    ['musical-note', 'Music', 'songs audio playlist instruments'],
    ['audio', 'Speaker', 'audio sound listening'],
    ['microphone', 'Microphone', 'podcast recording voice'],
    ['camera', 'Camera', 'photos photography pictures'],
    ['play-circle-fill', 'Play', 'video films movies television tv streaming'],
    ['video-game-controller', 'Game controller', 'games gaming entertainment'],
    ['themes', 'Paintbrush', 'art design creative painting themes'],
    ['edit', 'Pencil', 'writing notes drawing creative'],
  ],
  'Home & travel': [
    ['plane', 'Plane', 'travel holiday vacation flights trip'],
    ['location', 'Map pin', 'maps places travel directions local'],
    ['home', 'Home', 'house property accommodation hotels family'],
    ['bike', 'Bicycle', 'cycling transport travel outdoors'],
    ['tree', 'Tree', 'nature outdoors hiking camping garden'],
    ['sun', 'Sun', 'weather summer holiday'],
    ['moon', 'Moon', 'night sleep space astronomy'],
    ['fence', 'Fence', 'garden home diy outdoors'],
  ],
  'Shopping & money': [
    ['shopping-cart', 'Shopping cart', 'buy shop basket groceries'],
    ['shopping', 'Shopping bag', 'buy shop clothes fashion'],
    ['gift', 'Gift', 'presents birthday celebration wishlist'],
    ['price', 'Price tag', 'deals discounts shopping sale'],
    ['payment-methods', 'Payment card', 'bank money finance bills subscriptions'],
    ['dollar-sign-circle', 'Money', 'finance budget banking savings currency'],
    ['arrow-trending', 'Chart', 'investing stocks finance analytics statistics'],
    ['shipping', 'Delivery', 'shopping parcels shipping orders tracking'],
  ],
  'Health & hobbies': [
    ['heart-rate', 'Heartbeat', 'health medical wellbeing care'],
    ['barbell', 'Weights', 'fitness gym exercise sport workout'],
    ['soccer-ball', 'Football', 'sport soccer match'],
    ['apple', 'Apple', 'food fruit nutrition health diet'],
    ['knife-and-fork', 'Cutlery', 'food recipes cooking restaurants dining'],
    ['paw-print', 'Paw print', 'pets animals cats dogs'],
    ['dog', 'Dog', 'pets animals puppy'],
    ['flower', 'Flower', 'garden plants nature hobbies'],
  ],
  Technology: [
    ['keyboard', 'Keyboard', 'coding programming development computer'],
    ['device-mobile', 'Phone', 'mobile devices apps technology'],
    ['window', 'Window', 'desktop computer software apps'],
    ['extension', 'Puzzle piece', 'extensions addons plugins tools'],
    ['settings', 'Gear', 'settings tools development admin'],
    ['storage', 'Database', 'data storage servers hosting'],
    ['local-network', 'Network', 'networking internet servers development'],
    ['shield', 'Shield', 'security privacy protection'],
  ],
  'Files & privacy': [
    ['page-portrait', 'Document', 'files documents paperwork'],
    ['archive', 'Archive', 'files old storage backup'],
    ['folder-arrow-down', 'Saved folder', 'files downloads collection'],
    ['downloads', 'Download', 'files save offline'],
    ['link', 'Link', 'urls websites bookmarks references'],
    ['paperclip', 'Paperclip', 'attachments files resources'],
    ['lock', 'Lock', 'private security passwords accounts'],
    ['fingerprinter', 'Fingerprint', 'identity personal privacy accounts'],
  ],
  'Letters & numbers': [
    ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => [
      `letter-${letter.toLowerCase()}`,
      `Letter ${letter}`,
      'alphabet initial monogram character',
    ]),
    ...['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map(
      (name, number) => [`number-${number}`, `Number ${number}`, `${name} digit numeric character`],
    ),
  ],
};

export const folderIcons = Object.entries(categories).flatMap(([category, entries]) =>
  entries.map(([id, name, keywords]) => ({ id, name, category, keywords })),
);

export const folderColors = [
  ['gray', 'Grey', '#808080'],
  ['red', 'Red', '#e05252'],
  ['orange', 'Orange', '#d97828'],
  ['yellow', 'Yellow', '#b89616'],
  ['green', 'Green', '#45994d'],
  ['teal', 'Teal', '#249b87'],
  ['cyan', 'Cyan', '#229fbb'],
  ['blue', 'Blue', '#4c8de0'],
  ['indigo', 'Indigo', '#7a7be0'],
  ['purple', 'Purple', '#a16bd4'],
  ['pink', 'Pink', '#d45eaa'],
  ['brown', 'Brown', '#a77b56'],
].map(([id, name, color]) => ({ id, name, color }));

const iconIds = new Set(folderIcons.map(({ id }) => id));
const colors = new Map(folderColors.map(({ id, color }) => [id, color]));

export function normalizeGroupAppearance(value) {
  return {
    ...(iconIds.has(value?.icon) ? { icon: value.icon } : {}),
    ...(colors.has(value?.color) ? { color: value.color } : {}),
  };
}

export function requireGroupAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Choose a folder appearance.');
  if (value.icon != null && !iconIds.has(value.icon)) throw new Error('Choose a folder icon.');
  if (value.color != null && !colors.has(value.color)) throw new Error('Choose a folder colour.');
  return normalizeGroupAppearance(value);
}

export function folderAppearance(group, container, state) {
  const appearance = normalizeGroupAppearance(group?.appearance);
  // Resolve at render time so edits, resets and moves also update descendants.
  const inherited =
    !appearance.color && state
      ? groupPath(state, group?.parentId ?? null)
          .reverse()
          .find((parent) => colors.has(parent.appearance?.color))?.appearance.color
      : undefined;
  return {
    icon: appearance.icon,
    color: colors.get(appearance.color ?? inherited) ?? container?.colorCode,
  };
}

export function matchingFolderIcons(query = '', category = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  // A character query should find its glyph, rather than every keyword containing it.
  const character = /^(?:(?:letter|number|digit)\s+)?([a-z0-9])$/i.exec(query.trim())?.[1];
  const characterId = character
    ? `${/\d/.test(character) ? 'number' : 'letter'}-${character.toLowerCase()}`
    : undefined;
  return folderIcons.filter((item) => {
    const text = `${item.name} ${item.category} ${item.keywords}`.toLocaleLowerCase();
    return (
      (!category || item.category === category) &&
      (characterId ? item.id === characterId : words.every((word) => text.includes(word)))
    );
  });
}
