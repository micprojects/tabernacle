import assert from 'node:assert/strict';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { download } from 'geckodriver';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

// Every run owns both its profile and app data. Never attach a test to a
// running browser, even when Firefox is already open on the developer's Mac.
export async function startFirefox({ configure, stdio, options = new firefox.Options() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tabernacle-firefox-'));
  let driver, closing;

  const close = () => {
    closing ??= (async () => {
      try {
        await driver?.quit();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    })();
    return closing;
  };

  try {
    const appData = join(root, 'app-data');
    await mkdir(appData);
    // Pending application updates run before profile preferences are loaded and
    // can relaunch outside our process tree. Every session has a fresh profile:
    // skip startup update processing, then disable updates during automation.
    options.addArguments('-headless', '-no-remote', '-first-startup');
    if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
    else if (process.platform === 'darwin')
      options.setBinary('/Applications/Firefox.app/Contents/MacOS/firefox');
    options.setPreference('browser.shell.checkDefaultBrowser', false);
    options.setPreference('browser.startup.page', 0);
    options.setPreference('browser.tabs.warnOnClose', false);
    await configure?.(options, root);
    options.setPreference('app.update.disabledForTesting', true);
    const service = new firefox.ServiceBuilder(
      process.env.GECKODRIVER_BINARY || (await download('0.37.1')),
    )
      .addArguments('--allow-system-access', '--profile-root', root)
      .setEnvironment({ ...process.env, MOZ_APP_DATA: appData });
    if (stdio) service.setStdio(stdio);
    driver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .setFirefoxService(service)
      .build();
    const capabilities = await driver.getCapabilities();
    const profile = await realpath(capabilities.get('moz:profile'));
    const ownedPath = relative(await realpath(root), profile);
    assert(
      ownedPath && !ownedPath.startsWith('..') && !isAbsolute(ownedPath),
      'Refusing to test an unexpected Firefox profile',
    );
    return { driver, root, close, profile, version: capabilities.get('browserVersion') };
  } catch (error) {
    await close();
    throw error;
  }
}
