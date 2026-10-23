import assert from 'node:assert/strict';
import { By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { startFirefox } from "../../scripts/firefox-session.js";
import { resolve } from 'node:path';
import { previewServer } from "../../scripts/preview.js";

let driver, session;
const server = await previewServer(0);
const fixtureUrl = `http://127.0.0.1:${server.address().port}/preview/index.html`;
try {
  session = await startFirefox();
  driver = session.driver;
  await driver.manage().setTimeouts({ script: 20000, implicit: 0, pageLoad: 30000 });
  await driver.manage().window().setRect({ width: 1440, height: 1000 });
  const addonId = await driver.installAddon(resolve('extension'), true);
  await driver.setContext(firefox.Context.CHROME);
  const uuid = await driver.executeScript(
    'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
    addonId,
  );
  await driver.setContext(firefox.Context.CONTENT);
  const extensionUrl = `moz-extension://${uuid}/`;
  await driver.get(`${extensionUrl}sidebar.html`);
  await driver.wait(until.elementLocated(By.css('.tab-row')), 15000);
  const sidebar = await driver.getWindowHandle();

  const call = async (body, ...args) => {
    const response = await driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];(async()=>{${body}})().then(value=>done({ok:true,value}),error=>done({ok:false,error:error.message}));`,
      ...args,
    );
    if (!response.ok) throw new Error(response.error);
    return response.value;
  };

  const send = (type, args = {}) =>
    call(
      `const [type,args]=arguments;const win=await browser.windows.getCurrent();const result=await browser.runtime.sendMessage({type:'tabernacle:'+type,windowId:win.id,...args});if(!result.ok)throw new Error(result.error);return result.data;`,
      type,
      args,
    );

  // Activation refreshes the live list; reacquire a row if it was replaced
  // between WebDriver finding it and dispatching the click.
  const clickRow = (selector) =>
    driver.wait(
      async () => {
        try {
          await driver.findElement(By.css(selector)).click();
          return true;
        } catch (error) {
          if (['StaleElementReferenceError', 'NoSuchElementError'].includes(error.name))
            return false;
          throw error;
        }
      },
      5000,
      `Click activity row: ${selector}`,
    );

  const groupId = crypto.randomUUID();
  await send('createGroup', { id: groupId, name: 'Activity test folder' });
  const viewed = await call('return browser.tabs.create({url:"about:blank",active:true});');
  await send('moveTab', { id: viewed.id, groupId });
  await send('enterGroup', { id: groupId });
  await send('toggleGroup', { id: groupId });
  await send('toggleGroup', { id: groupId });
  const closed = await call(
    'return browser.tabs.create({url:arguments[0],active:false});',
    fixtureUrl,
  );
  await driver.wait(
    async () =>
      (await call('return browser.tabs.get(arguments[0]);', closed.id)).status === 'complete',
    5000,
    'Load the fixture tab before closing it',
  );
  await send('closeTab', { id: closed.id });
  const before = await driver.wait(
    async () => {
      const state = await send('snapshot');
      return state.recentlyClosed.length ? state : false;
    },
    5000,
    'Closed fixture tab appears in the session list',
  );
  const sessionId = before.recentlyClosed[0].sessionId;
  await driver.switchTo().window(sidebar);
  await driver.findElement(By.id('recently-closed-toggle')).click();
  await driver.wait(until.elementLocated(By.css('#recently-closed:not([hidden])')), 5000);
  await driver.findElement(By.css('.recent-more')).click();
  const activityHandle = await driver.wait(
    async () => {
      for (const handle of await driver.getAllWindowHandles()) {
        await driver.switchTo().window(handle);
        if ((await driver.getCurrentUrl()).startsWith(`${extensionUrl}activity.html`))
          return handle;
      }
      return false;
    },
    5000,
    'More opens the full activity page',
  );
  await driver.wait(until.elementLocated(By.css('.activity-row')), 10000);
  assert.equal(await driver.getTitle(), 'Recent activity · Tabernacle');
  assert.equal(
    await driver.findElement(By.css(`[data-key="folder:${groupId}"] .item-kind`)).getText(),
    'Expanded',
  );
  const times = await driver.executeScript(
    'return [...document.querySelectorAll(".item-time")].map(node => Date.parse(node.dateTime));',
  );
  assert(times.every((time, i) => i === 0 || time <= times[i - 1]));
  const activityId = (await call('return browser.tabs.getCurrent();')).id;
  assert.equal((await driver.findElements(By.css(`[data-key="viewed:${activityId}"]`))).length, 0);
  assert.equal(
    (await send('snapshot')).tabs.some((tab) => tab.id === activityId),
    false,
  );
  await driver.findElement(By.css('[data-kind="folder"].filter-link')).click();
  await driver.executeScript('window.activityVisit = "retained";');
  const count = (await driver.getAllWindowHandles()).length;
  await driver.switchTo().window(sidebar);
  await driver.findElement(By.id('recently-closed-toggle')).click();
  await driver.findElement(By.css('.recent-more')).click();
  assert.equal((await driver.getAllWindowHandles()).length, count);
  await driver.switchTo().window(activityHandle);
  assert.equal(await driver.executeScript('return window.activityVisit;'), 'retained');
  assert.equal(
    await driver
      .findElement(By.css('[data-kind="folder"].filter-link'))
      .getAttribute('aria-current'),
    'page',
  );
  await driver.wait(until.elementLocated(By.css(`[data-key="folder:${groupId}"]`)), 5000);
  await clickRow(`[data-key="folder:${groupId}"]`);
  assert.equal((await send('snapshot')).view.scopeId, groupId);
  await driver.switchTo().window(activityHandle);
  await driver.findElement(By.css('[data-kind="closed"].filter-link')).click();
  const restoreSelector = `[data-key="closed:${sessionId}"]`;
  await driver.wait(until.elementLocated(By.css(restoreSelector)), 5000);
  await clickRow(restoreSelector);
  await driver.wait(
    async () => !(await send('snapshot')).recentlyClosed.some((tab) => tab.sessionId === sessionId),
    5000,
    'Restored tab disappears from the closed-session list',
  );
  await driver.switchTo().window(activityHandle);
  await driver.findElement(By.css('[data-kind="viewed"].filter-link')).click();
  await driver.wait(until.elementLocated(By.css(`[data-key="viewed:${viewed.id}"]`)), 5000);
  await clickRow(`[data-key="viewed:${viewed.id}"]`);
  assert.equal((await call('return browser.tabs.get(arguments[0]);', viewed.id)).active, true);
  await driver.switchTo().window(activityHandle);
  assert.equal((await driver.findElements(By.id('activity-layout'))).length, 0);
  await driver.wait(until.elementLocated(By.css('.activity-timeline')), 5000);
  console.log(
    '✓ Native Firefox: extension page, reuse, self exclusion, folder entry, restore, switch and timeline',
  );
} finally {
  try {
    await session?.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
