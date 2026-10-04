import test from 'node:test';
import assert from 'node:assert/strict';
import { previewServer } from '../scripts/preview.js';

async function fixture(t) {
  const server = await previewServer(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('preview serves the UI and adapter but not repository files', async (t) => {
  const { base } = await fixture(t);
  for (const path of [
    '/',
    '/extension/sidebar.html?demo',
    '/extension/manifest.json',
    '/preview/browser.js',
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    await response.arrayBuffer();
  }
  for (const path of [
    '/.git/config',
    '/package.json',
    '/scripts/preview.js',
    '/preview/%2e%2e%2fpackage.json',
    '/%invalid',
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    await response.arrayBuffer();
  }
  const post = await fetch(base, { method: 'POST' });
  assert.equal(post.status, 405);
  await post.arrayBuffer();
  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('preview rejects untrusted Host headers', async (t) => {
  const { base } = await fixture(t);
  const { request } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = request(base, { headers: { Host: 'untrusted.example' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('a busy preview port rejects cleanly', async (t) => {
  const { server } = await fixture(t);
  await assert.rejects(previewServer(server.address().port), { code: 'EADDRINUSE' });
});
