const colorSchemes = ['default', 'light', 'dark'];
const sidebarSizes = ['default', 'comfortable', 'large'];

export function normalizeLook(value) {
  return {
    connectingLines: value?.connectingLines !== false,
    domains: value?.domains === true,
    folderCounts: value?.folderCounts === true,
    tintFavicons: value?.tintFavicons === true,
    animations: value?.animations !== false,
    colorScheme: colorSchemes.includes(value?.colorScheme) ? value.colorScheme : 'default',
    sidebarSize: sidebarSizes.includes(value?.sidebarSize) ? value.sidebarSize : 'default',
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
  if (value.sidebarSize !== undefined && !sidebarSizes.includes(value.sidebarSize))
    throw new Error('Choose Compact, Comfortable or Large for the sidebar size.');
  return normalizeLook(value);
}
