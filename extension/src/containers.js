// Firefox 142–152 do not expose the supported choices through the API.
const legacyColors = {
  blue: '#37adff',
  turquoise: '#00c79a',
  green: '#51cd00',
  yellow: '#ffcb00',
  orange: '#ff9f00',
  red: '#ff613d',
  pink: '#ff4bda',
  purple: '#af51f5',
  toolbar: '#7c7c7d',
};
const legacyIcons = [
  'fingerprint',
  'briefcase',
  'dollar',
  'cart',
  'circle',
  'gift',
  'vacation',
  'food',
  'fruit',
  'pet',
  'tree',
  'chill',
  'fence',
];

export function sortContainers(containers) {
  return [...containers].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  );
}

export function containerIconUrl({ icon, iconUrl }) {
  // Bundled masks include a fill fallback for contexts without Firefox's SVG context paint.
  return legacyIcons.includes(icon)
    ? new URL(`../icons/containers/${icon}.svg`, import.meta.url).href
    : iconUrl;
}

export async function containerChoices(api) {
  const identities = api.contextualIdentities;
  if (!identities?.query)
    throw new Error(
      'Container access is unavailable. Reload Tabernacle to enable its container permissions.',
    );
  const [colors, icons] = await Promise.all([
    identities.getSupportedColors
      ? identities.getSupportedColors()
      : Object.entries(legacyColors).map(([color, colorCode]) => ({ color, colorCode })),
    identities.getSupportedIcons
      ? identities.getSupportedIcons()
      : legacyIcons.map((icon) => ({
          icon,
          iconUrl: containerIconUrl({ icon }),
        })),
  ]);
  return { colors, icons };
}

export async function containerDetails(api, message) {
  const name = typeof message.name === 'string' ? message.name.trim() : '';
  if (!name) throw new Error('Enter a container name.');
  const { colors, icons } = await containerChoices(api);
  if (!colors.some(({ color }) => color === message.color))
    throw new Error('Choose a container colour.');
  if (!icons.some(({ icon }) => icon === message.icon)) throw new Error('Choose a container icon.');
  return { name, color: message.color, icon: message.icon };
}
