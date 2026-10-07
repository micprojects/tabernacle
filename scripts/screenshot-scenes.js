export async function setupScreenshotDemo(
  fixture,
  { closeHelper = true, resizeWindow = true } = {},
) {
  if (globalThis.tabernaclePromoSetupRunning) throw new Error('Demo setup is already running.');
  globalThis.tabernaclePromoSetupRunning = true;
  const marker = 'tabernacle-promo-tab-v1';
  const win = await browser.windows.getCurrent();
  const helper = await browser.tabs.getCurrent();

  const send = async (type, args = {}) => {
    const result = await browser.runtime.sendMessage({
      type: `tabernacle:${type}`,
      windowId: win.id,
      ...args,
    });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };

  if (location.href !== browser.runtime.getURL('sidebar.html'))
    throw new Error('Run this only in the Tabernacle sidebar document in the Tabernacle profile.');
  const groups = Object.fromEntries(fixture.groups.map((group) => [group.key, group.id]));
  const identities = await browser.contextualIdentities.query({});
  const containers = {};
  for (const item of fixture.containers) {
    const identity =
      identities.find((identity) => identity.name === item.name) ||
      (await browser.contextualIdentities.create({
        name: item.name,
        color: item.color,
        icon: item.icon,
      }));
    containers[item.key] = identity.cookieStoreId;
  }
  const before = await send('snapshot');
  await browser.storage.local.set({
    'tabernacle-promo-before': { look: before.look, view: before.view, window: win },
  });
  if (resizeWindow) await browser.windows.update(win.id, { ...fixture.window, state: 'normal' });
  await send('enterGroup', { id: null });
  for (const group of fixture.groups) {
    await send('createGroup', {
      id: group.id,
      name: group.name,
      parentId: groups[group.parent] || null,
    });
    if (group.container)
      await send('setGroupContainer', {
        id: group.id,
        cookieStoreId: containers[group.container],
      });
  }
  const existing = new Map();
  const windowTabs = await browser.tabs.query({ windowId: win.id });
  // Keep earlier demo sessions usable when the canonical examples change.
  const legacyKeys = {
    music: 'youtube',
    torvehallerne: 'barr-review',
    smorrebrod: 'host-review',
  };
  for (const tab of windowTabs) {
    const savedKey = await browser.sessions.getTabValue(tab.id, marker);
    const key = legacyKeys[savedKey] || savedKey;
    if (key) existing.set(key, tab);
  }
  const claimed = new Set([...existing.values()].map((tab) => tab.id));
  const sameUrl = (a, b) => a.replace(/\/$/, '') === b.replace(/\/$/, '');
  const tabs = {};
  for (const item of fixture.tabs) {
    // Temporary add-on reloads can lose session markers while pinned tabs survive.
    const reusable =
      existing.get(item.key) ||
      (item.pinned &&
        windowTabs.find((tab) => tab.pinned && !claimed.has(tab.id) && sameUrl(tab.url, item.url)));
    const tab =
      reusable ||
      (await browser.tabs.create({
        windowId: win.id,
        url: item.url,
        active: false,
        pinned: Boolean(item.pinned),
        ...(item.container ? { cookieStoreId: containers[item.container] } : {}),
      }));
    if (reusable) {
      const changes = {};
      if (tab.url !== item.url) changes.url = item.url;
      if (tab.pinned !== Boolean(item.pinned)) changes.pinned = Boolean(item.pinned);
      if (Object.keys(changes).length) await browser.tabs.update(tab.id, changes);
    }
    claimed.add(tab.id);
    tabs[item.key] = tab.id;
    await browser.sessions.setTabValue(tab.id, marker, item.key);
    await send('moveTab', { id: tab.id, groupId: groups[item.group] || null });
    if (item.parent) await send('nestTab', { id: tab.id, parentTabId: tabs[item.parent] });
  }
  await send('setLook', {
    value: { connectingLines: true, domains: false, colorScheme: 'light' },
  });
  await send('enterGroup', { id: null });
  const current = await send('snapshot');
  const collapse = new Set(fixture.shots[0].collapsedGroups.map((key) => groups[key]));
  for (const group of fixture.groups) {
    if (current.view.collapsed.includes(group.id) !== collapse.has(group.id))
      await send('toggleGroup', { id: group.id });
  }
  await browser.storage.local.set({ 'tabernacle-promo-session': { version: 1, groups, tabs } });
  await browser.tabs.update(tabs[fixture.activeTab], { active: true });
  // Only close the helper document that executed this setup. Keep all other tabs.
  if (closeHelper && helper) await browser.tabs.remove(helper.id);
  return { version: 1, groups, tabs };
}

