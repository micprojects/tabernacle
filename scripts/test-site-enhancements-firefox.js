import assert from 'node:assert/strict';
import { By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { resolve } from 'node:path';
import { startFirefox } from './firefox-session.js';

const session = await startFirefox();
const driver = session.driver;
try {
  await driver.manage().setTimeouts({ script: 20000, pageLoad: 30000 });
  await driver.manage().window().setRect({ width: 1180, height: 1000 });
  const addonId = await driver.installAddon(resolve('extension'), true);
  await driver.setContext(firefox.Context.CHROME);
  const uuid = await driver.executeScript(
    'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
    addonId,
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(`moz-extension://${uuid}/settings.html#site-enhancements`);

  const call = async (body, ...args) => {
    const result = await driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];(async()=>{${body}})().then(value=>done({ok:true,value}),error=>done({ok:false,error:error.message}));`,
      ...args,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  const getSettings = () =>
    call(
      'const {windowId}=await browser.tabs.getCurrent(); return (await browser.runtime.sendMessage({type:"tabernacle:getSettings",windowId})).data;',
    );
  const master = () => driver.findElement(By.id('site-enhancements-enabled'));
  await driver.wait(async () => (await master()).isEnabled(), 10000);
  await (await master()).click();
  await driver.wait(async () => (await getSettings()).siteEnhancementsEnabled === false, 5000);
  await driver.navigate().refresh();
  await driver.wait(async () => (await master()).isEnabled(), 10000);
  assert.equal(await (await master()).isSelected(), false);
  await (await master()).click();
  await driver.wait(async () => (await getSettings()).siteEnhancementsEnabled === true, 5000);

  const row = '[data-enhancement="reddit"]';
  await driver.findElement(By.css(`${row} summary`)).click();
  const button = () => driver.findElement(By.css(`${row} button`));
  const status = () => driver.findElement(By.css(`${row} [role="status"]`)).getText();
  await driver.wait(async () => (await button()).isEnabled(), 5000);
  await (await button()).click();
  // Accept the real optional-permission prompt in this disposable profile.
  await driver.setContext(firefox.Context.CHROME);
  await driver.wait(
    () =>
      driver.executeScript(
        'return !!PopupNotifications.getNotification("addon-webext-permissions", gBrowser.selectedBrowser);',
      ),
    10000,
  );
  await driver.executeScript(
    'PopupNotifications.panel.querySelector("popupnotification").button.click();',
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.wait(async () => (await status()) === 'Access allowed.', 10000);
  assert.equal(
    await call('return browser.permissions.contains({origins:["https://*.reddit.com/*"]});'),
    true,
  );
  await (await button()).click();
  await driver.wait(async () => (await status()) === 'Access not allowed.', 5000);
  assert.equal(
    await call('return browser.permissions.contains({origins:["https://*.reddit.com/*"]});'),
    false,
  );

  // An article-preview grant must remain intact when inspecting a site row.
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeAsyncScript(
    'const [id,done]=arguments;const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");ExtensionPermissions.add(id,{permissions:[],origins:["https://*/*"]},WebExtensionPolicy.getByID(id).extension).then(()=>done(true));',
    addonId,
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.wait(async () => (await status()).includes('Allowed by wider site access'), 5000);
  assert.equal(await (await button()).isEnabled(), false);
  assert.equal(await call('return browser.permissions.contains({origins:["https://*/*"]});'), true);
  await call('return browser.permissions.remove({origins:["https://*/*"]});');
  await driver.wait(async () => (await status()) === 'Access not allowed.', 5000);
  console.log(
    `✓ Firefox ${session.version}: settings persist; real permission prompt grants access; revoke removes it; wider grants are detected and preserved`,
  );
} finally {
  await session.close();
}
