import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Generate a self-contained snippet for the console of Tabernacle's sidebar.html.
// No mock adapter or modified extension rendering is involved.
async function setup(fixture) {
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

  if (!helper.url.startsWith(browser.runtime.getURL('sidebar.html')))
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
  await browser.windows.update(win.id, { ...fixture.window, state: 'normal' });
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
  // Keep earlier demo sessions usable when the canonical examples change.
  const legacyKeys = {
    music: 'youtube',
    torvehallerne: 'barr-review',
    smorrebrod: 'host-review',
  };
  for (const tab of await browser.tabs.query({ windowId: win.id })) {
    const savedKey = await browser.sessions.getTabValue(tab.id, marker);
    const key = legacyKeys[savedKey] || savedKey;
    if (key) existing.set(key, tab);
  }
  const tabs = {};
  for (const item of fixture.tabs) {
    const tab =
      existing.get(item.key) ||
      (await browser.tabs.create({
        windowId: win.id,
        url: item.url,
        active: false,
        pinned: Boolean(item.pinned),
        ...(item.container ? { cookieStoreId: containers[item.container] } : {}),
      }));
    if (existing.has(item.key)) {
      const changes = {};
      if (tab.url !== item.url) changes.url = item.url;
      if (tab.pinned !== Boolean(item.pinned)) changes.pinned = Boolean(item.pinned);
      if (Object.keys(changes).length) await browser.tabs.update(tab.id, changes);
    }
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
  await browser.tabs.remove(helper.id);
}

const fixture = JSON.parse(await readFile('assets/screenshots/screenshots.json', 'utf8'));
await mkdir('output/promo', { recursive: true });
await writeFile(
  'output/promo/setup-console.js',
  `(${setup.toString()})(${JSON.stringify(fixture)}).catch(error => { globalThis.tabernaclePromoSetupRunning = false; console.error(error); });\n`,
);
console.log('Paste output/promo/setup-console.js into the console of Tabernacle’s sidebar.html.');
