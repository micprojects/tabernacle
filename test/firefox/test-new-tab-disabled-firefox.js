import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { startFirefox } from '../../scripts/firefox-session.js';

const session = await startFirefox();
const { driver } = session;
try {
  await driver.manage().setTimeouts({ script: 20000, pageLoad: 30000 });
  const addonId = await driver.installAddon(resolve('extension'), true);
  await driver.setContext(firefox.Context.CHROME);
  const uuid = await driver.executeScript(
    'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
    addonId,
  );
  const root = `moz-extension://${uuid}/`;
  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(`${root}settings.html#features`);

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

  const ready = () =>
    driver.wait(
      () => driver.findElement(By.id('look-color-scheme')).isEnabled(),
      10000,
      'Settings did not become ready',
    );

  const firefoxHome = (id) =>
    driver.wait(
      async () => (await call('return browser.tabs.get(arguments[0]);', id)).url === 'about:newtab',
      10000,
      `Tab ${id} did not settle on Firefox Home`,
    );

  await ready();
  await send('setLook', { value: { colorScheme: 'light' }, partial: true });
  // Simulate a previous installation with the feature enabled, including opaque
  // preferences. Reload the extension so startup must also honour the pause.
  const saved = await call(`
    const {MODEL_KEY}=await import('./src/model.js');
    const model=(await browser.storage.local.get(MODEL_KEY))[MODEL_KEY];
    model.newTab={...model.newTab,enabled:true,weatherEnabled:true,
      location:{name:'Test location',latitude:51,longitude:0},
      links:[{id:'kept',name:'Kept link',url:'https://example.test/'}],futureField:{keep:true}};
    await browser.storage.local.set({[MODEL_KEY]:model});
    return model.newTab;
  `);
  // Keep a browser-owned tab open when Firefox closes the extension's documents.
  await call("return browser.tabs.create({url:'about:blank',active:false});");
  await driver.installAddon(resolve('extension'), true);
  await driver.switchTo().window((await driver.getAllWindowHandles())[0]);
  await driver.get(`${root}settings.html#features`);
  const own = await driver.getWindowHandle();
  await ready();
  console.log('✓ Settings ready after extension reload with enabled preferences');
  for (const section of ['features', 'new-tab']) {
    await driver.get(`${root}settings.html#${section}`);
    await ready();
    assert.equal(await driver.findElement(By.id('appearance')).isDisplayed(), true);
    assert.equal(await driver.findElement(By.id('features')).isDisplayed(), false);
    assert.equal(await driver.findElement(By.css('a[href="#features"]')).isDisplayed(), false);
    assert.equal(await driver.findElement(By.id('new-tab-add-link')).isEnabled(), false);
    await send('openPage', { page: 'settings', section });
    assert.equal(await driver.findElement(By.id('features')).isDisplayed(), false);
  }
  await send('setLook', { value: { colorScheme: 'dark' }, partial: true });
  for (const type of ['setNewTab', 'previewNewTab', 'weatherLocations', 'weatherCurrent'])
    await assert.rejects(send(type, { value: { enabled: false }, query: 'London' }), /unavailable/);

  const group = (await send('createGroup', { name: 'Kept folder' })).groups.find(
    (group) => group.name === 'Kept folder',
  );
  const created = await send('newTab', { groupId: group.id });
  await driver.switchTo().window(own);
  const parent = created.tabs.find((tab) => tab.id === created.createdTabId);
  await firefoxHome(parent.id);
  assert.equal(parent.groupId, group.id);
  const childState = await send('newChildTab', { id: parent.id });
  await driver.switchTo().window(own);
  const child = childState.tabs.find((tab) => tab.parentTabId === parent.id);
  await firefoxHome(child.id);
  assert.equal(child.groupId, group.id);
  const native = await call('return browser.tabs.create({active:false});');
  await send('snapshot');
  await firefoxHome(native.id);
  console.log('✓ Sidebar, child and browser-created tabs retain Firefox Home');

  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript("document.getElementById('cmd_newNavigatorTab').doCommand();");
  await driver.wait(
    async () =>
      (await driver.executeScript('return gBrowser.selectedBrowser.currentURI.spec;')) ===
      'about:newtab',
    10000,
    'The native new-tab command did not retain Firefox Home',
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.switchTo().window(own);

  for (const suffix of ['', '?start=1', '?preview=saved']) {
    await driver.get(`${root}new-tab.html${suffix}`);
    await driver.wait(
      async () => (await driver.getCurrentUrl()) === 'about:blank',
      10000,
      `Old new-tab link did not become blank: ${suffix}`,
    );
    await driver.get(`${root}settings.html`);
    await ready();
  }
  const preserved = await call(`
    const {MODEL_KEY}=await import('./src/model.js');
    return (await browser.storage.local.get(MODEL_KEY))[MODEL_KEY].newTab;
  `);
  assert.deepEqual(preserved, saved);
  console.log(
    '✓ Paused new tab stays disabled across reload, browser/sidebar creation and old links; Features is hidden and preferences are preserved',
  );
} finally {
  await session.close();
}
