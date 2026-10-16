const colorSchemes = ['default', 'light', 'dark'];

export function normalizeLook(value) {
  return {
    connectingLines: value?.connectingLines !== false,
    domains: value?.domains === true,
    folderCounts: value?.folderCounts === true,
    tintFavicons: value?.tintFavicons === true,
    animations: value?.animations !== false,
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
  return normalizeLook(value);
}
