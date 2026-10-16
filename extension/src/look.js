// Keep the stored neutral theme ID compatible with existing preferences.
const themeSources = ['firefox', 'tabernacle'];
const colorSchemes = ['default', 'light', 'dark'];

export function normalizeLook(value) {
  return {
    connectingLines: value?.connectingLines !== false,
    domains: value?.domains === true,
    themeSource: themeSources.includes(value?.themeSource) ? value.themeSource : 'tabernacle',
    colorScheme: colorSchemes.includes(value?.colorScheme) ? value.colorScheme : 'default',
  };
}

export function requireLook(value) {
  if (!value || typeof value.connectingLines !== 'boolean' || typeof value.domains !== 'boolean')
    throw new Error('Choose whether to show connecting lines and domains.');
  if (value.colorScheme !== undefined && !colorSchemes.includes(value.colorScheme))
    throw new Error('Choose Automatic, Light or Dark for the colour mode.');
  if (value.themeSource !== undefined && !themeSources.includes(value.themeSource))
    throw new Error('Choose Neutral or Use Firefox theme for the theme.');
  return normalizeLook(value);
}
