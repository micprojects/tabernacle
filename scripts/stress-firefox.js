import assert from 'node:assert/strict';
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { download } from 'geckodriver';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

// Attach only to a browser explicitly launched for testing. Require its exact
// profile path so a forgotten switch cannot populate a personal profile.
const profile = process.env.FIREFOX_STRESS_PROFILE;
if (!profile) throw new Error('Set FIREFOX_STRESS_PROFILE to the test profile’s absolute path.');
const sizes = (process.env.FIREFOX_STRESS_SIZES || '100,500,1000').split(',').map(Number);
assert(
  sizes.every((size, i) => Number.isInteger(size) && size >= 3 && (!i || size > sizes[i - 1])),
);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><title>Tabernacle stress page</title><h1>Local test page</h1>' +
      (req.url.startsWith('/activity/')
        ? '<script>let n=0;const timer=setInterval(()=>{document.title="Live stress "+ ++n;if(n===5)clearInterval(timer)},250)</script>'
        : ''),
  );
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${server.address().port}/`;
const results = [];
let driver, windowId, handle, originalHandle, groupId, identity;

function report(test, value) {
  const result = { test, ...value };
  results.push(result);
  console.log(JSON.stringify(result));
}

async function call(body, ...args) {
  const result = await driver.executeAsyncScript(
    `const done=arguments[arguments.length-1];(async()=>{${body}})().then(value=>done({ok:true,value}),error=>done({ok:false,error:error.message}));`,
    ...args,
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function send(type, args = {}) {
  const response = await call(
    'return browser.runtime.sendMessage({type:"tabernacle:"+arguments[0],windowId:arguments[1],...arguments[2]});',
    type,
    windowId,
    args,
  );
  if (!response.ok) throw new Error(response.error);
  // Entering a group activates one of its tabs. Keep the measured document
  // visible: Firefox heavily throttles animation frames in background tabs.
  if (type === 'enterGroup') await driver.switchTo().window(handle);
  return response.data;
}

async function timedRequest(type, args = {}) {
  const start = performance.now();
  const state = await send(type, args);
  return { ms: Math.round(performance.now() - start), state };
}

async function rowCount(count) {
  await driver.wait(
    async () =>
      (await driver.executeScript('return document.querySelectorAll(".tab-row").length')) === count,
    60000,
  );
}

try {
  await mkdir('test-results', { recursive: true });
  driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(new firefox.Options())
    .setFirefoxService(
      new firefox.ServiceBuilder(
        process.env.GECKODRIVER_BINARY || (await download('0.37.1')),
      ).addArguments('--connect-existing', '--marionette-port', '2828', '--allow-system-access'),
    )
    .build();
  await driver.manage().setTimeouts({ script: 120000, pageLoad: 30000 });
  await driver.setContext(firefox.Context.CHROME);
  const info = await driver.executeScript(
    'return {profile:Services.dirsvc.get("ProfD",Ci.nsIFile).path,version:Services.appinfo.version};',
  );
  assert.equal(info.profile, profile, 'Refusing to modify an unexpected Firefox profile');
  report('environment', info);
  await driver.setContext(firefox.Context.CONTENT);
  originalHandle = await driver.getWindowHandle();
  const addon = await driver.installAddon(resolve('extension'), true);
  await driver.setContext(firefox.Context.CHROME);
  const uuid = await driver.executeScript(
    'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
    addon,
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.switchTo().newWindow('window');
  handle = await driver.getWindowHandle();
  await driver.manage().window().setRect({ width: 450, height: 860 });
  await driver.get(`moz-extension://${uuid}/sidebar.html`);
  await driver.wait(until.elementLocated(By.css('.tab-row')), 15000);
  windowId = await call('return (await browser.windows.getCurrent()).id;');
  groupId = (await send('createGroup', { name: 'Stress test' })).createdGroupId;
  await send('enterGroup', { id: groupId });
  await driver.executeScript(
    'window.testErrors=[];addEventListener("error",e=>testErrors.push(e.message));addEventListener("unhandledrejection",e=>testErrors.push(String(e.reason)));',
  );
  let created = 0;
  for (const size of sizes) {
    const start = performance.now();
    const createMs = await call(
      `
      const start=performance.now();
      for(let offset=arguments[0];offset<arguments[1];offset+=25) {
        await Promise.all(Array.from({length:Math.min(25,arguments[1]-offset)},(_,i)=>browser.tabs.create({url:arguments[2]+(offset+i),title:'Stress tab '+(offset+i),active:false,discarded:true})));
      }
      return Math.round(performance.now()-start);`,
      created,
      size,
      url,
    );
    const state = await send('snapshot');
    assert.equal(state.tabs.filter((t) => t.groupId === groupId).length, size);
    await rowCount(size);
    report('create-and-settle', {
      tabs: size,
      nativeCreateMs: createMs,
      totalMs: Math.round(performance.now() - start),
    });
    created = size;
    const timings = [];
    for (let i = 0; i < 5; i++) timings.push((await timedRequest('snapshot')).ms);
    report('warm-snapshot', { tabs: size, ms: timings });
    const searchMs = await call(
      `
      document.querySelector('#search-toggle').click();
      const start=performance.now(),input=document.querySelector('#search');
      input.value='Stress tab '+(arguments[0]-1);input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      return Math.round(performance.now()-start);`,
      size,
    );
    await rowCount(1);
    report('search-to-frame', { tabs: size, ms: searchMs });
    await call(
      `const input=document.querySelector('#search');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return true;`,
    );
    await rowCount(size);
    await send('enterGroup', { id: null });
    await rowCount(size + 1);
    const fold = await timedRequest('toggleGroup', { id: groupId });
    await rowCount(1);
    const unfold = await timedRequest('toggleGroup', { id: groupId });
    await rowCount(size + 1);
    report('group-toggle', { tabs: size, collapseRequestMs: fold.ms, expandRequestMs: unfold.ms });
    await send('enterGroup', { id: groupId });
  }
  await writeFile('test-results/firefox-stress.png', await driver.takeScreenshot(), 'base64');
  const state = await send('snapshot');
  const tabs = state.tabs.filter((t) => t.groupId === groupId);
  let result = await timedRequest('nestTab', { id: tabs[1].id, parentTabId: tabs[0].id });
  assert.equal(result.state.tabs.find((t) => t.id === tabs[1].id).parentTabId, tabs[0].id);
  report('nest-tab', { tabs: created, ms: result.ms });
  await send('pinTab', { id: tabs[0].id });
  await rowCount(created - 1);
  await send('pinTab', { id: tabs[0].id });
  await rowCount(created);
  identity = (
    await send('createContainer', { name: 'Stress test container', color: 'blue', icon: 'circle' })
  ).createdCookieStoreId;
  result = await timedRequest('reopenInContainer', { id: tabs[0].id, cookieStoreId: identity });
  const parent = result.state.tabs.find((t) => t.id === result.state.reopenedTabId);
  assert.equal(result.state.tabs.find((t) => t.id === tabs[1].id).parentTabId, parent.id);
  report('container-reopen', { tabs: created, ms: result.ms });
  const depth = Math.min(30, tabs.length - 1);
  for (let i = 2; i < depth; i++)
    await send('nestTab', { id: tabs[i].id, parentTabId: tabs[i - 1].id });
  await send('toggleTab', { id: parent.id });
  await rowCount(created - depth + 1);
  await send('toggleTab', { id: parent.id });
  await rowCount(created);
  report('nested-branch', { depth, tabs: created });
  const busyIds = tabs.slice(-Math.min(20, tabs.length - depth)).map((tab) => tab.id);
  await call(
    'return Promise.all(arguments[0].map(id=>browser.tabs.update(id,{url:arguments[1]+"activity/"+id}))).then(()=>true);',
    busyIds,
    url,
  );
  const frames = await call(`
    const gaps=[];let last=performance.now();
    for(let i=0;i<120;i++) {await new Promise(requestAnimationFrame);const now=performance.now();gaps.push(now-last);last=now;}
    gaps.sort((a,b)=>a-b);return {p95Ms:Math.round(gaps[113]),maxMs:Math.round(gaps.at(-1))};`);
  report('frames-during-page-activity', { tabs: created, loadedPages: busyIds.length, ...frames });
  await driver.wait(
    () =>
      call(
        'return Promise.all(arguments[0].map(id=>browser.tabs.get(id))).then(tabs=>tabs.every(t=>t.title==="Live stress 5"));',
        busyIds,
      ),
    15000,
  );
  await driver.wait(
    () =>
      driver.executeScript(
        'return arguments[0].every(id=>document.querySelector(`[data-key="tab:${id}"] .label`)?.textContent==="Live stress 5");',
        busyIds,
      ),
    15000,
  );
  // Check persistence while a live page in the tested group is selected.
  await call('return browser.tabs.update(arguments[0],{active:true});', busyIds.at(-1));
  const beforeReload = (await send('snapshot')).tabs.filter((t) => t.groupId === groupId);
  await send('enterGroup', { id: groupId });
  await rowCount(created);
  report('sidebar-errors', { errors: await driver.executeScript('return window.testErrors;') });
  assert.deepEqual(results.at(-1).errors, []);
  await driver.get('about:blank');
  await driver.setContext(firefox.Context.CHROME);
  const reload = await driver.executeAsyncScript(
    `const done=arguments[arguments.length-1];
    const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    AddonManager.getAddonByID(arguments[0]).then(addon=>addon.reload()).then(()=>done(true),error=>done({error:error.message}));`,
    addon,
  );
  assert.equal(reload, true, 'The extension must reload successfully');
  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(`moz-extension://${uuid}/sidebar.html`);
  await rowCount(created);
  const reloaded = await send('snapshot');
  const treeState = (tabs) =>
    tabs.map(({ treeId, ancestors, groupId, order, cookieStoreId, pinned, mutedInfo }) => ({
      treeId,
      ancestors,
      groupId,
      order,
      cookieStoreId,
      pinned,
      muted: Boolean(mutedInfo?.muted),
    }));
  assert.deepEqual(
    treeState(reloaded.tabs.filter((t) => t.groupId === groupId)),
    treeState(beforeReload),
  );
  report('reload-persistence', { tabs: created });
  await send('enterGroup', { id: null });
  const contents = await send('getGroupContents', { id: groupId });
  result = await timedRequest('removeGroup', { id: groupId, ...contents });
  report('close-group', { tabs: created, ms: result.ms });
  groupId = null;
  await rowCount(1);
  await send('removeContainer', { cookieStoreId: identity });
  identity = null;
  console.log('Firefox stress checks passed.');
} finally {
  await writeFile('test-results/firefox-stress.json', JSON.stringify(results, null, 2) + '\n');
  try {
    if (driver) {
      try {
        if (groupId) {
          await driver.takeScreenshot().then(
            (png) => writeFile('test-results/firefox-stress-failure.png', png, 'base64'),
            () => {},
          );
          if ((await send('snapshot')).groups.some((group) => group.id === groupId)) {
            const contents = await send('getGroupContents', { id: groupId });
            await send('removeGroup', { id: groupId, ...contents });
          }
        }
        if (identity) await send('removeContainer', { cookieStoreId: identity });
        if (handle) await driver.close();
        if (originalHandle) await driver.switchTo().window(originalHandle);
      } finally {
        await driver.quit();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
