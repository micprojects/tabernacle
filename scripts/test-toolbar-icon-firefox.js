import assert from 'node:assert/strict';
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { download } from 'geckodriver';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { knownThemes } from '../extension/src/theme-palette.js';

const root = await mkdtemp(join(tmpdir(), 'tabernacle-toolbar-firefox-'));
const appData = join(root, 'app-data');
await mkdir(appData);
await mkdir('test-results', { recursive: true });
const options = new firefox.Options().addArguments('-headless', '-no-remote');
options.setBinary(process.env.FIREFOX_BINARY || '/Applications/Firefox.app/Contents/MacOS/firefox');
options.setPreference('browser.shell.checkDefaultBrowser', false);
options.setPreference('browser.nova.enabled', true);
// Browser icons must ignore a conflicting website appearance preference.
options.setPreference('layout.css.prefers-color-scheme.content-override', 1);
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
  const uuid = await driver.executeScript(
    `
    const { CustomizableUI } = ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs');
    CustomizableUI.addWidgetToArea('tabernacle_michaelprojects_com-browser-action', CustomizableUI.AREA_NAVBAR);
    return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))[arguments[0]];
  `,
    addonId,
  );

  const browserCall = async (body, ...args) => {
    await driver.setContext(firefox.Context.CONTENT);
    const result = await driver.executeAsyncScript(
      `const done=arguments[arguments.length-1];(async()=>{${body}})().then(value=>done({value}),error=>done({error:error.message}));`,
      ...args,
    );
    assert(!result.error, result.error);
    return result.value;
  };

  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(`moz-extension://${uuid}/settings.html`);
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript('window.SidebarController.hide();');
  await driver.wait(
    async () => !(await browserCall('return await browser.sidebarAction.isOpen({});')),
    5000,
    'Sidebar is closed for toolbar checks',
  );

  async function checkIcon(label, color) {
    await driver.setContext(firefox.Context.CHROME);
    const selector = '#tabernacle_michaelprojects_com-browser-action .toolbarbutton-icon';
    const expected = Array.isArray(color)
      ? color.slice(0, 3)
      : [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
    let png, native;
    await driver
      .wait(
        async () => {
          native = await driver.executeScript(
            `
        const icon=document.querySelector(arguments[0]);
        const probe=document.createElementNS('http://www.w3.org/1999/xhtml','span');
        probe.style.color='var(--toolbarbutton-icon-fill)';icon.parentElement.append(probe);
        const color=getComputedStyle(probe).color;probe.remove();
        return {color, path:getComputedStyle(icon).listStyleImage, width:icon.getBoundingClientRect().width};
      `,
            selector,
          );
          const actual = native.color
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number);
          if (!actual.every((value, channel) => value === expected[channel])) return false;
          png = Buffer.from(await driver.findElement(By.css(selector)).takeScreenshot(), 'base64');
          const { data, info } = await sharp(png)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          let matching = 0;
          for (let i = 0; i < data.length; i += info.channels)
            if (expected.every((value, channel) => Math.abs(data[i + channel] - value) <= 1))
              matching++;
          return matching >= 8;
        },
        10000,
        `${label}: painted toolbar pixels must match Firefox's icon colour`,
      )
      .catch(async (error) => {
        console.error({ label, expected, native });
        if (png) await writeFile(`test-results/toolbar-failed-${label}.png`, png);
        throw error;
      });
    assert.equal(native.width, 16);
    await writeFile(`test-results/toolbar-${label}.png`, png);
    if (label.startsWith('firefox-default') || label.startsWith('pine-'))
      await writeFile(
        `test-results/toolbar-context-${label}.png`,
        await driver.findElement(By.id('nav-bar')).takeScreenshot(),
        'base64',
      );
    console.log(`✓ ${label}: actual toolbar pixels match ${native.color}`);
  }

  for (const theme of knownThemes) {
    if (theme.id !== 'default-theme@mozilla.org') {
      const directory = join(root, theme.name);
      await mkdir(directory);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(theme.manifest));
      await driver.installAddon(directory, true);
    }
    await browserCall('await browser.management.setEnabled(arguments[0], true);', theme.id);
    for (const dark of [false, true]) {
      await driver.setContext(firefox.Context.CHROME);
      await driver.executeScript(
        'Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[0]);',
        dark ? 1 : 0,
      );
      await checkIcon(
        `${theme.name.toLowerCase().replaceAll(' ', '-')}-${dark ? 'dark' : 'light'}`,
        theme.manifest[dark ? 'dark_theme' : 'theme'].colors.icons,
      );
    }
  }
  await browserCall('await browser.management.setEnabled("default-theme@mozilla.org", true);');
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript('Services.prefs.setCharPref("layout.css.devPixelsPerPx", "2.0");');
  for (const dark of [false, true]) {
    await driver.executeScript(
      'Services.prefs.setIntPref("ui.systemUsesDarkTheme", arguments[0]);',
      dark ? 1 : 0,
    );
    await checkIcon(
      `firefox-default-retina-${dark ? 'dark' : 'light'}`,
      knownThemes[0].manifest[dark ? 'dark_theme' : 'theme'].colors.icons,
    );
    const meta = await sharp(
      `test-results/toolbar-firefox-default-retina-${dark ? 'dark' : 'light'}.png`,
    ).metadata();
    assert.equal(meta.width, 32, 'Retina toolbar screenshot uses 32 device pixels');
  }

  // Keep the user's sidebar preference separate from browser toolbar appearance.
  await browserCall(`
    const response = await browser.runtime.sendMessage({type:'tabernacle:setLook', windowId:(await browser.windows.getCurrent()).id, value:{themeSource:'tabernacle',colorScheme:'light',connectingLines:true,domains:false}});
    if (!response.ok) throw new Error(response.error);
  `);
  await checkIcon('monochrome-sidebar', knownThemes[0].manifest.dark_theme.colors.icons);

  await driver.setContext(firefox.Context.CONTENT);
  const firstHandle = await driver.getWindowHandle();
  const previousHandles = new Set(await driver.getAllWindowHandles());
  const firstId = await browserCall('return (await browser.windows.getCurrent()).id;');
  const secondId = await browserCall(
    'return (await browser.windows.create({url:"about:blank"})).id;',
  );
  const handles = await driver.getAllWindowHandles();
  const secondHandle = handles.find((handle) => !previousHandles.has(handle));
  assert(secondHandle, 'New Firefox window has a new WebDriver handle');
  const helper = join(root, 'per-window-theme');
  await mkdir(helper);
  await writeFile(
    join(helper, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Toolbar theme test',
      version: '1.0',
      permissions: ['theme'],
      background: { scripts: ['background.js'] },
      browser_specific_settings: { gecko: { id: 'toolbar-theme-test@example.test' } },
    }),
  );
  await writeFile(
    join(helper, 'background.js'),
    `
    for (const [id, color] of ${JSON.stringify([
      [firstId, '#9b2244'],
      [secondId, '#176d50'],
    ])})
      browser.theme.update(id, { colors: { frame:'#eeeeee', tab_background_text:'#15141a', toolbar:'#ffffff', icons:color } });
  `,
  );
  await driver.installAddon(helper, true);
  await driver.switchTo().window(firstHandle);
  await checkIcon('per-window-first', '#9b2244');
  await driver.setContext(firefox.Context.CONTENT);
  await driver.switchTo().window(secondHandle);
  await checkIcon('per-window-second', '#176d50');
} finally {
  await driver?.quit();
  await rm(root, { recursive: true, force: true });
}
