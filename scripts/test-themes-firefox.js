import assert from 'node:assert/strict';
import { Builder, By, Key, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { download } from 'geckodriver';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { knownThemes } from '../extension/src/theme-palette.js';

const options = new firefox.Options().addArguments('-headless');
options.setBinary(process.env.FIREFOX_BINARY || '/Applications/Firefox.app/Contents/MacOS/firefox');
options.setPreference('browser.shell.checkDefaultBrowser', false);
options.setPreference('browser.nova.enabled', true);
options.setPreference('sidebar.verticalTabs', true);
const root = await mkdtemp(join(tmpdir(), 'tabernacle-theme-firefox-'));
const appData = join(root, 'app-data');
await mkdir(appData);
await mkdir('test-results', { recursive: true });
let driver;
try {
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
  await driver.manage().window().setRect({ width: 1000, height: 850 });
  const addonId = await driver.installAddon(resolve('extension'), true);
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(
    'const box=document.getElementById("sidebar-box");if(box){box.style.setProperty("width","340px","important");box.style.setProperty("min-width","340px","important");box.style.setProperty("max-width","none","important");}',
  );
  const uuid = await driver.executeScript(
    'return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[arguments[0]];',
    addonId,
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(`moz-extension://${uuid}/sidebar.html`);
  await driver.wait(until.elementLocated(By.css('.tab-row')), 15000);

  const browserCall = (body, ...args) =>
    driver.executeAsyncScript(
      `const done=arguments[arguments.length-1]; (async()=>{${body}})().then(done,error=>done({error:error.message}));`,
      ...args,
    );

  await browserCall(
    'await browser.tabs.create({ pinned: true, active: false, url: "about:blank" }); return true;',
  );
  const mismatches = [];
  for (const dark of [false, true]) {
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeScript(
      'Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[0]);',
      dark ? 1 : 0,
    );
    await driver.setContext(firefox.Context.CONTENT);
    for (const theme of knownThemes) {
      if (theme.id === 'default-theme@mozilla.org') {
        await browserCall(
          'await browser.management.setEnabled(arguments[0], true); return true;',
          theme.id,
        );
      } else {
        const path = join(root, theme.name);
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'manifest.json'), JSON.stringify(theme.manifest));
        await driver.installAddon(path, true);
        await browserCall(
          'await browser.management.setEnabled(arguments[0], true); return true;',
          theme.id,
        );
      }
      await driver.wait(
        async () => {
          const value = await driver.executeScript(
            'return { scheme: document.documentElement.dataset.colorScheme, background: document.documentElement.style.getPropertyValue("--background") };',
          );
          const expected = theme.manifest[dark ? 'dark_theme' : 'theme'].colors.frame;
          const color = Array.isArray(expected) ? `rgb(${expected.join(', ')})` : expected;
          return value.scheme === (dark ? 'dark' : 'light') && value.background === color;
        },
        10000,
        `${theme.name}/${dark} automatic detection`,
      );
      const active = await browserCall(
        'return (await browser.management.getAll()).find(addon => addon.type === "theme" && addon.enabled);',
      );
      assert.equal(active.id, theme.id);
      // Compare resolved Firefox chrome colours with the extension's adapter.
      await driver.setContext(firefox.Context.CHROME);
      const native = await driver.executeScript(`
        const names = ['--toolbox-background-color','--tab-background-color-selected','--tab-text-color-selected','--panel-background-color','--panel-text-color','--toolbar-field-background-color', '--toolbar-text-color', '--toolbarbutton-icon-fill', '--panel-border-color', '--toolbar-field-background-color-focus', '--toolbar-field-text-color-focus', '--toolbar-field-border-color', '--toolbar-field-text-color', '--toolbarbutton-background-color-hover', '--toolbarbutton-background-color-active', '--color-accent-primary', '--focus-outline-color'];
        const node = document.createElementNS('http://www.w3.org/1999/xhtml','div'); document.documentElement.append(node);
        const result={}; for(const name of names) { node.style.color='var('+name+')'; result[name]=getComputedStyle(node).color; } node.remove(); return result;
      `);
      await driver.setContext(firefox.Context.CONTENT);
      const actual = await driver.executeScript(`
        const names = ['--background','--selected','--selected-text','--panel','--panel-text','--field','--toolbar-text','--toolbar-icon','--panel-line','--field-focus','--field-focus-text','--field-line','--field-text','--toolbar-hover','--toolbar-active','--accent','--focus'];
        const node=document.createElement('div');document.body.append(node);const result={}; for(const name of names){node.style.color='var('+name+')';result[name]=getComputedStyle(node).color;}node.remove();return result;
      `);
      for (const [nativeKey, key] of Object.entries({
        '--toolbox-background-color': '--background',
        '--tab-background-color-selected': '--selected',
        '--tab-text-color-selected': '--selected-text',
        '--panel-background-color': '--panel',
        '--panel-text-color': '--panel-text',
        '--toolbar-field-background-color': '--field',
        '--toolbar-text-color': '--toolbar-text',
        '--toolbarbutton-icon-fill': '--toolbar-icon',
        '--panel-border-color': '--panel-line',
        '--toolbar-field-background-color-focus': '--field-focus',
        '--toolbar-field-text-color-focus': '--field-focus-text',
        '--toolbar-field-border-color': '--field-line',
        '--toolbar-field-text-color': '--field-text',
        '--toolbarbutton-background-color-hover': '--toolbar-hover',
        '--toolbarbutton-background-color-active': '--toolbar-active',
        '--color-accent-primary': '--accent',
        '--focus-outline-color': '--focus',
      })) {
        // App actions and focus use the selected theme's roles. Firefox chrome
        // uses the OS accent for these controls in custom themes.
        if (theme.id !== 'default-theme@mozilla.org' && ['--accent', '--focus'].includes(key))
          continue;
        if (actual[key] !== native[nativeKey])
          mismatches.push({
            theme: theme.name,
            dark,
            key,
            actual: actual[key],
            native: native[nativeKey],
          });
      }
      const newTab = await driver.executeScript(`
        const button = document.querySelector('.new-tab-action');
        button.focus();
        return { text: getComputedStyle(button).color, themeText: getComputedStyle(document.documentElement).color };
      `);
      assert.equal(newTab.text, newTab.themeText, `${theme.name}/${dark} New tab colour`);
      if (['Firefox Default', 'Sun', 'Pine', 'Lavender'].includes(theme.name))
        await writeFile(
          `test-results/firefox-theme-${theme.name.toLowerCase().replaceAll(' ', '-')}-${dark ? 'dark' : 'light'}.png`,
          await driver.takeScreenshot(),
          'base64',
        );
      if (theme.name === 'Sun') {
        await driver.findElement(By.id('search-toggle')).click();
        await driver.findElement(By.id('search')).sendKeys('blank');
        await driver.wait(
          async () =>
            driver.executeScript(`
          const probe=document.createElement('div');probe.style.backgroundColor='var(--field-focus)';document.body.append(probe);
          const expected=getComputedStyle(probe).backgroundColor;probe.remove();
          return getComputedStyle(document.getElementById('search')).backgroundColor===expected && getComputedStyle(document.getElementById('navigation-capsule')).backgroundColor===expected;
        `),
          5000,
          'Search input and capsule use the focused field surface',
        );
        await writeFile(
          `test-results/firefox-theme-search-${dark ? 'dark' : 'light'}.png`,
          await driver.takeScreenshot(),
          'base64',
        );
        await driver.findElement(By.id('search-close')).click();
        await driver.findElement(By.id('tree')).sendKeys(Key.chord(Key.SHIFT, Key.F10));
        await writeFile(
          `test-results/firefox-theme-menu-${dark ? 'dark' : 'light'}.png`,
          await driver.takeScreenshot(),
          'base64',
        );
        await driver.get(`moz-extension://${uuid}/settings.html`);
        await driver.wait(until.elementLocated(By.id('look-theme-source')), 5000);
        await driver.wait(
          async () =>
            driver.executeScript('return !document.getElementById("appearance-fields").disabled;'),
          5000,
        );
        await writeFile(
          `test-results/firefox-theme-settings-${dark ? 'dark' : 'light'}.png`,
          await driver.takeScreenshot(),
          'base64',
        );
        await driver.get(`moz-extension://${uuid}/sidebar.html`);
        await driver.wait(until.elementLocated(By.css('.row.active')), 5000);
      }
      console.log(
        `✓ ${theme.name} ${dark ? 'dark' : 'light'}: identity, variant and native colour roles`,
      );
    }
  }
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(
    'Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", 1);',
  );
  await driver.setContext(firefox.Context.CONTENT);

  await driver.wait(
    async () =>
      !(await driver.executeScript('return matchMedia("(prefers-color-scheme: dark)").matches;')),
    5000,
  );
  await driver.wait(
    async () =>
      (await driver.executeScript('return document.documentElement.dataset.colorScheme;')) ===
      'light',
    5000,
  );
  const sidebar = await browserCall(
    `const view=browser.extension.getViews({type:'sidebar'})[0];return {dark:view.matchMedia('(prefers-color-scheme: dark)').matches, scheme:view.document.documentElement.dataset.colorScheme};`,
  );
  assert.deepEqual(
    sidebar,
    { dark: true, scheme: 'dark' },
    'The actual sidebar follows browser chrome independently of website colour overrides',
  );
  console.log(
    '✓ Actual sidebar remains dark when the website colour preference is overridden to light',
  );
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(
    'Services.prefs.clearUserPref("layout.css.prefers-color-scheme.content-override");',
  );
  await driver.setContext(firefox.Context.CONTENT);
  assert.deepEqual(mismatches, []);
  const externalPath = join(root, 'external');
  await mkdir(externalPath);
  await writeFile(
    join(externalPath, 'manifest.json'),
    JSON.stringify({
      manifest_version: 2,
      name: 'External test',
      version: '1.0',
      browser_specific_settings: { gecko: { id: 'external-theme@test' } },
      theme: {
        colors: {
          frame: '#123456',
          tab_background_text: '#ffffff',
          toolbar: '#234567',
          tab_selected: '#345678',
          popup: '#102030',
          popup_text: '#ffffff',
        },
      },
      dark_theme: {
        colors: { frame: '#880000', tab_background_text: '#ffffff', toolbar: '#770000' },
      },
    }),
  );
  await driver.installAddon(externalPath, true);
  await browserCall(
    'await browser.management.setEnabled("external-theme@test", true); return true;',
  );
  await driver.wait(
    async () =>
      (await driver.executeScript(
        'return document.documentElement.style.getPropertyValue("--background");',
      )) === '#123456',
    5000,
  );
  const exposed = await browserCall(
    'return await browser.theme.getCurrent((await browser.windows.getCurrent()).id);',
  );
  assert.equal(
    exposed.colors.frame,
    '#123456',
    'Firefox exposes the base palette, including while its separate dark variant is active',
  );
  assert.equal(
    await driver.executeScript(
      'return getComputedStyle(document.querySelector(".sidebar")).backgroundImage;',
    ),
    'none',
  );
  console.log('✓ Third-party exposed colours and the separate dark-variant API limitation');
} finally {
  await driver?.quit();
  await rm(root, { recursive: true, force: true });
}
