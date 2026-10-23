import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentTransfer(transferSource) {
  return replaceSource(
    transferSource,
    '  return read;',
    '  window.sidebarReaderProbe = () => ({ retained: Boolean(previous), epoch }); return read;',
  );
}

export function instrumentSource(source) {
  return (
    replaceSource(
      replaceSource(
        replaceSource(source, 'const layoutValues =', 'let layoutValues ='),
        'const metadataValues =',
        'let metadataValues =',
      ),
      'createTreeIndex(state, query)',
      '(window.perfIndexBuilds = (window.perfIndexBuilds || 0) + 1, createTreeIndex(state, query))',
    ) +
    String.raw`
window.perfValueArrays = { layout: 0, metadata: 0 };
layoutValues = ((read) => (tab) => { perfValueArrays.layout++; return read(tab); })(layoutValues);
metadataValues = ((read) => (tab) => { perfValueArrays.metadata++; return read(tab); })(metadataValues);` +
    '\nwindow.measureSidebarUpdate = (next) => { acceptState(next); const start = performance.now(); render(); return performance.now() - start; };' +
    '\nwindow.forceFullSidebarRender = () => { previousRender = null; render(); };' +
    '\nwindow.sidebarVisibilityTest = { action, domain: filterByDomain, leaveDomain, state: () => ({ generation: state.generation, focused: windowFocused }) };' +
    String.raw`
window.sidebarReleaseProbe = {
  refresh,
  request: (...args) => request(...args),
  action: (...args) => action(...args),
  pendingClick: () => { clickGroup('g0', { detail: 1 }); return Boolean(pendingGroupClick); },
  hasPendingClick: () => Boolean(pendingGroupClick),
  queueIsEmpty: () => actionQueue.then(value => value === undefined),
  inspect: () => ({ disposed, hasState: Boolean(state), hasConfirmed: Boolean(confirmedState) }),
};` +
    String.raw`
window.sidebarProjectionTest = {
  inspect() {
    if (!projection) return { released: true, target: Boolean(treeRenderer.target('tab:1')) };
    const visible = projection.visibleRows.map((row) => row.key);
    const mounted = [...tree.querySelectorAll(':is(.row, .new-tab-action):not([inert] *)')]
      .map((row) => row.dataset.key);
    const expected = treeRenderer.virtual ? visible.filter(key => mounted.includes(key)) : visible;
    if (JSON.stringify(expected) !== JSON.stringify(mounted))
      throw new Error('Mounted rows differ from logical navigation order');
    for (const key of [...mounted, ...projection.pins.map(row => row.key)])
      if (!treeRenderer.target(key)?.isConnected || treeRenderer.target(key).dataset.key !== key)
        throw new Error('Renderer lost live target or stable key ' + key);
    return {
      released: false,
      visible,
      mounted,
      logicalTabs: projection.logicalRows.filter((row) => row.kind === 'tab').length,
      matching: projection.filterTabIds,
      close: projection.closeTabIds,
      pins: projection.pins.map((row) => row.key),
      saved: projection.saved.map((row) => row.id),
    };
  },
  capture: () => treeRenderer.capture(),
  reveal: key => treeRenderer.ensureVisible(key),
  mount: key => treeRenderer.mount(key),
  panes: { later: laterView, domains: domainsView },
};
window.measureSidebarLookupReads = (next) => {
  acceptState(next);
  const reads = { tabs: 0, collapsed: 0 };
  const track = (values, kind) => new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads[kind]++;
      return Reflect.get(target, property, receiver);
    },
  });
  state = {
    ...state,
    tabs: track(state.tabs, 'tabs'),
    view: { ...state.view, collapsed: track(state.view.collapsed, 'collapsed') },
  };
  previousRender = null;
  render();
  return reads;
};`
  );
}
