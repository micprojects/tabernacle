import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { previewServer } from '../../scripts/preview.js';

// Share browser setup and cleanup, while keeping each scenario a plain script.
export async function startUiTest(options = {}) {
  await mkdir('test-results', { recursive: true });
  const server = await previewServer(0);
  let browser;

  const close = async () => {
    try {
      await browser?.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    });
    const page = await browser.newPage({ deviceScaleFactor: 2, ...options });
    return { server, page, close, base: `http://127.0.0.1:${server.address().port}` };
  } catch (error) {
    await close();
    throw error;
  }
}

// Exercise the keyboard event an active text composition owns, without relying
// on an OS input-method installation in the browser-test environment.
export function composingKey(locator, key) {
  return locator.evaluate((node, key) => {
    const event = new KeyboardEvent('keydown', {
      key,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  }, key);
}
