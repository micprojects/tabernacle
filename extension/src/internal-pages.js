const paths = { settings: 'settings.html' };
const documentUrl = (url) => url?.split(/[?#]/)[0];

export function internalPage(api, url) {
  if (!url || !api.runtime?.getURL) return null;
  return (
    Object.keys(paths).find((page) => documentUrl(url) === api.runtime.getURL(paths[page])) ?? null
  );
}

// Call inside the controller queue so simultaneous clicks cannot create duplicates.
export async function openInternalPage(api, page, windowId, { claimingTabId } = {}) {
  if (!Object.hasOwn(paths, page)) throw new Error('Unknown Tabernacle page.');
  // Preferences are shared across windows.
  const query = {};
  const candidates = (await api.tabs.query(query)).filter(
    (tab) => !tab.incognito && internalPage(api, tab.url) === page,
  );
  // The oldest live page owns Settings, including when Firefox opens another
  // options tab for a URL whose fragment differs from the existing section.
  const existing = candidates.sort((a, b) => a.id - b.id)[0];
  if (existing && existing.id === claimingTabId) return { tabId: existing.id };
  let tab;
  if (existing) {
    try {
      // Do not set the URL: that would reset navigation, drafts and scroll position.
      tab = await api.tabs.update(existing.id, { active: true });
    } catch (error) {
      // The user may have closed the page between the query and activation.
      if ((await api.tabs.query(query)).some((tab) => tab.id === existing.id)) throw error;
    }
  }
  tab ??= await api.tabs.create({ windowId, url: api.runtime.getURL(paths[page]), active: true });
  await api.windows.update(tab.windowId, { focused: true });
  return { tabId: tab.id };
}

const demoPages = new Map();

export function openDemoPage(page) {
  let view = demoPages.get(page);
  if (view && !view.closed) view.focus();
  else {
    view = window.open(new URL(`../${paths[page]}?demo`, import.meta.url), `tabernacle-${page}`);
    if (view) demoPages.set(page, view);
  }
}
