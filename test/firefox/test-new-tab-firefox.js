import assert from 'node:assert/strict';
import { By, Key } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { startFirefox } from '../../scripts/firefox-session.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { WEATHER_ACCESS } from '../../extension/src/new-tab/weather.js';
import { newTabTestExtension } from '../helpers/new-tab-feature.js';

const session = await startFirefox();
const driver = session.driver;
try {
  await driver.manage().setTimeouts({ script: 20000, pageLoad: 30000 });
  await driver.manage().window().setRect({ width: 1440, height: 1000 });
  const addonId = await driver.installAddon(await newTabTestExtension(session.root), true);
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
  const nativeHome = await call('return browser.tabs.create({active:false});');
  await send('snapshot');
  await driver.get(`${root}settings.html#features`);
  await driver.wait(
    () => driver.findElement(By.css('#features input[name="enabled"]')).isEnabled(),
    10000,
  );
  assert.equal(
    await driver.findElement(By.css('#features input[name="enabled"]')).isSelected(),
    false,
  );
  await driver.findElement(By.css('#features input[name="enabled"]')).click();
  await driver.findElement(By.id('new-tab-save')).click();
  await driver.wait(
    async () =>
      (await driver.findElement(By.id('new-tab-status')).getText()) === 'All changes saved',
    10000,
  );
  await driver.navigate().refresh();
  await driver.wait(
    () => driver.findElement(By.css('#features input[name="enabled"]')).isSelected(),
    10000,
  );
  await driver.get(`${root}new-tab.html?preview=1`);
  await driver.wait(async () => !(await driver.findElement(By.id('loading')).isDisplayed()), 10000);
  const nativeDuplicate = await call(
    'return browser.tabs.duplicate(arguments[0], {active:false});',
    nativeHome.id,
  );
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
  assert.equal(
    (await call('return browser.tabs.get(arguments[0]);', nativeDuplicate.id)).url,
    'about:newtab',
    'A recently duplicated Firefox Home tab must retain its original page',
  );
  await call('await browser.tabs.remove(arguments[0]);', [nativeHome.id, nativeDuplicate.id]);
  console.log('✓ Native Home duplication stays unchanged while a fresh browser tab is redirected');
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
  await driver.actions().keyDown(modifier).sendKeys('l').keyUp(modifier).perform();
  await driver.wait(
    () => driver.executeScript('return document.activeElement === gURLBar.inputField;'),
    5000,
    'The address bar receives focus before typing',
  );
  await driver.actions().sendKeys('example.test').perform();
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

  await call(`
    const send = browser.runtime.sendMessage.bind(browser.runtime);
    window.newTabReadRecovery = { fail: true, restore: () => browser.runtime.sendMessage = send };
    browser.runtime.sendMessage = message =>
      newTabReadRecovery.fail && message.type === 'tabernacle:getNewTabState'
        ? Promise.resolve({ok:false,error:'Temporary state read failure'})
        : send(message);
    window.dispatchEvent(new Event('focus'));
  `);
  await driver.wait(
    async () =>
      (await driver.findElement(By.id('page-error')).getText()) === 'Temporary state read failure',
    10000,
  );
  await call(`newTabReadRecovery.fail = false; window.dispatchEvent(new Event('focus'));`);
  await driver.wait(
    async () => !(await driver.findElement(By.id('page-error')).isDisplayed()),
    10000,
  );
  await call(`newTabReadRecovery.restore(); delete window.newTabReadRecovery;`);
  console.log('✓ New tab clears a temporary read error after a successful native refresh');

  // Customise opens the dedicated section; saving and previewing work in Firefox.
  await driver.findElement(By.id('customise')).click();
  const settingsHandle = await driver.wait(
    async () => (await driver.getAllWindowHandles()).find((id) => !handles.includes(id)),
    10000,
  );
  await driver.switchTo().window(settingsHandle);
  assert.equal(await driver.getCurrentUrl(), `${root}settings.html#features`);
  await driver.wait(
    async () => await driver.findElement(By.id('new-tab-add-link')).isEnabled(),
    10000,
  );
  const beforeNavigation = (await send('getSettings')).newTab;
  const beforeContainers = await send('getContainers');
  for (const [section, button, dialog, input, external] of [
    ['containers', 'container-new', 'container-editor', 'container-name', false],
    ['new-tab', 'new-tab-add-link', 'new-tab-link-editor', 'nt-link-name', false],
    ['containers', 'container-new', 'container-editor', 'container-name', true],
  ]) {
    await call("location.hash = 'appearance';");
    await driver.wait(() => driver.findElement(By.id('appearance')).isDisplayed(), 10000);
    await call('location.hash = arguments[0];', section);
    await driver.wait(() => driver.findElement(By.id(button)).isDisplayed(), 10000);
    await driver.findElement(By.id(button)).click();
    await driver.findElement(By.id(input)).sendKeys('Unsaved draft');
    if (external) await send('openPage', { page: 'settings', section: 'new-tab' });
    else await driver.navigate().back();
    const destination = external ? 'new-tab' : 'appearance';
    await driver.wait(() => driver.findElement(By.id(destination)).isDisplayed(), 10000);
    assert.equal(await call('return document.getElementById(arguments[0]).open;', dialog), false);
    assert.equal(
      await call('return document.activeElement.id;'),
      `${external ? 'features' : destination}-title`,
    );
    await driver.findElement(By.css('nav a[href="#about"]')).click();
    await driver.wait(() => driver.findElement(By.id('about')).isDisplayed(), 10000);
  }
  assert.deepEqual((await send('getSettings')).newTab, beforeNavigation);
  assert.deepEqual(await send('getContainers'), beforeContainers);

  await call("location.hash = 'appearance';");
  await driver.wait(() => driver.findElement(By.id('appearance')).isDisplayed(), 10000);
  await driver.findElement(By.css('nav a[href="#containers"]')).click();
  await driver.findElement(By.id('container-new')).click();
  await driver.findElement(By.id('container-name')).sendKeys('Navigation save');
  await call(`
    const send = browser.runtime.sendMessage.bind(browser.runtime);
    window.navigationSave = { restore: () => browser.runtime.sendMessage = send };
    browser.runtime.sendMessage = async message => {
      if (message.type === 'tabernacle:createContainer')
        await new Promise(resolve => navigationSave.release = resolve);
      return send(message);
    };
  `);
  await driver.findElement(By.css('#container-editor button[type="submit"]')).click();
  await driver.wait(() => call('return Boolean(navigationSave.release);'), 10000);
  await driver.navigate().back();
  await driver.wait(() => driver.findElement(By.id('appearance')).isDisplayed(), 10000);
  assert(await driver.findElement(By.id('container-editor')).isDisplayed());
  await call('navigationSave.release();');
  await driver.wait(() => call('return !document.getElementById("container-editor").open;'), 10000);
  assert.equal(await call('return document.activeElement.id;'), 'appearance-title');
  const createdContainer = (await send('getContainers')).containers.find(
    (container) => container.name === 'Navigation save',
  );
  assert(createdContainer);
  await call('navigationSave.restore(); delete window.navigationSave;');
  await send('removeContainer', { cookieStoreId: createdContainer.cookieStoreId });
  assert.deepEqual(await send('getContainers'), beforeContainers);
  await call("location.hash = 'new-tab';");
  await driver.wait(() => driver.findElement(By.id('new-tab-add-link')).isDisplayed(), 10000);
  console.log(
    '✓ Settings section changes close idle editors and preserve an in-progress container save',
  );

  for (const restart of [false, true]) {
    const before = (await send('getSettings')).newTab;
    await call(`
      const send = browser.runtime.sendMessage.bind(browser.runtime);
      window.staleSettings = { hold:true, fail:false, send, restore:()=>browser.runtime.sendMessage=send };
      browser.runtime.sendMessage = async message => {
        if (message.type === 'tabernacle:getSettings') {
          if (staleSettings.fail) return {ok:false,error:'Temporary follow-up read failure'};
          if (staleSettings.hold) {
            staleSettings.hold=false;
            const value=await send(message);
            staleSettings.read=value.data;
            await new Promise(resolve=>staleSettings.release=resolve);
            return value;
          }
        }
        const value=await send(message);
        if (message.type === 'tabernacle:setNewTab') staleSettings.saved=value.data;
        return value;
      };
      window.dispatchEvent(new Event('focus'));
    `);
    await driver.wait(() => call('return Boolean(staleSettings.release);'), 10000);
    if (restart) {
      await driver.setContext(firefox.Context.CHROME);
      await driver.wait(
        () =>
          driver.executeAsyncScript(
            `
            const done=arguments[arguments.length-1];
            const extension=WebExtensionPolicy.getByID(arguments[0]).extension;
            extension.terminateBackground().then(()=>done(extension.backgroundState==='stopped'),()=>done(false));
          `,
            addonId,
          ),
        10000,
      );
      await driver.setContext(firefox.Context.CONTENT);
    }
    await driver.findElement(By.css('#nt-style option[value="list"]')).click();
    await driver.findElement(By.id('new-tab-save')).click();
    await driver.wait(
      () =>
        call(
          "return Boolean(staleSettings.saved) && document.getElementById('new-tab-status').textContent==='All changes saved';",
        ),
      10000,
    );
    assert.equal(
      await call('return staleSettings.saved.generation !== staleSettings.read.generation;'),
      restart,
    );
    await call('staleSettings.fail=true;staleSettings.release();');
    await driver.wait(
      () =>
        call(
          "return document.getElementById('page-error').textContent==='Temporary follow-up read failure';",
        ),
      10000,
    );
    assert.equal(await driver.findElement(By.id('nt-style')).getAttribute('value'), 'list');
    assert.equal(await driver.findElement(By.id('new-tab-status')).getText(), 'All changes saved');
    await call("staleSettings.restore();window.dispatchEvent(new Event('focus'));");
    await driver.wait(() => call("return document.getElementById('page-error').hidden;"), 10000);
    assert.deepEqual((await send('getSettings')).newTab, { ...before, linkStyle: 'list' });
    await driver.navigate().refresh();
    await driver.wait(
      async () => (await driver.findElement(By.id('nt-style')).getAttribute('value')) === 'list',
      10000,
    );
    assert.deepEqual((await send('getSettings')).newTab, { ...before, linkStyle: 'list' });
    await send('setNewTab', { value: before });
    await driver.wait(
      async () =>
        (await driver.findElement(By.id('nt-style')).getAttribute('value')) === before.linkStyle,
      10000,
    );
  }
  console.log('✓ Delayed Settings reads cannot revert new-tab saves across background restarts');

  await driver.findElement(By.id('new-tab-add-link')).click();
  await driver.findElement(By.id('nt-link-name')).sendKeys('Example');
  await driver.findElement(By.id('nt-link-url')).sendKeys('example.com:443/path?q=test#section');
  await driver.findElement(By.id('nt-link-submit')).click();
  for (const host of ['second.example.test', 'third.example.test']) {
    await driver.findElement(By.id('new-tab-add-link')).click();
    await driver.findElement(By.id('nt-link-name')).sendKeys('Example');
    await driver.findElement(By.id('nt-link-url')).sendKeys(`https://${host}/`);
    await driver.findElement(By.id('nt-link-submit')).click();
  }
  await driver.executeScript(
    'document.querySelectorAll(".nt-link-row")[0].querySelectorAll("button")[1].focus();',
  );
  for (const [index, direction] of [
    [1, 'down'],
    [2, 'up'],
    [1, 'up'],
    [0, 'down'],
  ]) {
    if (index === 1 && direction === 'down') {
      await driver.actions().keyDown(Key.SPACE).perform();
      await send('setLook', { partial: true, value: { colorScheme: 'dark' } });
      await driver.wait(
        () =>
          driver.executeScript('return document.documentElement.dataset.colorScheme === "dark";'),
        5000,
        'Appearance refresh arrives while the move key is held',
      );
      await driver.actions().keyUp(Key.SPACE).perform();
    } else await driver.actions().sendKeys(Key.SPACE).perform();
    assert.deepEqual(
      await driver.executeScript(
        `
        const row = document.querySelectorAll('.nt-link-row')[arguments[0]];
        return {host:row.querySelector('.nt-link-copy small').textContent,
          focused:row.contains(document.activeElement),
          action:document.activeElement.getAttribute('aria-label')};
      `,
        index,
      ),
      { host: 'example.com', focused: true, action: `Move Example ${direction}` },
    );
  }
  // The macOS headless pointer probe starts HTML drags but does not deliver drop.
  // Exercise the real Firefox DOM handlers here; the UI suite uses real pointer drops.
  for (const [source, target, after, expected] of [
    [0, 2, true, ['second.example.test', 'third.example.test', 'example.com']],
    [2, 0, false, ['example.com', 'second.example.test', 'third.example.test']],
    [0, 1, true, ['second.example.test', 'example.com', 'third.example.test']],
    [1, 0, false, ['example.com', 'second.example.test', 'third.example.test']],
  ]) {
    assert.deepEqual(
      await driver.executeScript(
        `
        const rows = [...document.querySelectorAll('.nt-link-row')];
        const source = rows[arguments[0]], target = rows[arguments[1]];
        const rect = target.getBoundingClientRect();
        const dataTransfer = new DataTransfer();
        const options = {bubbles:true,cancelable:true,dataTransfer,
          clientX:rect.left+24,clientY:arguments[2]?rect.bottom-3:rect.top+3};
        source.dispatchEvent(new DragEvent('dragstart',options));
        target.dispatchEvent(new DragEvent('dragover',options));
        target.dispatchEvent(new DragEvent('drop',options));
        source.dispatchEvent(new DragEvent('dragend',options));
        return [...document.querySelectorAll('.nt-link-copy small')].map(node=>node.textContent);
      `,
        source,
        target,
        after,
      ),
      expected,
    );
    if (source === 0 && target === 1 && after) {
      await driver.findElement(By.id('new-tab-save')).click();
      await driver.wait(
        async () =>
          (await driver.findElement(By.id('new-tab-status')).getText()) === 'All changes saved',
        10000,
      );
      await driver.navigate().refresh();
      await driver.wait(
        async () => (await driver.findElements(By.css('.nt-link-row'))).length === 3,
        10000,
      );
      assert.deepEqual(
        await driver.executeScript(
          "return [...document.querySelectorAll('.nt-link-copy small')].map(node=>node.textContent);",
        ),
        expected,
        'The dragged order survives saving and reloading the settings page',
      );
    }
  }
  for (let remaining = 3; remaining > 1; remaining--)
    await driver
      .findElement(
        By.css(`.nt-link-row:nth-child(${remaining}) button[aria-label="Remove Example"]`),
      )
      .click();
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
  assert.equal(
    (await send('getSettings')).newTab.links[0].url,
    'https://example.com/path?q=test#section',
    'A link entered with a port keeps its complete address after saving and reloading',
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

  for (const mode of ['permission', 'success', 'failure']) {
    await driver.switchTo().window(settingsHandle);
    await driver.navigate().refresh();
    await driver.wait(() => driver.findElement(By.id('new-tab-add-link')).isEnabled(), 10000);

    const allowWeather = async () => {
      await driver.setContext(firefox.Context.CHROME);
      await driver.executeAsyncScript(
        `const [id,access,done]=arguments;const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');ExtensionPermissions.add(id,{permissions:[],...access},WebExtensionPolicy.getByID(id).extension).then(()=>done(true));`,
        addonId,
        WEATHER_ACCESS,
      );
      await driver.setContext(firefox.Context.CONTENT);
    };

    await allowWeather();
    await call(
      `const mode=arguments[0];
      const state=window.weatherRevocation={mode,requests:0,holdRemoval:true};
      const permission=browser.permissions.request.bind(browser.permissions);
      const send=browser.runtime.sendMessage.bind(browser.runtime);
      browser.permissions.request=async access=>{
        const allowed=await permission(access);
        if(state.mode==='permission')await new Promise(resolve=>state.release=resolve);
        return allowed;
      };
      browser.runtime.sendMessage=async message=>{
        if(message.type==='tabernacle:setNewTab'&&message.value.weatherEnabled===false&&state.holdRemoval){
          state.holdRemoval=false;
          const result=await send(message);
          await new Promise(resolve=>state.releaseRemoval=resolve);
          return state.mode==='failure'?{ok:false,error:'Removal reply lost'}:result;
        }
        if(message.type!=='tabernacle:weatherLocations')return send(message);
        state.requests++;
        if(['success','failure'].includes(state.mode))
          await new Promise(resolve=>state.release=resolve);
        return state.mode==='failure'
          ? {ok:false,error:'Old location lookup failed'}
          : {ok:true,data:[{name:state.mode==='fresh'?'Current York result':'Old York result',
              latitude:53.95,longitude:-1.08}]};
      };`,
      mode,
    );
    await driver.findElement(By.id('nt-location-query')).clear();
    await driver.findElement(By.id('nt-location-query')).sendKeys('York');
    await driver.findElement(By.id('nt-find-location')).click();
    await driver.wait(() => call('return Boolean(weatherRevocation.release);'), 10000);
    if (mode === 'permission')
      await driver.findElement(By.css('#nt-style option[value="list"]')).click();
    await driver.findElement(By.id('nt-remove-weather')).click();
    await driver.wait(() => call('return Boolean(weatherRevocation.releaseRemoval);'), 10000);
    for (const id of [
      'nt-location-query',
      'nt-find-location',
      'nt-remove-weather',
      'nt-style',
      'new-tab-save',
      'new-tab-discard',
      'new-tab-preview',
    ])
      assert.equal(await driver.findElement(By.id(id)).isEnabled(), false);
    assert.equal(await driver.findElement(By.id('new-tab-status')).getText(), 'Saving…');
    assert.equal(
      await call(
        `const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;`,
      ),
      true,
    );
    await call('weatherRevocation.releaseRemoval();');
    if (mode === 'failure') {
      await driver.wait(
        async () =>
          (await driver.findElement(By.id('nt-weather-error')).getText()) === 'Removal reply lost',
        10000,
      );
      assert(await driver.findElement(By.id('nt-remove-weather')).isEnabled());
      await driver.findElement(By.id('nt-remove-weather')).click();
    }
    await driver.wait(
      async () =>
        (await driver.findElement(By.id('nt-location-status')).getText()) ===
        'Weather access removed.',
      10000,
    );
    if (mode === 'permission') {
      assert.equal(await driver.findElement(By.id('nt-style')).getAttribute('value'), 'list');
      assert.equal(await driver.findElement(By.id('new-tab-status')).getText(), 'Unsaved changes');
      await driver.findElement(By.id('new-tab-discard')).click();
      assert.equal(await driver.findElement(By.id('nt-style')).getAttribute('value'), 'icons');
    }
    assert.equal(
      await call('return browser.permissions.contains(arguments[0]);', WEATHER_ACCESS),
      false,
    );
    await call('weatherRevocation.release();');
    // Flush the released message continuation before asserting it has no effect.
    await call('await new Promise(resolve=>setTimeout(resolve,100));');
    assert.deepEqual(
      await call(`return {
        requests:weatherRevocation.requests,
        results:document.getElementById('nt-location-results').childElementCount,
        status:document.getElementById('nt-location-status').textContent,
        error:document.getElementById('nt-weather-error').hidden?'':
          document.getElementById('nt-weather-error').textContent
      };`),
      {
        requests: mode === 'permission' ? 0 : 1,
        results: 0,
        status: 'Weather access removed.',
        error: '',
      },
    );
    assert(await driver.findElement(By.id('nt-find-location')).isEnabled());
    await call("weatherRevocation.mode='fresh';");
    await allowWeather();
    await driver.findElement(By.id('nt-find-location')).click();
    await driver.wait(
      async () =>
        (await driver.findElement(By.id('nt-location-results')).getText()) ===
        'Current York result',
      10000,
    );
    await driver.findElement(By.css('#nt-location-results button')).click();
    await driver.findElement(By.css('[name="weatherEnabled"]')).click();
    await driver.findElement(By.id('new-tab-save')).click();
    await driver.wait(
      async () =>
        (await driver.findElement(By.id('new-tab-status')).getText()) === 'All changes saved',
      10000,
    );
    assert.equal((await send('getSettings')).newTab.weatherEnabled, true);
    assert.equal((await send('getSettings')).newTab.location.name, 'Current York result');
    await driver.findElement(By.id('nt-find-location')).click();
    await driver.wait(
      () => call("return document.getElementById('nt-location-results').childElementCount === 1;"),
      10000,
    );
    await driver.findElement(By.id('nt-remove-weather')).click();
    await driver.wait(
      async () =>
        (await driver.findElement(By.id('nt-location-status')).getText()) ===
        'Weather access removed.',
      10000,
    );
    assert.equal(
      await call("return document.getElementById('nt-location-results').childElementCount;"),
      0,
    );
  }
  await driver.navigate().refresh();
  await driver.switchTo().window(activeHandle);
  console.log(
    '✓ Weather removal protects pending saves, retries, drafts and fresh permission/location choices',
  );
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
  await call(`
    const send = browser.runtime.sendMessage.bind(browser.runtime);
    window.newTabPress = { completed: 0 };
    document.addEventListener('pointerdown', event => {
      newTabPress.target = event.target.closest('#links a');
    }, {once:true});
    browser.runtime.sendMessage = async message => {
      const result = await send(message);
      if (message.type === 'tabernacle:getNewTabState') newTabPress.completed++;
      return result;
    };
  `);
  await driver
    .actions()
    .move({ origin: await driver.findElement(By.css('#links a')) })
    .press()
    .perform();
  assert(await call('return Boolean(newTabPress.target);'), 'The native pointer must press a link');
  await call('newTabPress.completed = 0;');
  await send('renameGroup', { id: group.createdGroupId, name: 'Work updated' });
  await driver.wait(() => call('return newTabPress.completed > 0;'), 10000);
  assert(
    await call('return newTabPress.target.isConnected;'),
    'A refresh must retain the pressed link',
  );
  await driver.actions().release().perform();
  await driver.wait(
    async () => (await driver.getCurrentUrl()).startsWith('https://example.com/'),
    10000,
  );
  console.log('✓ Native new-tab link activation survives a background refresh');
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
  const toClose = await send('newTab', { groupId: group.createdGroupId });
  const closedUrl = 'https://example.com/?closed-from-new-tab=1';
  await call(
    'await browser.tabs.update(arguments[0], {url:arguments[1], active:false});',
    toClose.createdTabId,
    closedUrl,
  );
  await driver.wait(async () => {
    const tab = await call('return browser.tabs.get(arguments[0]);', toClose.createdTabId);
    return tab.url === closedUrl && tab.status === 'complete';
  }, 15000);
  await send('snapshot');
  await send('closeTab', { id: toClose.createdTabId });
  let closure;
  await driver.wait(
    async () => {
      closure = (await send('snapshot')).recentlyClosed.find((item) => item.url === closedUrl);
      return Boolean(closure);
    },
    10000,
    'Firefox must record the closed tab before it can be restored',
  );
  await driver.switchTo().window(activeHandle);
  await driver.navigate().refresh();
  const closedRow = By.css(`[data-key="closed-${closure.sessionId}"]`);
  await driver.wait(async () => {
    const rows = await driver.findElements(closedRow);
    return rows.length > 0 && (await rows[0].isDisplayed());
  }, 10000);
  assert.equal((await driver.findElements(By.id('folders-section'))).length, 0);
  assert.equal(await driver.findElement(By.css('.recent-day-heading')).getText(), 'Today');
  await driver.findElement(closedRow).click();
  let restored;
  await driver.wait(async () => {
    restored = (await send('snapshot')).tabs.find((item) => item.url === closedUrl);
    return Boolean(restored);
  }, 10000);
  assert.equal(restored.groupId, group.createdGroupId);
  assert.equal(restored.cookieStoreId, container.cookieStoreId);
  assert.equal(
    (await send('snapshot')).recentlyClosed.some((item) => item.sessionId === closure.sessionId),
    false,
  );
  console.log('✓ Grouped recently closed list restores the original folder and Firefox container');
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
  await driver.switchTo().window(settingsHandle);
  await call("location.hash = 'features';");
  await driver.wait(
    () => driver.findElement(By.css('#features input[name="enabled"]')).isDisplayed(),
    10000,
  );
  assert.equal(
    await driver.findElement(By.css('#features input[name="enabled"]')).isSelected(),
    true,
  );
  await driver.findElement(By.css('#features input[name="enabled"]')).click();
  await driver.findElement(By.id('new-tab-save')).click();
  await driver.wait(
    async () =>
      (await driver.findElement(By.id('new-tab-status')).getText()) === 'All changes saved',
    10000,
  );
  await driver.navigate().refresh();
  await driver.wait(
    () => driver.findElement(By.css('#features input[name="enabled"]')).isEnabled(),
    10000,
  );
  assert.equal(
    await driver.findElement(By.css('#features input[name="enabled"]')).isSelected(),
    false,
  );
  await driver.switchTo().window(activeHandle);
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
