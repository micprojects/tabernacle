const colorSchemes = ['default', 'light', 'dark'];

export function normalizeLook(value) {
  return {
    connectingLines: value?.connectingLines !== false,
    domains: value?.domains === true,
    colorScheme: colorSchemes.includes(value?.colorScheme) ? value.colorScheme : 'default',
  };
}

export function requireLook(value) {
  if (!value || typeof value.connectingLines !== 'boolean' || typeof value.domains !== 'boolean')
    throw new Error('Choose whether to show connecting lines and domains.');
  if (value.colorScheme !== undefined && !colorSchemes.includes(value.colorScheme))
    throw new Error('Choose Default, Light or Dark for the colour mode.');
  return normalizeLook(value);
}
