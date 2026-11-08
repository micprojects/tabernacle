import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentSidebar(source) {
  return (
    source +
    `
window.pinOwnership = {
  replaceMetadata() {
    refreshScheduler.dispose();
    this.previous = state.tabs.filter(tab => tab.pinned).map(tab => new WeakRef(tab));
    acceptState({ ...state, tabs: state.tabs.map(tab => tab.pinned ? {
      ...tab, title: 'Updated ' + tab.title,
      favIconUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>'),
    } : tab) });
    render();
    return this.previous.length;
  },
  retained() { return this.previous.filter(ref => ref.deref()).length; },
};`
  );
}

export function instrumentDemo(demo) {
  return replaceSource(
    replaceSource(demo, 'memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,'),
    'return controller;',
    'window.pinTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
  );
}
