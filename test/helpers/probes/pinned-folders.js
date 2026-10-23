import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentDemo(demo) {
  return replaceSource(
    replaceSource(demo, 'memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,'),
    'return controller;',
    'window.pinTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
  );
}
