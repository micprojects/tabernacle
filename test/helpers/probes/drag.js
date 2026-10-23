import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentPointer(pointerSource) {
  return replaceSource(
    pointerSource,
    '  return {\n    project,',
    `  window.pointerLifecycleProbe = () => ({
        pressed: Boolean(session), active: Boolean(session?.active),
        retainedState: Boolean(session?.checkedState), frame: Boolean(frame),
        hover: Boolean(hoverTimer),
      });
  return {
    project,`,
  );
}

export function instrumentDemo(demo) {
  return replaceSource(
    replaceSource(
      replaceSource(demo, 'memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,'),
      'const memberships = {};',
      `const count = Number(new URLSearchParams(location.search).get('count'));
          while (entries.length < count) entries.push(['Extra tab ' + entries.length, null, 'https://example.com/' + entries.length]);
          const memberships = {};`,
    ),
    'return controller;',
    'window.dragTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
  );
}
