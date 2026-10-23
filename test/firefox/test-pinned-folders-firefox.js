import assert from 'node:assert/strict';
import { By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { startFirefox } from "../../scripts/firefox-session.js";
import { resolve } from 'node:path';
import { previewServer } from "../../scripts/preview.js";

const server = await previewServer(0);
const fixtureUrl = `http://127.0.0.1:${server.address().port}/preview/index.html`;
let driver, firefoxSession;
try {
  firefoxSession = await startFirefox();
  driver = firefoxSession.driver;
  await driver.manage().setTimeouts({ script: 20000, implicit: 0, pageLoad: 30000 });
  const addonId = await driver.installAddon(resolve('extension'), true);
  await driver.setContext(firefox.Context.CHROME);
  const uuid = await driver.executeScript(
    'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
    addonId,
  );
  await driver.setContext(firefox.Context.CONTENT);
  const sidebarUrl = `moz-extension://${uuid}/sidebar.html`;
  await driver.get(sidebarUrl);
  await driver.wait(until.elementLocated(By.css('.tab-row')), 15000);

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
  const signature = (state) => state.pins.map((item) => `${item.kind}:${item.id}`);

  const movePin = async (item, before) => {
    // Plan inside Firefox like the sidebar: WebDriver reorders object keys,
    // which would change the serialized placement used for stale-state checks.
    const { state, operationId } = await call(
      `const [item,before]=arguments;
      const {moveSource,resolveMove}=await import(browser.runtime.getURL('src/move-plan.js'));
      const windowId=(await browser.windows.getCurrent()).id;
      const request=async(type,args={})=>{
        const result=await browser.runtime.sendMessage({type:'tabernacle:'+type,windowId,...args});
        if(!result.ok)throw new Error(result.error);
        return result.data;
      };
      const current=await request('snapshot');
      const source=moveSource(current,item.kind==='group'?'pin-group':'tab',
        item.kind==='group'?item.id:current.tabs.find(tab=>tab.treeId===item.id).id);
      const destination={kind:'pins',before};
      const operationId=crypto.randomUUID();
      const state=await request('moveItem',{
        source,destination,operationId,expected:resolveMove(current,source,destination).expected,
      });
      return {state,operationId};`,
      item,
      before,
    );
    assert.equal(state.moveResult.committed, true);
    assert.equal(state.moveResult.operationId, operationId);
    return state;
  };

  const folder = (id) => ({ kind: 'group', id });
  const tabRef = (state, id) => ({
    kind: 'tab',
    id: state.tabs.find((tab) => tab.id === id).treeId,
  });

  const work = (
    await send('createGroup', { name: 'Work', appearance: { icon: 'briefcase', color: 'purple' } })
  ).createdGroupId;
  const nested = (await send('createGroup', { name: 'Research', parentId: work })).createdGroupId;
  const other = (await send('createGroup', { name: 'Personal' })).createdGroupId;
  const firstWindow = (await call('return browser.windows.getCurrent();')).id;
  const firstPins = await call(
    `const result=[];for(let i=0;i<2;i++)result.push(await browser.tabs.create({pinned:true,active:false,url:arguments[0]+'?first='+i}));return result;`,
    fixtureUrl,
  );
  const secondWindow = await call(
    'return browser.windows.create({url:arguments[0],focused:false});',
    fixtureUrl,
  );
  const secondPins = await call(
    `const result=[];for(let i=0;i<2;i++)result.push(await browser.tabs.create({windowId:arguments[0],pinned:true,active:false,url:arguments[1]+'?second='+i}));return result;`,
    secondWindow.id,
    fixtureUrl,
  );
  await driver.wait(
    async () =>
      (await call('return browser.tabs.query({});')).every((tab) => tab.status === 'complete'),
    10000,
  );
  await send('setGroupPin', { id: work, action: 'open' });
  await send('setGroupPin', { id: other, action: 'reveal' });
  let first = await send('snapshot');
  const a = tabRef(first, firstPins[0].id),
    b = tabRef(first, firstPins[1].id);
  await movePin(folder(work), b);
  const secondBefore = await send('snapshot', { windowId: secondWindow.id });
  await movePin(folder(other), a);
  first = await send('snapshot');
  assert.deepEqual(first.pins, [folder(other), a, folder(work), b]);
  const second = await send('snapshot', { windowId: secondWindow.id });
  assert.deepEqual(second.pins, [
    ...secondBefore.pins.filter((item) => item.kind === 'tab'),
    folder(other),
    folder(work),
  ]);
  await movePin(b, a);
  assert.deepEqual(
    (
      await call('return browser.tabs.query({windowId:arguments[0],pinned:true});', firstWindow)
    ).map((tab) => tab.id),
    [firstPins[1].id, firstPins[0].id],
  );
  await call('return browser.tabs.move(arguments[0],{index:0});', firstPins[0].id);
  assert.deepEqual(
    (await send('snapshot')).pins.filter((item) => item.kind === 'tab'),
    [a, b],
  );
  console.log(
    '✓ Native mixed ordering and Firefox reorder events preserve shared folders and window-local positions',
  );

  const active = (await send('snapshot')).tabs.find((tab) => tab.active).id;
  await send('collapseAll', { collapsed: true });
  await send('revealGroup', { id: nested });
  const revealed = await send('snapshot');
  assert.equal(revealed.tabs.find((tab) => tab.active).id, active);
  assert(!revealed.view.collapsed.includes(work));
  assert(!revealed.view.collapsed.includes(nested));
  await driver.wait(
    until.elementLocated(By.css(`.pinned-folder[data-key="pin:group:${work}"]`)),
    5000,
  );
  assert.equal(
    await driver.findElement(By.css(`.pinned-folder[data-key="pin:group:${work}"]`)).getText(),
    '',
  );

  const beforeReload = signature(await send('snapshot'));
  await driver.get('about:blank');
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeAsyncScript(
    `const done=arguments[arguments.length-1];const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');AddonManager.getAddonByID(arguments[0]).then(addon=>addon.reload()).then(()=>done(true),error=>done({error:error.message}));`,
    addonId,
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(sidebarUrl);
  await driver.wait(until.elementLocated(By.css('.pinned-folder')), 15000);
  assert.deepEqual(signature(await send('snapshot')), beforeReload);
  console.log(
    '✓ Folder reveal retains the active tab, and extension reload retains icon-only pins and ordering',
  );

  const secondState = await send('snapshot', { windowId: secondWindow.id });
  const secondTabs = secondState.tabs.filter((tab) => tab.pinned).map((tab) => tab.treeId);
  await call('return browser.windows.remove(arguments[0]);', secondWindow.id);
  const session = await driver.wait(async () => {
    const sessions = await call('return browser.sessions.getRecentlyClosed();');
    return sessions.find((entry) =>
      entry.window?.tabs?.some((tab) => tab.url?.includes('?second=')),
    );
  }, 10000);
  const restored = await call(
    'return browser.sessions.restore(arguments[0]);',
    session.window.sessionId,
  );
  const restoredId = restored.window.id;
  await driver.wait(
    async () =>
      (await call('return browser.tabs.query({windowId:arguments[0],pinned:true});', restoredId))
        .length === 2,
    10000,
  );
  const restoredState = await send('snapshot', { windowId: restoredId });
  assert.deepEqual(signature(restoredState), signature(secondState));
  assert.deepEqual(
    restoredState.tabs
      .filter((tab) => tab.pinned)
      .map((tab) => tab.treeId)
      .sort(),
    secondTabs.sort(),
  );
  assert(
    restoredState.tabs
      .filter((tab) => tab.pinned)
      .every((tab) => !secondPins.some((old) => old.id === tab.id)),
  );
  console.log('✓ Restoring a real Firefox window retains mixed positions with new native tab IDs');

  await send('setGroupPin', { id: work, action: null });
  assert(
    !(await send('snapshot', { windowId: restoredId })).pins.some(
      (item) => item.kind === 'group' && item.id === work,
    ),
  );
  await send('setGroupPin', { id: work, action: 'reveal' });
  assert.deepEqual((await send('snapshot', { windowId: restoredId })).pins.at(-1), folder(work));
  await send('removeGroup', { id: work, ...(await send('getGroupContents', { id: work })) });
  assert(!(await send('snapshot')).folderPins.some((pin) => pin.id === work));
  console.log('✓ Global unpin, repin and deletion update restored windows');
} finally {
  try {
    await firefoxSession?.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
