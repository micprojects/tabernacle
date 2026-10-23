const booleans = [
  'enabled',
  'showSearch',
  'showFolders',
  'showLater',
  'showRecent',
  'weatherEnabled',
];

export function linkUrl(value) {
  let url;
  try {
    const text = String(value ?? '').trim();
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error('Enter a complete website address.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.href.length > 2048
  )
    throw new Error('Use an HTTP or HTTPS website address without a username or password.');
  return url.href;
}

// Only obvious web addresses navigate. Other input remains a search query.
export function searchAddress(value) {
  const text = value.trim();
  // Do not send a malformed explicit URL (or embedded credentials) to a search engine.
  if (/^https?:\/\//i.test(text)) return linkUrl(text);
  if (/\s/.test(text)) return null;
  try {
    const url = new URL(`https://${text}`);
    if (
      !url.hostname.includes('.') &&
      url.hostname !== 'localhost' &&
      !url.hostname.startsWith('[')
    )
      return null;
    if (url.username || url.password) return null;
    return linkUrl(url.href);
  } catch {
    return null;
  }
}

function locationValue(value) {
  if (
    !value ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 160 ||
    !Number.isFinite(value.latitude) ||
    Math.abs(value.latitude) > 90 ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.longitude) > 180
  )
    return null;
  return { name: value.name.trim(), latitude: value.latitude, longitude: value.longitude };
}

export function normalizeNewTab(value) {
  const seen = new Set();
  const links = [];
  for (const item of (Array.isArray(value?.links) ? value.links : []).slice(0, 60)) {
    try {
      if (
        typeof item?.id !== 'string' ||
        !item.id ||
        item.id.length > 80 ||
        seen.has(item.id) ||
        typeof item.name !== 'string' ||
        !item.name.trim() ||
        item.name.length > 80
      )
        continue;
      links.push({ id: item.id, name: item.name.trim(), url: linkUrl(item.url) });
      seen.add(item.id);
    } catch {
      /* Ignore invalid stored links without rendering unsafe URLs. */
    }
  }
  return {
    enabled: value?.enabled === true,
    links,
    showSearch: value?.showSearch !== false,
    showFolders: value?.showFolders !== false,
    showLater: value?.showLater !== false,
    showRecent: value?.showRecent !== false,
    colorScheme: ['inherit', 'light', 'dark'].includes(value?.colorScheme)
      ? value.colorScheme
      : 'inherit',
    linkStyle: value?.linkStyle === 'list' ? 'list' : 'icons',
    weatherEnabled: value?.weatherEnabled === true,
    location: locationValue(value?.location),
    unit: value?.unit === 'fahrenheit' ? 'fahrenheit' : 'celsius',
  };
}

export function requireNewTab(value) {
  if (!value || booleans.some((key) => typeof value[key] !== 'boolean'))
    throw new Error('Choose which new tab features to enable.');
  if (
    !['inherit', 'light', 'dark'].includes(value.colorScheme) ||
    !['icons', 'list'].includes(value.linkStyle) ||
    !['celsius', 'fahrenheit'].includes(value.unit)
  )
    throw new Error('Choose a supported new tab appearance and temperature unit.');
  const normalized = normalizeNewTab(value);
  if (
    !Array.isArray(value.links) ||
    value.links.length > 60 ||
    normalized.links.length !== value.links.length
  )
    throw new Error('Use up to 60 links, each with a unique ID, name and valid website address.');
  if (value.location !== null && !normalized.location)
    throw new Error('Choose a location from the search results.');
  if (value.weatherEnabled && !normalized.location)
    throw new Error('Choose a location before enabling weather.');
  return normalized;
}

export function isNewTabPage(api, url) {
  return Boolean(
    api.runtime?.getURL && url?.split(/[?#]/)[0] === api.runtime.getURL('new-tab.html'),
  );
}
