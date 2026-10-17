const paths = { settings: 'settings.html', activity: 'activity.html' };
const documentUrl = (url) => url?.split(/[?#]/)[0];

export function internalPage(api, url) {
  if (!url || !api.runtime?.getURL) return null;
  return (
    Object.keys(paths).find((page) => documentUrl(url) === api.runtime.getURL(paths[page])) ?? null
  );
}

// Call inside the controller queue so simultaneous clicks cannot create duplicates.
export async function openInternalPage(api, page, windowId, { claimingTabId, section } = {}) {
  if (!Object.hasOwn(paths, page)) throw new Error('Unknown Tabernacle page.');
  // Preferences are shared; activity describes the window it belongs to.
  const query = page === 'settings' ? {} : { windowId };
  const candidates = (await api.tabs.query(query)).filter(
    (tab) => !tab.incognito && internalPage(api, tab.url) === page,
  );
  // The oldest live page owns Settings, including when Firefox opens another
  // options tab for a URL whose fragment differs from the existing section.
  let tab;
  for (const existing of candidates.sort((a, b) => a.id - b.id)) {
    if (existing.id === claimingTabId) return { tabId: existing.id };
    try {
      // Do not set the URL: that would reset navigation, drafts and scroll position.
      tab = await api.tabs.update(existing.id, { active: true });
      break;
    } catch (error) {
      // A close animation can keep an invalid ID in query(). Confirm that it
      // has closed, then try the next candidate before creating a replacement.
      if ((await api.tabs.query(query)).some((tab) => tab.id === existing.id)) {
        const closed = await api.tabs.get(existing.id).then(
          () => false,
          (lookupError) => lookupError.message === `Invalid tab ID: ${existing.id}`,
        );
        if (!closed) throw error;
      }
    }
  }
  const suffix = page === 'settings' && section === 'new-tab' ? '#new-tab' : '';
  tab ??= await api.tabs.create({
    windowId,
    url: api.runtime.getURL(paths[page]) + suffix,
    active: true,
  });
  if (suffix)
    await api.runtime
      .sendMessage?.({ type: 'tabernacle:showSettingsSection', tabId: tab.id, section })
      .catch(() => {});
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
