import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentSource(source, marker, counter) {
  return replaceSource(
    source,
    marker,
    `${marker}\n  globalThis.${counter} = (globalThis.${counter} || 0) + 1;`,
  );
}

export function instrumentDemo(demo, JSON, logo) {
  return replaceSource(
    replaceSource(
      replaceSource(
        replaceSource(demo, 'memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,'),
        '      title,',
        `      favIconUrl: index === 0 ? ${JSON.stringify(logo)} : undefined,\n      title,`,
      ),
      'const memberships = {};',
      `
      entries[0] = ['Woodworking projects', 'design', 'https://www.youtube.com/watch?v=1'];
      entries[1] = ['Typography reference', 'design', 'https://fonts.google.com/specimen/Inter'];
      entries[2] = ['Music for working', 'design', 'https://music.youtube.com/watch?v=3'];
      entries[4] = ['Painting techniques', 'research', 'https://youtube.com/watch?v=5'];
      entries[6] = ['youtube.com reference', 'research', 'https://example.com/youtube.com'];
      entries[9] = ['Pinned video', 'personal', 'https://youtube.com/watch?v=10'];
      entries[12] = ['Pinned playlist', 'later', 'https://www.youtube.com/playlist?list=13'];
      entries[13] = ['Woodworking tools', 'later', 'https://youtube.com/watch?v=14'];
      entries[15] = ['New tab', 'later', 'about:blank'];
      while (entries.length < 65) entries.push(['Extra tab ' + entries.length, null, 'https://example.com/' + entries.length]);
      const memberships = {};`,
    ),
    'return controller;',
    'window.domainTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
  );
}
