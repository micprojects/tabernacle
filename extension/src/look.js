// Keep the stored neutral theme ID compatible with existing preferences.
const themeSources = ['firefox', 'tabernacle'];
const colorSchemes = ['default', 'light', 'dark'];

export function normalizeLook(value) {
  return {
    connectingLines: value?.connectingLines !== false,
    domains: value?.domains === true,
    folderCounts: value?.folderCounts === true,
    tintFavicons: value?.tintFavicons === true,
    animations: value?.animations !== false,
    themeSource: themeSources.includes(value?.themeSource) ? value.themeSource : 'tabernacle',
    colorScheme: colorSchemes.includes(value?.colorScheme) ? value.colorScheme : 'default',
  };
}

export function requireLook(value) {
  if (!value || typeof value.connectingLines !== 'boolean' || typeof value.domains !== 'boolean')
    throw new Error('Choose whether to show connecting lines and domains.');
  if (value.folderCounts !== undefined && typeof value.folderCounts !== 'boolean')
    throw new Error('Choose whether to show folder tab counts.');
  if (value.animations !== undefined && typeof value.animations !== 'boolean')
    throw new Error('Choose whether to show animations.');
  if (value.tintFavicons !== undefined && typeof value.tintFavicons !== 'boolean')
    throw new Error('Choose whether to tint website icons.');
  if (value.colorScheme !== undefined && !colorSchemes.includes(value.colorScheme))
    throw new Error('Choose Automatic, Light or Dark for the colour mode.');
  if (value.themeSource !== undefined && !themeSources.includes(value.themeSource))
    throw new Error('Choose Neutral or Use Firefox theme for the theme.');
  return normalizeLook(value);
}
