import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { previewServer } from './preview.js';

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