// Runs in the real extension document through Firefox's in-process DevTools API.
export async function showScreenshotScene(fixture, session, index) {
  const shot = fixture.shots[index];
  const windowId = (await browser.windows.getCurrent()).id;

  const send = async (type, args = {}) => {
    const result = await browser.runtime.sendMessage({
      type: `tabernacle:${type}`,
      windowId,
      ...args,
    });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };

  const waitFor = async (condition, label) => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  if (document.querySelector('#dialog').open) document.querySelector('#dialog-cancel').click();
  if (document.querySelector('#search-toggle').getAttribute('aria-expanded') === 'true')
    document.querySelector('#search-close').click();
  const scopeId = session.groups[shot.scope] || null;
  await send('enterGroup', { id: scopeId });
  await send('setLook', {
    value: {
      connectingLines: true,
      domains: Boolean(shot.domains),
      colorScheme: shot.colorScheme,
    },
  });
  const state = await send('snapshot');
  const collapsed = new Set((shot.collapsedGroups || []).map((key) => session.groups[key]));
  for (const id of Object.values(session.groups))
    if (state.view.collapsed.includes(id) !== collapsed.has(id)) await send('toggleGroup', { id });
  for (const tab of state.tabs)
    if (Object.values(session.tabs).includes(tab.id) && tab.collapsed)
      await send('toggleTab', { id: tab.id });
  await browser.tabs.update(session.tabs[fixture.activeTab], { active: true });
  await waitFor(
    () =>
      document.querySelector(`[data-key="tab:${session.tabs[fixture.activeTab]}"]`) &&
      document.documentElement.dataset.colorScheme === shot.colorScheme &&
      Boolean(document.querySelector('#home[aria-current]')) === !scopeId,
    'the sidebar scene',
  );
  document.querySelector(`[data-key="tab:${session.tabs[fixture.activeTab]}"]`).click();
  if (shot.search) {
    document.querySelector('#search-toggle').click();
    const input = document.querySelector('#search');
    input.value = shot.search;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(
      () => !document.querySelector(`[data-key="tab:${session.tabs[fixture.activeTab]}"]`),
      'search results',
    );
  }
  if (shot.menu) {
    const row = document.querySelector(`[data-key="group:${session.groups[shot.menuGroup]}"]`);
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 70, clientY: 130 }));
    await waitFor(() => !document.querySelector('#menu').hidden, 'the folder menu');
    const button = [...document.querySelectorAll('#menu button')].find((item) =>
      item.textContent.includes(shot.menu),
    );
    if (!button) throw new Error(`Cannot find the ${shot.menu} menu item`);
    button.click();
    await waitFor(() => document.querySelector('#dialog').open, 'the folder dialog');
  }
  document.querySelector('#tree').scrollTop = 0;
  await document.fonts.ready;
  await Promise.all([...document.querySelectorAll('img')].map((image) => image.decode()));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { scene: shot.file, width: innerWidth, height: innerHeight };
}

export function measureScreenshotRegion(framing) {
  const rect = (selector) => {
    const element = [...document.querySelectorAll(selector)]
      .filter((node) => node.getClientRects().length)
      .at(-1);
    if (!element) throw new Error(`Screenshot framing element not found: ${selector}`);
    return element.getBoundingClientRect().toJSON();
  };

  return {
    element: framing.element ? rect(framing.element) : null,
    top: framing.top ? rect(framing.top) : null,
    bottom: framing.bottom ? rect(framing.bottom) : null,
    viewport: { width: innerWidth, height: innerHeight },
    treeBottom: document.querySelector('#tree').getBoundingClientRect().bottom,
  };
}
