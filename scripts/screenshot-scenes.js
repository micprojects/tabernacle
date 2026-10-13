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
    value: {
      connectingLines: true,
      domains: false,
      themeSource: 'firefox',
      colorScheme: 'default',
    },
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
  globalThis.tabernacleScreenshotRestoreActivityTimes?.();
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
  if (document.querySelector('#recently-closed-toggle').getAttribute('aria-expanded') === 'true')
    document.querySelector('#recently-closed-toggle').click();
  if (document.querySelector('#search-toggle').getAttribute('aria-expanded') === 'true')
    document.querySelector('#search-close').click();
  const scopeId = session.groups[shot.scope] || null;
  await send('enterGroup', { id: scopeId });
  await send('setLook', {
    value: {
      connectingLines: true,
      domains: Boolean(shot.domains),
      themeSource: 'firefox',
      colorScheme: 'default',
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
      document.documentElement.dataset.firefoxTheme === 'default' &&
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
  if (shot.activity) {
    // Generate history through real actions in this demo session. Run this scene
    // after the tree captures, since closed demo tabs stay closed.
    for (const { kind, key } of shot.activity) {
      if (kind === 'folder') await send('enterGroup', { id: session.groups[key] });
      else if (kind === 'viewed') await browser.tabs.update(session.tabs[key], { active: true });
      else if (kind === 'closed') await browser.tabs.remove(session.tabs[key]);
      else throw new Error(`Unsupported screenshot activity: ${kind}`);
      // Keep Firefox session timestamps distinct and their ordering repeatable.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (shot.activityMinutesAgo) {
      // Fixture only the ages of these real demo records at the API boundary.
      // The unchanged popup sorts the records and formats its own time labels.
      const now = Date.now();
      const ages = shot.activityMinutesAgo;
      const timestamp = (kind, key, fallback = 120) =>
        now - (ages[kind]?.[key] ?? fallback) * 60000;
      const tabKeys = new Map(Object.entries(session.tabs).map(([key, id]) => [id, key]));
      const groupKeys = new Map(Object.entries(session.groups).map(([key, id]) => [id, key]));
      const urlKeys = new Map(fixture.tabs.map(({ key, url }) => [url, key]));
      const originalSend = browser.runtime.sendMessage;
      browser.runtime.sendMessage = async (...args) => {
        const result = await originalSend.apply(browser.runtime, args);
        const data = result?.ok && result.data;
        if (data?.tabs && data.view) {
          for (const tab of data.tabs) tab.lastAccessed = timestamp('viewed', tabKeys.get(tab.id));
          for (const tab of data.recentlyClosed ?? [])
            tab.closedAt = timestamp('closed', urlKeys.get(tab.url));
          for (const folder of data.view.recentFolders ?? [])
            folder.enteredAt = timestamp('folder', groupKeys.get(folder.id));
          for (const folder of data.view.recentExpandedFolders ?? [])
            folder.expandedAt = timestamp('folder', groupKeys.get(folder.id));
        }
        return result;
      };
      globalThis.tabernacleScreenshotRestoreActivityTimes = () => {
        browser.runtime.sendMessage = originalSend;
        delete globalThis.tabernacleScreenshotRestoreActivityTimes;
      };
    }
    document.querySelector('#recently-closed-toggle').click();
    await waitFor(() => {
      const rows = [...document.querySelectorAll('.recently-closed-row')].slice(0, 10);
      return (
        !document.querySelector('#recently-closed').hidden &&
        rows.length === 10 &&
        (!shot.activityMinutesAgo ||
          new Set(rows.map((row) => row.querySelector('time').textContent)).size >= 4) &&
        ['viewed', 'closed', 'folder'].every((kind) =>
          rows.some((row) => row.dataset.kind === kind),
        )
      );
    }, 'viewed tabs, closed tabs and folders in recent activity');
    document.activeElement.blur();
  }
  document.querySelector('#tree').scrollTop = 0;
  await document.fonts.ready;
  await Promise.all([...document.querySelectorAll('img')].map((image) => image.decode()));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const surface = getComputedStyle(document.querySelector('.sidebar'));
  return {
    scene: shot.file,
    width: innerWidth,
    height: innerHeight,
    theme: document.documentElement.dataset.firefoxTheme,
    colorScheme: document.documentElement.dataset.colorScheme,
    background: surface.backgroundColor,
    gradient: surface.backgroundImage,
    ...(shot.activity
      ? {
          activity: [...document.querySelectorAll('.recently-closed-row')]
            .slice(0, 10)
            .map((row) => ({
              kind: row.dataset.kind,
              title: row.querySelector('.recently-closed-label').textContent,
              time: row.querySelector('time').textContent,
            })),
        }
      : {}),
  };
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
