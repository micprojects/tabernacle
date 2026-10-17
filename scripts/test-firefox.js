import assert from 'node:assert/strict';
import { Button, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { startFirefox } from './firefox-session.js';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { previewServer } from './preview.js';
import { MODEL_KEY, TAB_KEY } from '../extension/src/model.js';
import { PENDING_MOVE_KEY } from '../extension/src/move-recovery.js';

const server = await previewServer(0);
const url = `http://127.0.0.1:${server.address().port}/preview/index.html`;
let driver, session;
try {
  await mkdir('test-results', { recursive: true });
  session = await startFirefox({
    stdio: 'inherit',
    configure: (options) => options.setPreference('general.autoScroll', true),
  });
  driver = session.driver;
  await driver.manage().setTimeouts({ script: 20000, implicit: 0, pageLoad: 30000 });
  await driver.manage().window().setRect({ width: 1040, height: 850 });
  const addonId = await driver.installAddon(resolve('extension'), true);
  assert.equal(addonId, 'tabernacle@michaelprojects.com');
  await driver.setContext(firefox.Context.CHROME);
  const uuid = await driver.executeScript(
    'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
    addonId,
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(`moz-extension://${uuid}/sidebar.html`);
  await driver.wait(until.elementLocated(By.css('.tab-row')), 15000);
  console.log('✓ Manifest V3 add-on installed and live sidebar connected in Firefox');

  const send = async (type, args = {}) => {
    const result = await driver.executeAsyncScript(
      `const [type,args,done]=arguments; browser.windows.getCurrent().then(win=>browser.runtime.sendMessage({type:'tabernacle:'+type,windowId:win.id,...args})).then(done,error=>done({ok:false,error:error.message}));`,
      type,
      args,
    );
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };

  const browserCall = async (body, ...args) => {
    const result = await driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];(async()=>{${body}})().then(value=>done({ok:true,value}),error=>done({ok:false,error:error.message}));`,
      ...args,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  const reloadAddon = async () => {
    // Reload closes extension documents; keep WebDriver on a regular page.
    await driver.get('about:blank');
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');AddonManager.getAddonByID(arguments[0]).then(addon=>addon.reload()).then(()=>done(true),error=>done({error:error.message}));`,
      addonId,
    );
    await driver.setContext(firefox.Context.CONTENT);
    await driver.get(`moz-extension://${uuid}/sidebar.html`);
    await driver.wait(until.elementLocated(By.css('.tab-row')), 15000);
  };

  const sidebarHandle = await driver.getWindowHandle();
  await driver.findElement(By.id('settings')).click();
  const settingsHandle = await driver.wait(
    async () => (await driver.getAllWindowHandles()).find((handle) => handle !== sidebarHandle),
    5000,
  );
  await driver.switchTo().window(settingsHandle);
  await driver.wait(
    async () =>
      driver.executeScript('return !document.getElementById("appearance-fields")?.disabled;'),
    5000,
  );
  assert.equal(await driver.getCurrentUrl(), `moz-extension://${uuid}/settings.html`);
  const optionsManifest = await browserCall('return browser.runtime.getManifest().options_ui;');
  assert.equal(optionsManifest.open_in_tab, true);
  assert.equal(optionsManifest.page, `moz-extension://${uuid}/settings.html`);
  await driver.executeScript(`
    if (document.getElementById('look-theme-source')) throw new Error('Retired Theme selector is still present');
    const mode = document.getElementById('look-color-scheme');
    mode.value = 'dark'; mode.dispatchEvent(new Event('change', {bubbles:true}));
    document.querySelector('[name="domains"]').click();
    document.querySelector('[name="folderCounts"]').click();
  `);
  const settingsId = (await browserCall('return browser.tabs.getCurrent();')).id;
  await driver.findElement(By.css('a[href="#containers"]')).click();
  await driver.findElement(By.id('container-new')).click();
  await driver.findElement(By.id('container-name')).sendKeys('Unfinished container');
  await driver.executeScript('window.settingsVisit = "retained";');
  await driver.switchTo().window(sidebarHandle);
  assert.equal(
    (await send('snapshot')).tabs.some((tab) => tab.id === settingsId),
    false,
  );
  await driver.findElement(By.id('settings')).click();
  await driver.switchTo().window(settingsHandle);
  assert.equal(await driver.getCurrentUrl(), `moz-extension://${uuid}/settings.html#containers`);
  assert.equal(await driver.executeScript('return window.settingsVisit;'), 'retained');
  assert.equal(
    await driver.findElement(By.id('container-name')).getAttribute('value'),
    'Unfinished container',
  );
  await driver.findElement(By.css('#container-editor button[type="button"]')).click();
  await driver.findElement(By.css('a[href="#appearance"]')).click();
  assert.equal(await driver.findElement(By.id('appearance-status')).getText(), 'Unsaved changes');
  await driver.findElement(By.id('appearance-save')).click();
  await driver.wait(async () => (await send('getSettings')).look.domains, 5000);
  await driver.navigate().refresh();
  await driver.wait(
    async () =>
      driver.executeScript(
        'return document.querySelector("[name=domains]")?.checked && document.querySelector("[name=folderCounts]")?.checked && document.getElementById("look-color-scheme").value === "dark";',
      ),
    5000,
  );
  await writeFile('test-results/firefox-settings.png', await driver.takeScreenshot(), 'base64');
  await driver.switchTo().window(sidebarHandle);
  await driver.wait(
    async () =>
      driver.executeScript(
        'return document.getElementById("tree").classList.contains("show-domains") && document.getElementById("tree").classList.contains("show-folder-counts");',
      ),
    5000,
  );
  const tabCount = (await driver.getAllWindowHandles()).length;
  await browserCall('await browser.runtime.openOptionsPage(); return true;');
  await driver.wait(async () => (await driver.getAllWindowHandles()).length === tabCount, 5000);
  assert.equal((await driver.getAllWindowHandles()).length, tabCount);
  await driver.switchTo().window(settingsHandle);
  await driver.setContext(firefox.Context.CHROME);
  const optionsURL = await driver.executeAsyncScript(
    `
    const done=arguments[arguments.length-1];
    const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    AddonManager.getAddonByID(arguments[0]).then(addon=>done(addon.optionsURL));
  `,
    addonId,
  );
  assert.equal(optionsURL, `moz-extension://${uuid}/settings.html`);
  await driver.setContext(firefox.Context.CONTENT);
  await send('setLook', {
    value: {
      connectingLines: true,
      domains: false,
      colorScheme: 'default',
    },
  });
  await driver.close();
  await driver.switchTo().window(sidebarHandle);
  assert.equal(
    (await send('snapshot')).recentlyClosed.some((tab) => tab.url.includes('settings.html')),
    false,
  );
  await driver.findElement(By.id('settings')).click();
  const recreatedSettingsHandle = await driver.wait(
    async () => (await driver.getAllWindowHandles()).find((handle) => handle !== sidebarHandle),
    5000,
  );
  await driver.switchTo().window(recreatedSettingsHandle);
  await driver.wait(until.elementLocated(By.id('appearance-fields')), 5000);
  assert.notEqual((await browserCall('return browser.tabs.getCurrent();')).id, settingsId);
  await driver.close();
  await driver.switchTo().window(sidebarHandle);
  console.log(
    '✓ Settings stays out of the sidebar and history, preserves drafts on return, recreates after close and integrates with Add-ons Manager',
  );

  const originalActive = (await send('snapshot')).tabs.find((item) => item.active).id;
  const testPins = await browserCall(`
    const pins = [];
    for (let i = 0; i < 3; i++) pins.push(await browser.tabs.create({ pinned: true, active: false, url: 'about:blank' }));
    return pins.map(tab => tab.id);
  `);
  const pinOrder = async () =>
    (await send('snapshot')).tabs
      .filter((item) => item.pinned)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.id);

  async function pointerDrag(source, target, { x, y }) {
    const rect = await target.getRect();
    await driver
      .actions()
      .move({ origin: source })
      .press(Button.LEFT)
      .move({ origin: source, y: 8, duration: 100 })
      .move({
        origin: target,
        x: Math.round(x - rect.width / 2),
        y: Math.round(y - rect.height / 2),
        duration: 200,
      })
      .release(Button.LEFT)
      .perform();
  }

  const dragPin = async (sourceId, targetId, offset) => {
    const source = await driver.wait(
      until.elementLocated(By.css(`.pinned-tab[data-key="tab:${sourceId}"]`)),
      5000,
    );
    const target = await driver.wait(
      until.elementLocated(By.css(`.pinned-tab[data-key="tab:${targetId}"]`)),
      5000,
    );
    const rect = await target.getRect();
    await pointerDrag(source, target, { x: rect.width / 2 + offset, y: rect.height / 2 });
  };

  await dragPin(testPins[2], testPins[0], -10);
  await driver.wait(
    async () => (await pinOrder()).join() === [testPins[2], testPins[0], testPins[1]].join(),
    5000,
  );
  await dragPin(testPins[2], testPins[1], 10);
  await driver.wait(async () => (await pinOrder()).join() === testPins.join(), 5000);
  assert.equal((await send('snapshot')).tabs.find((item) => item.active).id, originalActive);
  await reloadAddon();
  assert.deepEqual(await pinOrder(), testPins);
  await browserCall('return browser.tabs.remove(arguments[0]);', testPins);
  console.log(
    '✓ Firefox pin drops reorder both directions without activation and survive extension reload',
  );

  const work = (await send('createGroup', { name: 'Work' })).createdGroupId;
  const design = (await send('createGroup', { name: 'Design', parentId: work })).createdGroupId;
  let tab = await browserCall('return browser.tabs.create({url:arguments[0],active:false});', url);
  await send('moveTab', { id: tab.id, groupId: design });
  let state = await send('snapshot');
  assert.equal(state.tabs.find((item) => item.id === tab.id).groupId, design);
  console.log('✓ Real tabs can be moved into nested groups');
  const child = await browserCall(
    'return browser.tabs.create({url:arguments[0],openerTabId:arguments[1],active:false});',
    url,
    tab.id,
  );
  const grandchild = await browserCall(
    'return browser.tabs.create({url:arguments[0],openerTabId:arguments[1],active:false});',
    url,
    child.id,
  );
  await driver.wait(async () => {
    const state = await send('snapshot');
    return state.tabs.find((item) => item.id === grandchild.id)?.parentTabId === child.id;
  }, 5000);
  state = await send('snapshot');
  assert.equal(state.tabs.find((item) => item.id === child.id).parentTabId, tab.id);
  assert.equal(state.tabs.find((item) => item.id === child.id).groupId, design);
  await send('toggleTab', { id: tab.id });
  assert((await send('snapshot')).tabs.find((item) => item.id === tab.id).collapsed);
  await send('toggleTab', { id: tab.id });
  console.log('✓ Firefox opener tabs create persistent child and grandchild trees');
  await driver.wait(until.elementLocated(By.css(`[data-key="group:${design}"]`)), 5000);
  await driver
    .actions()
    .doubleClick(await driver.findElement(By.css(`[data-key="group:${design}"] .label`)))
    .perform();
  await driver.wait(async () => {
    const current = await send('snapshot');
    return current.view.scopeId === design;
  }, 5000);
  assert.equal((await send('snapshot')).tabs.find((item) => item.active).groupId, design);
  console.log('✓ Double-click navigation activates a real member tab');
  const added = await send('newTab', { groupId: design });
  const newTab = added.tabs.find(
    (item) => ![tab.id, child.id, grandchild.id].includes(item.id) && item.groupId === design,
  );
  assert(newTab);
  await send('pinTab', { id: newTab.id });
  assert((await browserCall('return browser.tabs.get(arguments[0]);', newTab.id)).pinned);
  await send('muteTab', { id: newTab.id });
  assert((await browserCall('return browser.tabs.get(arguments[0]);', newTab.id)).mutedInfo.muted);
  console.log('✓ New tabs, pinning and muting use Firefox APIs successfully');
  for (const scopeId of [null, work, design]) {
    await send('enterGroup', { id: scopeId });
    const opened = await browserCall(
      'return browser.tabs.create({url:arguments[0],openerTabId:arguments[1],active:false,index:1});',
      url,
      newTab.id,
    );
    await driver.wait(async () => {
      const state = await send('snapshot');
      const tab = state.tabs.find((item) => item.id === opened.id);
      return tab?.groupId === scopeId && tab.parentTabId === null;
    }, 5000);
    await driver.wait(async () => {
      return (
        (await driver.executeScript(
          'return [...document.querySelectorAll("#tree > .tab-node > .tab-row")].at(-1)?.dataset.key;',
        )) === `tab:${opened.id}`
      );
    }, 5000);
  }
  console.log(
    '✓ Links from a Firefox pinned tab append at the bottom of Home or the entered folder',
  );
  const reordered = await browserCall(
    'return browser.tabs.create({url:arguments[0],active:false});',
    url,
  );
  await send('moveTab', { id: reordered.id, groupId: design });
  await send('pinTab', { id: tab.id });
  // Test the rendered tree: pinning promotes children without changing their saved ancestry.
  await driver.switchTo().window(await driver.getWindowHandle());
  await driver.wait(until.elementLocated(By.css(`.pinned-tab[data-key="tab:${tab.id}"]`)), 5000);
  const movingRow = By.css(`.tab-row[data-key="tab:${reordered.id}"]`);
  const childRow = By.css(`.tab-row[data-key="tab:${child.id}"]`);
  await driver.wait(until.elementLocated(childRow), 5000);
  await pointerDrag(await driver.findElement(movingRow), await driver.findElement(childRow), {
    x: 60,
    y: 2,
  });
  await driver.wait(async () => {
    const tabs = (await send('snapshot')).tabs;
    const moved = tabs.find((item) => item.id === reordered.id);
    return (
      moved.order < tabs.find((item) => item.id === child.id).order && moved.parentTabId === null
    );
  }, 5000);
  await send('pinTab', { id: tab.id });
  assert.equal(
    (await send('snapshot')).tabs.find((item) => item.id === reordered.id).parentTabId,
    null,
  );
  await driver
    .actions()
    .contextClick(await driver.findElement(movingRow))
    .perform();
  await driver.wait(until.elementIsVisible(await driver.findElement(By.id('menu'))), 5000);
  await browserCall('return browser.tabs.remove(arguments[0]);', reordered.id);
  await driver.wait(until.elementIsNotVisible(await driver.findElement(By.id('menu'))), 5000);
  console.log(
    '✓ Real Firefox reorders beside promoted children without nesting, and dismisses menus for closed tabs',
  );
  const containerState = await send('createContainer', {
    name: 'Tabernacle test',
    color: 'blue',
    icon: 'briefcase',
  });
  const identity = await browserCall(
    'return browser.contextualIdentities.get(arguments[0]);',
    containerState.createdCookieStoreId,
  );
  await send('updateContainer', {
    cookieStoreId: identity.cookieStoreId,
    name: 'Tabernacle renamed',
    color: 'purple',
    icon: 'tree',
  });
  const renamed = await browserCall(
    'return browser.contextualIdentities.get(arguments[0]);',
    identity.cookieStoreId,
  );
  assert.equal(renamed.name, 'Tabernacle renamed');
  assert.equal(renamed.color, 'purple');
  assert.equal(renamed.icon, 'tree');
  const disposable = await send('createContainer', {
    name: 'Unused',
    color: 'green',
    icon: 'circle',
  });
  await send('removeContainer', { cookieStoreId: disposable.createdCookieStoreId });
  const remaining = await browserCall('return browser.contextualIdentities.query({});');
  assert(!remaining.some((item) => item.cookieStoreId === disposable.createdCookieStoreId));
  console.log('✓ Container creation, editing and removal update real Firefox identities');
  const created = await send('newTab', { groupId: design, cookieStoreId: identity.cookieStoreId });
  const containerTab = created.tabs.find((item) => item.id === created.createdTabId);
  assert.equal(containerTab.cookieStoreId, identity.cookieStoreId);
  assert.equal(containerTab.groupId, design);
  assert.equal(containerTab.parentTabId, null);
  console.log('✓ New container tabs open in the chosen group with real Firefox identities');
  await send('setGroupContainer', { id: work, cookieStoreId: identity.cookieStoreId });
  const inherited = await send('newTab', { groupId: design });
  assert.equal(
    inherited.tabs.find((item) => item.id === inherited.createdTabId).cookieStoreId,
    identity.cookieStoreId,
  );
  const inheritedChild = await send('newChildTab', { id: child.id });
  const createdChild = inheritedChild.tabs.find((item) => item.active);
  assert.equal(createdChild.cookieStoreId, identity.cookieStoreId);
  assert.equal(createdChild.parentTabId, child.id);
  assert.equal(
    inheritedChild.tabs.find((item) => item.id === child.id).cookieStoreId,
    'firefox-default',
  );
  await send('setGroupContainer', { id: design, cookieStoreId: 'firefox-default' });
  const ordinary = await send('newTab', { groupId: design });
  assert.equal(
    ordinary.tabs.find((item) => item.id === ordinary.createdTabId).cookieStoreId,
    'firefox-default',
  );
  await send('setGroupContainer', { id: design, cookieStoreId: null });
  await send('setGroupContainer', { id: work, cookieStoreId: null });
  console.log(
    '✓ Real Firefox tabs inherit group containers; No container overrides and existing tabs retain their identities',
  );
  const nativeGroup = await browserCall(
    'return browser.tabs.group({tabIds:[arguments[0]]});',
    tab.id,
  );
  state = await send('reopenInContainer', { id: tab.id, cookieStoreId: identity.cookieStoreId });
  tab = state.tabs.find((item) => item.id === state.reopenedTabId);
  assert.equal(tab.cookieStoreId, identity.cookieStoreId);
  assert.equal(tab.nativeGroupId, nativeGroup);
  assert.equal(tab.groupId, design);
  assert.equal(state.tabs.find((item) => item.id === child.id).parentTabId, tab.id);
  const pinnedState = await send('reopenInContainer', {
    id: newTab.id,
    cookieStoreId: identity.cookieStoreId,
  });
  const reopenedPin = pinnedState.tabs.find((item) => item.id === pinnedState.reopenedTabId);
  assert(reopenedPin.pinned && reopenedPin.mutedInfo.muted);
  assert.equal(reopenedPin.cookieStoreId, identity.cookieStoreId);
  console.log('✓ Real container replacements preserve trees, native groups, pins and mute state');
  const parentRow = await driver.wait(
    until.elementLocated(By.css(`[data-key="tab:${tab.id}"] .tab-disclosure`)),
    5000,
  );
  await driver
    .actions()
    .move({ origin: parentRow })
    .press(Button.MIDDLE)
    .release(Button.MIDDLE)
    .perform();
  await driver.wait(
    async () => !(await send('snapshot')).tabs.some((item) => item.id === tab.id),
    5000,
  );
  assert.equal(await driver.findElement(By.id('dialog')).isDisplayed(), false);
  state = await send('snapshot');
  assert.equal(state.tabs.find((item) => item.id === child.id).parentTabId, null);
  assert.equal(state.tabs.find((item) => item.id === grandchild.id).parentTabId, child.id);
  await driver.wait(async () => (await send('snapshot')).canUndoClose, 5000);
  state = await send('undoCloseTab');
  const restored = { tab: state.tabs.find((item) => item.id === state.restoredTabId) };
  assert(restored.tab);
  assert.equal(state.tabs.find((item) => item.id === restored.tab.id).groupId, design);
  assert.equal(state.tabs.find((item) => item.id === child.id).parentTabId, restored.tab.id);
  console.log('✓ Firefox close/restore keeps group membership with a new tab ID');
  const pin = await driver.wait(
    until.elementLocated(By.css(`[data-key="tab:${reopenedPin.id}"]`)),
    5000,
  );
  await driver
    .actions()
    .move({ origin: pin })
    .press(Button.MIDDLE)
    .release(Button.MIDDLE)
    .perform();
  await driver.wait(
    async () => !(await send('snapshot')).tabs.some((item) => item.id === reopenedPin.id),
    5000,
  );
  console.log(
    '✓ Middle-click preserves parent branches and closes pinned leaves with Firefox autoscroll enabled',
  );
  await send('enterGroup', { id: design });
  await send('setLook', {
    value: { connectingLines: true, domains: true, colorScheme: 'dark' },
  });
  // Legacy saved records stay opaque, even if a newer/older format is unfamiliar.
  const legacy = await browserCall(
    `const key=arguments[0],model=(await browser.storage.local.get(key))[key];
    if(!Object.hasOwn(model,'stashes') || (Array.isArray(model.stashes) && model.stashes.length===0)){
      model.stashes=arguments[1];await browser.storage.local.set({[key]:model});
    }
    return model.stashes;`,
    MODEL_KEY,
    { unfamiliarVersion: 99, records: [{ url: 'https://example.com/legacy' }] },
  );
  await reloadAddon();
  state = await send('snapshot');
  assert.deepEqual(state.look, {
    animations: true,
    folderCounts: false,
    tintFavicons: false,
    connectingLines: true,
    domains: true,
    colorScheme: 'dark',
  });
  await driver.wait(
    async () =>
      (await driver.executeScript(
        'return getComputedStyle(document.documentElement).backgroundColor;',
      )) === 'rgb(32, 32, 32)',
    5000,
  );
  await driver.wait(
    async () =>
      (await driver.findElement(By.css('#tree')).getAttribute('class')).includes('show-domains'),
    5000,
  );
  assert(
    (await driver.findElement(By.css('#tree')).getAttribute('class')).includes(
      'show-connecting-lines',
    ),
  );
  await driver.wait(until.elementLocated(By.css('.tab-row .row-detail')), 5000);
  console.log('✓ Look preferences persist through extension reload');
  for (const colorScheme of ['light', 'default', 'dark']) {
    await send('setLook', { value: { ...state.look, colorScheme } });
    await driver.wait(async () => {
      const palette = await driver.executeScript(`return {
        mode: document.documentElement.dataset.colorScheme,
        background: getComputedStyle(document.documentElement).backgroundColor,
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches
      };`);
      const dark = colorScheme === 'dark' || (colorScheme === 'default' && palette.prefersDark);
      return (
        palette.mode === colorScheme &&
        palette.background === (dark ? 'rgb(32, 32, 32)' : 'rgb(255, 255, 255)')
      );
    }, 5000);
  }
  console.log(
    '✓ Real Firefox applies compact Light/Dark palettes and Default follows its reported preference',
  );
  assert.equal(state.view.scopeId, design);
  assert.equal(state.tabs.find((item) => item.id === restored.tab.id).groupId, design);
  assert.equal(state.tabs.find((item) => item.id === child.id).parentTabId, restored.tab.id);
  console.log('✓ Reloading the actual extension preserves groups, scope and memberships');
  const before = state.tabs.length;
  state = await send('moveGroupContents', { id: design, groupId: work });
  assert.equal(state.tabs.length, before);
  assert.equal(state.tabs.find((item) => item.id === restored.tab.id).groupId, work);
  console.log('✓ Moving group contents keeps real Firefox tabs open');
  assert.deepEqual(
    await browserCall(
      'return (await browser.storage.local.get(arguments[0]))[arguments[0]].stashes;',
      MODEL_KEY,
    ),
    legacy,
  );
  console.log('✓ Legacy saved records survive reload and live group changes untouched');

  // Seed the durable state left by an interruption after the first membership
  // write. Unit tests cover every boundary; this checks real Firefox sessions.
  await send('enterGroup', { id: null });
  const branchIds = [restored.tab.id, child.id, grandchild.id];
  const branchBefore = state.tabs.filter((item) => branchIds.includes(item.id));
  await browserCall(
    `const [ids,tabKey,moveKey,groupId]=arguments;
    const changes=await Promise.all(ids.map(async id=>{const before=await browser.sessions.getTabValue(id,tabKey);return {treeId:before.treeId,before,after:{...before,groupId}};}));
    await browser.storage.local.set({[moveKey]:{version:1,direction:'after',changes,groups:null}});
    await browser.sessions.setTabValue(ids[0],tabKey,changes[0].after);`,
    branchIds,
    TAB_KEY,
    PENDING_MOVE_KEY,
    design,
  );
  await reloadAddon();
  state = await send('snapshot');
  for (const before of branchBefore) {
    const after = state.tabs.find((item) => item.id === before.id);
    assert.equal(after.groupId, design);
    for (const key of ['windowId', 'url', 'treeId', 'parentTabId', 'order'])
      assert.equal(after[key], before[key]);
    assert.deepEqual(after.ancestors, before.ancestors);
  }
  assert.equal(
    await browserCall(
      'return (await browser.storage.local.get(arguments[0]))[arguments[0]];',
      PENDING_MOVE_KEY,
    ),
    null,
  );
  console.log('✓ Interrupted moves finish after real extension reload without replacing pages');
  await send('moveGroupContents', { id: design, groupId: work });
  state = await send('removeGroup', {
    id: design,
    ...(await send('getGroupContents', { id: design })),
  });
  assert(!state.groups.some((group) => group.id === design));
  const doomed = (await send('createGroup', { name: 'Delete check' })).createdGroupId;
  const doomedChild = (await send('createGroup', { name: 'Nested delete check', parentId: doomed }))
    .createdGroupId;
  const doomedDeep = (
    await send('createGroup', { name: 'Deep delete check', parentId: doomedChild })
  ).createdGroupId;
  const directTab = (await send('newTab', { groupId: doomed })).createdTabId;
  const pinnedTab = (await send('newTab', { groupId: doomedChild })).createdTabId;
  await send('pinTab', { id: pinnedTab });
  const otherWindow = await browserCall(
    'return browser.windows.create({url:"about:blank",focused:false});',
  );
  const otherTab = otherWindow.tabs[0].id;
  await send('moveTab', { id: otherTab, groupId: doomedDeep, windowId: otherWindow.id });
  const contents = await send('getGroupContents', { id: doomed });
  assert.deepEqual(new Set(contents.tabIds), new Set([directTab, pinnedTab, otherTab]));
  assert.equal(contents.pinnedCount, 1);
  state = await send('removeGroup', { id: doomed, ...contents });
  assert(!state.groups.some((group) => contents.groupIds.includes(group.id)));
  const remainingTabs = await browserCall('return browser.tabs.query({});');
  assert(!remainingTabs.some((item) => contents.tabIds.includes(item.id)));
  assert(remainingTabs.some((item) => item.id === restored.tab.id));
  console.log(
    '✓ Deletion closes real tabs, pins and other-window subgroup tabs and removes the complete subtree',
  );
  await send('enterGroup', { id: null });
  // Capture the installed sidebar itself at a realistic narrow viewport.
  await driver.manage().window().setRect({ width: 450, height: 860 });
  await driver.wait(until.elementLocated(By.css(`[data-key="group:${work}"]`)), 5000);
  await send('setGroupContainer', { id: work, cookieStoreId: identity.cookieStoreId });
  await send('setGroupAppearance', { id: work, appearance: { icon: 'plane', color: 'teal' } });
  await reloadAddon();
  await driver.wait(
    () =>
      driver.executeScript(
        `const glyph=document.querySelector('[data-key="group:${work}"] .folder-glyph');
       return glyph?.dataset.icon === 'plane-16' && glyph.getBBox().width > 0;`,
      ),
    5000,
  );
  assert.deepEqual((await send('snapshot')).groups.find((group) => group.id === work).appearance, {
    icon: 'plane',
    color: 'teal',
  });
  await driver
    .actions()
    .contextClick(await driver.findElement(By.css(`[data-key="group:${work}"]`)))
    .perform();
  await driver
    .findElement(By.xpath('//button[@role="menuitem" and text()="Icon and colour…"]'))
    .click();
  await driver.findElement(By.css('input[aria-label="Find an icon"]')).sendKeys('holiday');
  await driver.findElement(By.css('[role="radio"][aria-label="Plane"]')).click();
  assert(
    await driver.executeScript(
      'const dialog=document.getElementById("dialog"); dialog.scrollTop=0; return dialog.scrollWidth<=dialog.clientWidth;',
    ),
  );
  await writeFile(
    'test-results/firefox-folder-appearance.png',
    await driver.takeScreenshot(),
    'base64',
  );
  await driver.findElement(By.css('.appearance-reset')).click();
  await driver.findElement(By.id('dialog-submit')).click();
  await driver.wait(
    () =>
      driver.executeScript(
        `return !!document.querySelector('[data-key="group:${work}"] .group-container-icon');`,
      ),
    5000,
  );
  assert.equal(
    (await send('snapshot')).groups.find((group) => group.id === work).appearance,
    undefined,
  );
  console.log(
    '✓ Acorn folder icons render and persist in Firefox; the searchable picker restores the native container',
  );
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/firefox-extension.png', await driver.takeScreenshot(), 'base64');
  console.log('Real-Firefox checks passed.');
} catch (error) {
  if (driver) {
    await driver.takeScreenshot().then(
      (png) => writeFile('test-results/firefox-failure.png', png, 'base64'),
      () => {},
    );
  }
  throw error;
} finally {
  try {
    await session?.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
