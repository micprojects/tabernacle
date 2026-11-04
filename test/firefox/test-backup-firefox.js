import assert from 'node:assert/strict';
import { By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { startFirefox } from '../../scripts/firefox-session.js';
import { join, resolve } from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { MODEL_KEY, TAB_KEY } from '../../extension/src/model.js';

let driver, session, downloads;
try {
  session = await startFirefox({
    async configure(options, root) {
      downloads = join(root, 'downloads');
      await mkdir(downloads);
      options.setPreference('privacy.userContext.enabled', true);
      options.setPreference('browser.download.folderList', 2);
      options.setPreference('browser.download.dir', downloads);
      options.setPreference('browser.download.useDownloadDir', true);
      options.setPreference('browser.helperApps.neverAsk.saveToDisk', 'application/json');
    },
  });
  driver = session.driver;
  await driver.manage().setTimeouts({ script: 20000, implicit: 0, pageLoad: 30000 });
  await driver.manage().window().setRect({ width: 1100, height: 950 });
  const addonId = await driver.installAddon(resolve('extension'), true);
  await driver.setContext(firefox.Context.CHROME);
  const uuid = await driver.executeScript(
    'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
    addonId,
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(`moz-extension://${uuid}/settings.html#backup`);
  await driver.wait(async () => driver.findElement(By.id('backup-export')).isEnabled(), 10000);

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

  const created = await send('createGroup', {
    name: 'Research',
    appearance: { icon: 'book', color: 'purple' },
    newContainer: { name: 'Backup test', color: 'blue', icon: 'briefcase' },
  });
  await send('createGroup', { name: 'Articles', parentId: created.createdGroupId });
  await call('return browser.tabs.create({url:"about:blank",active:false});');
  await send('snapshot');
  const membershipSnapshot = () =>
    call(
      `return Promise.all((await browser.tabs.query({})).map(async tab=>({id:tab.id,value:await browser.sessions.getTabValue(tab.id,arguments[0])})));`,
      TAB_KEY,
    );
  const beforeTabs = await membershipSnapshot();
  const before = await call(
    'return (await browser.storage.local.get(arguments[0]))[arguments[0]];',
    MODEL_KEY,
  );
  await driver.findElement(By.id('backup-export')).click();
  const filename = await driver.wait(
    async () =>
      (await readdir(downloads)).find((name) => /^tabernacle-folders-.*\.json$/.test(name)),
    10000,
  );
  const file = join(downloads, filename);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.folders.length, 2);
  assert.equal(saved.containers.length, 1);
  assert.equal(saved.tabs, undefined);
  await driver.findElement(By.id('backup-file')).sendKeys(file);
  await driver.wait(
    until.elementIsVisible(await driver.findElement(By.id('backup-preview-button'))),
    5000,
  );
  await driver.findElement(By.id('backup-preview-button')).click();
  await driver.wait(
    until.elementIsVisible(await driver.findElement(By.id('backup-preview'))),
    5000,
  );
  assert.equal(
    await driver.findElement(By.id('backup-preview-counts')).getText(),
    '0 folders to create · 2 folders to reuse',
  );
  await driver.findElement(By.id('backup-cancel')).click();
  assert.deepEqual(
    await call(`return {
      hidden: document.getElementById('backup-preview').hidden,
      rows: document.getElementById('backup-preview-tree').childElementCount,
      mappings: document.getElementById('backup-container-mappings').childElementCount,
      focus: document.activeElement.id,
    };`),
    { hidden: true, rows: 0, mappings: 0, focus: 'backup-preview-button' },
  );
  assert.deepEqual(await membershipSnapshot(), beforeTabs);
  await driver.findElement(By.id('backup-preview-button')).click();
  await driver.wait(
    until.elementIsVisible(await driver.findElement(By.id('backup-preview'))),
    5000,
  );
  assert.equal((await driver.findElements(By.css('#backup-preview-tree li'))).length, 2);
  await driver.executeScript(
    'const select=document.getElementById("backup-destination");select.value="new";select.dispatchEvent(new Event("change"));',
  );
  await driver.findElement(By.id('backup-name')).sendKeys('Imported');
  await driver.findElement(By.id('backup-preview-button')).click();
  await driver.wait(
    until.elementIsVisible(await driver.findElement(By.id('backup-preview'))),
    5000,
  );
  await driver.findElement(By.id('backup-import')).click();
  await driver.wait(
    async () =>
      (await driver.findElement(By.id('backup-status')).getText()).includes(
        'Created destination folder',
      ),
    5000,
  );
  const after = await call(
    'return (await browser.storage.local.get(arguments[0]))[arguments[0]];',
    MODEL_KEY,
  );
  assert.deepEqual(after.groups.slice(0, 2), before.groups);
  assert.equal(after.groups.length, 5);
  assert.deepEqual(await membershipSnapshot(), beforeTabs);
  await driver.get(`moz-extension://${uuid}/settings.html#backup`);
  await driver.wait(async () => driver.findElement(By.id('backup-export')).isEnabled(), 5000);
  assert.equal((await send('getFolderBackupState')).groups.length, 5);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/backup-firefox.png', await driver.takeScreenshot(), 'base64');
  console.log(
    '✓ Native Firefox: JSON download/upload, preview, merge, container reuse, new destination, persistence and unchanged tab memberships',
  );
  const otherWindow = await call(
    'return browser.windows.create({url:"about:blank",focused:false});',
  );
  const preview = await send('previewFolderImport', {
    backup: saved,
    destination: { newFolderName: 'Interrupted import' },
  });
  const request = {
    backup: saved,
    token: preview.token,
    fingerprint: preview.fingerprint,
    destination: preview.destination,
    containers: { [saved.containers[0].id]: 'create' },
  };
  const containersBefore = await call('return browser.contextualIdentities.query({});');
  await call(
    `const [key,token]=arguments;
    const background=await browser.runtime.getBackgroundPage();
    const local=background.browser.storage.local;
    const set=local.set.bind(local);
    let once=true;
    const wrapped=async(value)=>{
      await set(value);
      if(once && value[key]?.lastFolderImport?.token===token){
        once=false;
        throw new Error('Storage reply lost after commit');
      }
    };
    local.set=wrapped;
    if(local.set!==wrapped)throw new Error('Cannot intercept the storage response');`,
    MODEL_KEY,
    preview.token,
  );
  await assert.rejects(send('importFolders', request), /Storage reply lost after commit/);
  const committed = await call(
    'return (await browser.storage.local.get(arguments[0]))[arguments[0]];',
    MODEL_KEY,
  );
  const containersAfter = await call('return browser.contextualIdentities.query({});');
  assert.equal(containersAfter.length, containersBefore.length + 1);
  const importedContainer = containersAfter.find(
    (item) => !containersBefore.some((prior) => prior.cookieStoreId === item.cookieStoreId),
  );
  assert(
    committed.groups.some(
      (group) => group.defaultCookieStoreId === importedContainer.cookieStoreId,
    ),
  );
  await send('renameGroup', {
    id: created.createdGroupId,
    name: 'Research renamed in another window',
    windowId: otherWindow.id,
  });
  const retained = await call(
    'return (await browser.storage.local.get(arguments[0]))[arguments[0]];',
    MODEL_KEY,
  );
  for (const group of committed.groups)
    assert.deepEqual(
      retained.groups.find((item) => item.id === group.id),
      group.id === created.createdGroupId
        ? { ...group, name: 'Research renamed in another window' }
        : group,
    );
  assert.deepEqual(await send('importFolders', request), committed.lastFolderImport.result);
  assert.equal((await send('getFolderBackupState')).groups.length, committed.groups.length);
  assert.deepEqual(await call('return browser.contextualIdentities.query({});'), containersAfter);
  assert.deepEqual(
    (await membershipSnapshot()).filter((tab) => beforeTabs.some((prior) => prior.id === tab.id)),
    beforeTabs,
  );
  console.log(
    '✓ A lost native storage reply retains imported containers and folders through another-window save and retry',
  );
} finally {
  await session?.close();
}
