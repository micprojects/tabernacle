import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentSidebar(sidebar) {
  return (
    sidebar +
    '\nwindow.treeLifecycleState = () => ({ tabs: treeTabs.length, index: Boolean(index), wrappers: window.sidebarRowsProbe().wrappers });'
  );
}

export function instrumentDemo(demo) {
  return replaceSource(
    replaceSource(
      replaceSource(demo, 'memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,'),
      'const memberships = {};',
      `
      entries.splice(0, 7,
        ['A practical guide to CSS container queries', 'design', 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries'],
        ['How the London Underground map was designed', 'design', 'https://www.youtube.com/watch?v=abcdefghijk'],
        ['Ideas for the next release', 'design', 'https://docs.google.com/document/d/example/edit'],
        ['The history of the World Wide Web', 'design', 'https://en.wikipedia.org/wiki/World_Wide_Web'],
        ['Building a small desk from solid oak', 'research', 'https://www.youtube.com/watch?v=lmnopqrstuv'],
        ['Why we keep coming back to old technology', 'research', 'https://www.bbc.co.uk/news/articles/example'],
        ['Places for a weekend in Copenhagen', 'research', 'https://maps.google.com/']
      );
      const memberships = {};`,
    ),
    'return controller;',
    'window.laterTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
  );
}
