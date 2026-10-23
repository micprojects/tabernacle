import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentDemo(demo) {
  return replaceSource(
    replaceSource(
      replaceSource(demo, 'memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,'),
      'const memberships = {};',
      `
      entries[0] = ['One', 'design', 'https://www.example.com/one'];
      entries[1] = ['Two', 'design', 'https://example.com/two'];
      entries[2] = ['Three', 'research', 'https://example.com/three'];
      entries[3] = ['Four', 'research', 'https://child.example.com/four'];
      entries[4] = ['Five', 'later', 'https://other.test/five'];
      entries[5] = ['Six', 'personal', 'https://other.test/six'];
      for (let i = 6; i < entries.length; i++) entries[i][2] = 'https://single' + i + '.test/';
      const memberships = {};`,
    ),
    'return controller;',
    'window.domainsTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
  );
}
