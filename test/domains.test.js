import test from 'node:test';
import assert from 'node:assert/strict';
import { listDomains, normaliseDomainPins } from '../extension/src/domains.js';
import { matchesDomain } from '../extension/src/domain-filter.js';
import { createController } from '../extension/src/controller.js';
import { MODEL_KEY } from '../extension/src/model.js';
import { memoryBrowser } from '../preview/browser.js';

test('directory counts agree with domain filters, including child hosts and www aliases', () => {
  const tabs = [
    'https://www.youtube.com/watch?v=1',
    'https://youtube.com/watch?v=2',
    'https://music.youtube.com/one',
    'https://music.youtube.com/two',
    'https://notyoutube.com/one',
    'https://example.com/path/youtube.com',
    'https://EXAMPLE.com./two',
    'file:///example.com',
    'about:blank',
    'https://single.example.org/',
  ].map((url, id) => ({ id, url }));
  const before = structuredClone(tabs);
  const domains = listDomains(tabs);
  assert.deepEqual(
    domains.map(({ domain, count }) => [domain, count]),
    [
      ['youtube.com', 4],
      ['example.com', 2],
      ['music.youtube.com', 2],
    ],
  );
  for (const entry of domains)
    assert.equal(entry.count, tabs.filter((tab) => matchesDomain(tab, entry.domain)).length);
  assert.deepEqual(tabs, before);
});

test('pins lead, each section is sorted by count, and pinned domains remain at one tab', () => {
  const tabs = ['a.test', 'a.test', 'a.test', 'b.test', 'b.test', 'c.test'].map((host, id) => ({
    id,
    url: `https://${host}/${id}`,
    ...(id === 4 ? { favIconUrl: 'data:image/png;base64,example' } : {}),
  }));
  const entries = listDomains(tabs, ['b.test', 'c.test']);
  assert.deepEqual(
    entries.map(({ domain, pinned }) => [domain, pinned]),
    [
      ['b.test', true],
      ['c.test', true],
      ['a.test', false],
    ],
  );
  assert.equal(entries[0].source.id, 4);
  assert.deepEqual(listDomains([], ['b.test']), []);
  const next = listDomains([...tabs, { id: 6, url: 'https://c.test/two' }], ['c.test']);
  assert.equal(next[0].domain, 'c.test');
  assert.equal(next[0].pinned, true);
});

test('saved domain pins are validated and deduplicated', () => {
  assert.deepEqual(normaliseDomainPins(null), []);
  assert.deepEqual(
    normaliseDomainPins([
      'WWW.Example.com.',
      'example.com',
      null,
      '',
      'https://bad.test/',
      'a b',
      '[::1]',
    ]),
    ['example.com', '[::1]'],
  );
});

test('domain pins persist, serialize concurrent windows and publish to every sidebar', async () => {
  const api = memoryBrowser({
    tabs: [
      { id: 1, windowId: 1, url: 'https://a.test', index: 0 },
      { id: 2, windowId: 2, url: 'https://b.test', index: 0 },
    ],
  });
  const notices = [];
  const controller = createController(api, (notice) => notices.push(notice));
  await Promise.all([
    controller.request({ type: 'setDomainPin', windowId: 1, domain: 'www.a.test', pinned: true }),
    controller.request({ type: 'setDomainPin', windowId: 2, domain: 'b.test', pinned: true }),
  ]);
  const reopened = createController(api);
  assert.deepEqual((await reopened.request({ type: 'snapshot', windowId: 1 })).domainPins, [
    'a.test',
    'b.test',
  ]);
  assert.ok(notices.length >= 2);
  assert.ok(notices.every((notice) => notice.windowId === undefined));
  const next = await reopened.request({
    type: 'setDomainPin',
    windowId: 2,
    domain: 'a.test',
    pinned: false,
  });
  assert.deepEqual(next.domainPins, ['b.test']);
  assert.deepEqual((await api.storage.local.get(MODEL_KEY))[MODEL_KEY].domainPins, ['b.test']);
  await assert.rejects(
    reopened.request({
      type: 'setDomainPin',
      windowId: 1,
      domain: 'https://bad.test',
      pinned: true,
    }),
  );
  await assert.rejects(
    reopened.request({ type: 'setDomainPin', windowId: 1, domain: 'b.test', pinned: 'yes' }),
  );
});

test('a rejected pin save leaves the previous preferences intact', async () => {
  const api = memoryBrowser();
  const controller = createController(api);
  const send = (domain) =>
    controller.request({ type: 'setDomainPin', windowId: 1, domain, pinned: true });
  await send('a.test');
  const save = api.storage.local.set;
  api.storage.local.set = async () => {
    throw new Error('Disk full');
  };
  await assert.rejects(send('b.test'), /Disk full/);
  assert.deepEqual((await controller.request({ type: 'snapshot', windowId: 1 })).domainPins, [
    'a.test',
  ]);
  api.storage.local.set = save;
  await send('c.test');
  assert.deepEqual((await controller.request({ type: 'snapshot', windowId: 1 })).domainPins, [
    'a.test',
    'c.test',
  ]);
});
