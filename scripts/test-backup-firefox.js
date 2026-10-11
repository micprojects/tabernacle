import assert from 'node:assert/strict';
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { download } from 'geckodriver';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { MODEL_KEY, TAB_KEY } from '../extension/src/model.js';

const root = await mkdtemp(join(tmpdir(), 'tabernacle-backup-firefox-'));
let driver;
try {
  const appData = join(root, 'app-data');
  const downloads = join(root, 'downloads');
  await mkdir(appData);
  await mkdir(downloads);
  const options = new firefox.Options().addArguments('-headless');
  if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
  else if (process.platform === 'darwin')
    options.setBinary('/Applications/Firefox.app/Contents/MacOS/firefox');
  options.setPreference('browser.shell.checkDefaultBrowser', false);
  options.setPreference('browser.startup.page', 0);
  options.setPreference('privacy.userContext.enabled', true);
  options.setPreference('browser.download.folderList', 2);
  options.setPreference('browser.download.dir', downloads);
  options.setPreference('browser.download.useDownloadDir', true);
  options.setPreference('browser.helperApps.neverAsk.saveToDisk', 'application/json');
  driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(
      new firefox.ServiceBuilder(process.env.GECKODRIVER_BINARY || (await download('0.37.1')))
        .addArguments('--allow-system-access', '--profile-root', root)
        .setEnvironment({ ...process.env, MOZ_APP_DATA: appData }),
    )
    .build();
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
} finally {
  try {
    await driver?.quit();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
