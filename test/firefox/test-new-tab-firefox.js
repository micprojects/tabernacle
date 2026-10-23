import assert from 'node:assert/strict';
import { By, Key } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { startFirefox } from "../../scripts/firefox-session.js";
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { WEATHER_ACCESS } from "../../extension/src/new-tab/weather.js";

const session = await startFirefox();
const driver = session.driver;
try {
  await driver.manage().setTimeouts({ script: 20000, pageLoad: 30000 });
  await driver.manage().window().setRect({ width: 1440, height: 1000 });
  const addonId = await driver.installAddon(resolve('extension'), true);
  await driver.setContext(firefox.Context.CHROME);
  const uuid = await driver.executeScript(
    'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
    addonId,
  );
  const root = `moz-extension://${uuid}/`;
  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(`${root}new-tab.html?preview=1`);

  const call = async (body, ...args) => {
    const result = await driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];(async()=>{${body}})().then(value=>done({ok:true,value}),error=>done({ok:false,error:error.message}));`,
      ...args,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  const send = (type, args = {}) =>
    call(
      `const [type,args]=arguments;const {windowId}=await browser.tabs.getCurrent();const result=await browser.runtime.sendMessage({type:'tabernacle:'+type,windowId,...args});if(!result.ok)throw new Error(result.error);return result.data;`,
      type,
      args,
    );
  await driver.wait(
    async () => !(await driver.findElement(By.id('links-section')).getAttribute('hidden')),
    10000,
  );
  assert.equal((await send('getSettings')).newTab.enabled, false);
  await send('setNewTab', { value: { enabled: true } });
  const own = await driver.getWindowHandle();
  // Exercise the actual command used by Firefox's new-tab button and shortcut.
  await driver.setContext(firefox.Context.CHROME);
  const command = await driver.executeScript(
    `const command=document.getElementById('cmd_newNavigatorTab');if(!command)throw new Error('Missing new-tab command');command.doCommand();return true;`,
  );
  assert(command);
  await driver.wait(
    async () =>
      (await driver.executeScript('return gBrowser.selectedBrowser.currentURI.spec;')).startsWith(
        `${root}new-tab.html`,
      ),
    10000,
  );
  await driver.setContext(firefox.Context.CONTENT);
  const handles = await driver.getAllWindowHandles();
  await driver.switchTo().window(handles.find((id) => id !== own));
  await driver.wait(
    async () => (await driver.getCurrentUrl()).startsWith(`${root}new-tab.html`),
    10000,
  );
  await driver.wait(
    async () => !(await driver.findElement(By.id('links-section')).getAttribute('hidden')),
    10000,
  );
  const activeHandle = await driver.getWindowHandle();
  await driver.wait(
    async () => await driver.executeScript("return document.activeElement?.id==='search';"),
    10000,
  );
  await driver.actions().sendKeys('example.test').perform();
  assert.equal(await driver.findElement(By.id('search')).getAttribute('value'), 'example.test');
  await driver.findElement(By.id('search')).clear();
  const modifier = process.platform === 'darwin' ? Key.META : Key.CONTROL;
  await driver.setContext(firefox.Context.CHROME);
  await driver
    .actions()
    .keyDown(modifier)
    .sendKeys('l')
    .keyUp(modifier)
    .sendKeys('example.test')
    .perform();
  await driver.setContext(firefox.Context.CHROME);
  assert.equal(
    await driver.executeScript('return gURLBar.value;'),
    'example.test',
    'The address-bar shortcut replaces the URL normally',
  );
  await driver.actions().sendKeys(Key.ESCAPE).perform();
  // Use Firefox's selected search engine, without guessing its URL or name.
  await driver.setContext(firefox.Context.CHROME);
  const expectedSearch = await driver.executeAsyncScript(
    `const done=arguments[arguments.length-1];const search=Services.search||ChromeUtils.importESModule('moz-src:///toolkit/components/search/SearchService.sys.mjs').SearchService;(async()=>{if(search.init)await search.init();else await search.promiseInitialized;return (await search.getDefault()).getSubmission('Tabernacle new tab test').uri.spec;})().then(done);`,
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.findElement(By.id('search')).sendKeys('Tabernacle new tab test', Key.ENTER);
  await driver.wait(async () => {
    const actual = new URL(await driver.getCurrentUrl());
    return (
      actual.origin === new URL(expectedSearch).origin &&
      [...actual.searchParams.values()].includes('Tabernacle new tab test')
    );
  }, 15000);
  await driver.get(`${root}new-tab.html`);
  await driver.wait(async () => !(await driver.findElement(By.id('loading')).isDisplayed()), 10000);

  // Customise opens the dedicated section; saving and previewing work in Firefox.
  await driver.findElement(By.id('customise')).click();
  const settingsHandle = await driver.wait(
    async () => (await driver.getAllWindowHandles()).find((id) => !handles.includes(id)),
    10000,
  );
  await driver.switchTo().window(settingsHandle);
  assert.equal(await driver.getCurrentUrl(), `${root}settings.html#new-tab`);
  await driver.wait(
    async () => await driver.findElement(By.id('new-tab-add-link')).isEnabled(),
    10000,
  );
  await driver.findElement(By.id('new-tab-add-link')).click();
  await driver.findElement(By.id('nt-link-name')).sendKeys('Example');
  await driver.findElement(By.id('nt-link-url')).sendKeys('https://example.com/');
  await driver.findElement(By.id('nt-link-submit')).click();
  await driver.findElement(By.id('new-tab-save')).click();
  await driver.wait(
    async () =>
      (await driver.findElement(By.id('new-tab-status')).getText()) === 'All changes saved',
    10000,
  );
  await driver.navigate().refresh();
  await driver.wait(
    async () => (await driver.findElement(By.id('new-tab-links')).getText()).includes('Example'),
    10000,
  );
  await send('openPage', { page: 'settings', section: 'new-tab' });
  assert.equal(
    (await driver.getAllWindowHandles()).length,
    handles.length + 1,
    'Customise reuses settings',
  );
  const beforePreview = await driver.getAllWindowHandles();
  await driver.findElement(By.id('new-tab-preview')).click();
  const previewHandle = await driver.wait(
    async () => (await driver.getAllWindowHandles()).find((id) => !beforePreview.includes(id)),
    10000,
  );
  await driver.switchTo().window(previewHandle);
  await driver.wait(
    async () => (await driver.findElement(By.id('links')).getText()).includes('Example'),
    10000,
  );
  assert(await driver.findElement(By.id('preview-notice')).isDisplayed());
  await driver.close();
  await driver.switchTo().window(activeHandle);

  // Exercise optional origin and data permissions in this disposable profile.
  assert.equal(
    await call('return browser.permissions.contains(arguments[0]);', WEATHER_ACCESS),
    false,
  );
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeAsyncScript(
    `const [id,access,done]=arguments;const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');ExtensionPermissions.add(id,{permissions:[],...access},WebExtensionPolicy.getByID(id).extension).then(()=>done(true));`,
    addonId,
    WEATHER_ACCESS,
  );
  await driver.setContext(firefox.Context.CONTENT);
  assert.equal(
    await call('return browser.permissions.contains(arguments[0]);', WEATHER_ACCESS),
    true,
  );
  const location = {
    name: 'Manchester, England, United Kingdom',
    latitude: 53.48,
    longitude: -2.24,
  };
  const seedWeather = () =>
    call(
      `await browser.storage.local.set({'tabernacle.weather.v1': {key:'53.48,-2.24',temperature:14,high:15,low:9,code:3,fetchedAt:Date.now()}});`,
    );
  if (process.env.TABERNACLE_LIVE_WEATHER !== '1') await seedWeather();
  await send('setNewTab', { value: { weatherEnabled: true, location } });
  if (process.env.TABERNACLE_LIVE_WEATHER === '1') {
    const locations = await send('weatherLocations', { query: 'Manchester' });
    assert(locations.some((place) => place.name.includes('Manchester')));
    assert(Number.isFinite((await send('weatherCurrent')).temperature));
    console.log('✓ Live Open-Meteo location lookup and forecast succeeded');
  }
  await seedWeather();
  await driver.navigate().refresh();
  await driver.wait(
    async () => (await driver.findElement(By.id('weather')).getText()).includes('14°C'),
    10000,
  );
  await send('setNewTab', { value: { unit: 'fahrenheit' } });
  await driver.wait(
    async () => (await driver.findElement(By.id('weather')).getText()).includes('57°F'),
    10000,
  );
  await call('return browser.permissions.remove(arguments[0]);', WEATHER_ACCESS);
  await driver.wait(
    async () =>
      (await driver.findElement(By.id('weather')).getText()).includes('Allow weather access'),
    10000,
  );
  await send('setNewTab', { value: { weatherEnabled: false } });
  const container = await call(
    `return browser.contextualIdentities.create({name:'New tab test',color:'blue',icon:'briefcase'});`,
  );
  const group = await send('createGroup', { name: 'Work' });
  await send('setGroupContainer', {
    id: group.createdGroupId,
    cookieStoreId: container.cookieStoreId,
  });
  const beforeFolderTab = await driver.getAllWindowHandles();
  const created = await send('newTab', { groupId: group.createdGroupId });
  const tab = await call('return browser.tabs.get(arguments[0]);', created.createdTabId);
  assert(tab.url.startsWith(`${root}new-tab.html`));
  assert.equal(tab.cookieStoreId, container.cookieStoreId);
  const snap = await send('snapshot');
  assert.equal(snap.tabs.find((item) => item.id === tab.id).groupId, group.createdGroupId);
  const folderHandle = await driver.wait(
    async () => (await driver.getAllWindowHandles()).find((id) => !beforeFolderTab.includes(id)),
    10000,
  );
  await driver.switchTo().window(folderHandle);
  await driver.wait(
    async () => (await driver.findElements(By.css('#links a'))).length === 1,
    10000,
  );
  await driver.findElement(By.css('#links a')).click();
  await driver.wait(
    async () => (await driver.getCurrentUrl()).startsWith('https://example.com/'),
    10000,
  );
  await driver.navigate().back();
  await driver.wait(async () => (await driver.findElements(By.id('search'))).length > 0, 10000);
  await driver
    .findElement(By.id('search'))
    .sendKeys('https://example.com/?new-tab-test=1', Key.ENTER);
  await driver.wait(
    async () => (await driver.getCurrentUrl()) === 'https://example.com/?new-tab-test=1',
    10000,
  );
  await driver.switchTo().window(activeHandle);
  const navigated = (await send('snapshot')).tabs.find((item) => item.id === tab.id);
  assert.equal(navigated.groupId, group.createdGroupId);
  assert.equal(navigated.cookieStoreId, container.cookieStoreId);
  const blank = await call('return browser.tabs.create({url:"about:blank",active:false});');
  assert.equal((await call('return browser.tabs.get(arguments[0]);', blank.id)).url, 'about:blank');
  // A different extension's native override must win over the optional redirect.
  const other = join(session.root, 'other-newtab');
  await mkdir(other);
  await writeFile(
    join(other, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Other new tab test',
      version: '1.0',
      chrome_url_overrides: { newtab: 'start.html' },
      browser_specific_settings: {
        gecko: {
          id: 'other-newtab@example.test',
          data_collection_permissions: { required: ['none'] },
        },
      },
    }),
  );
  await writeFile(
    join(other, 'start.html'),
    '<!doctype html><title>Other new tab</title><p>Other extension</p>',
  );
  const otherId = await driver.installAddon(other, true);
  const otherTab = await call('return browser.tabs.create({active:false});');
  await driver.wait(
    async () =>
      (await call('return browser.tabs.get(arguments[0]);', otherTab.id)).url.endsWith(
        '/start.html',
      ),
    10000,
  );
  await driver.uninstallAddon(otherId);
  await send('setNewTab', { value: { enabled: false } });
  const off = await call('return browser.tabs.create({active:false});');
  await driver.wait(
    async () =>
      (await call('return browser.tabs.get(arguments[0]);', off.id)).status === 'complete',
    10000,
  );
  assert.equal((await call('return browser.tabs.get(arguments[0]);', off.id)).url, 'about:newtab');
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/new-tab-firefox.png', await driver.takeScreenshot(), 'base64');
  console.log(
    '✓ Native Firefox: default off, routing, search focus, default search engine, settings/save/preview, optional weather, containers, folder placement, other overrides, blanks and disable',
  );
} finally {
  await session.close();
}
