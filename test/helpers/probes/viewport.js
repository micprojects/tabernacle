import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentViewport(viewportSource, viewportApi) {
  return replaceSource(
    viewportSource,
    viewportApi,
    `  window.viewportBuffer = () => ({
          overscan: rangeOverscan, start: bufferedRange?.start, end: bufferedRange?.end,
          first: previousVisibleStart, last: previousVisibleEnd,
          visibility: getComputedStyle(tree.querySelector('.tab-row:not([aria-expanded])')).contentVisibility,
        });
${viewportApi}`,
  );
}

export function instrumentSource(source) {
  return (
    source +
    `
      window.viewportTest = {
        ready: () => Boolean(state),
        set: (next, motionKey = null) => { refreshScheduler.dispose(); acceptState(next); previousRender = null; render(motionKey); },
        patch: next => { acceptState(next); render(); },
        search: query => { $('search').value = query; render(); },
        poolDomain: (domain, id) => domain ? filterByDomain(domain, id) : leaveDomain({ restoreFocus: false }),
        targets: () => projection.filterTabIds,
        cached: keys => ({ pooled: window.sidebarRowsProbe(keys).pooled, keys: window.sidebarRowsProbe(keys).keys }),
        reveal: key => treeRenderer.ensureVisible(key),
        mount: key => treeRenderer.mount(key),
        full: () => { tree.classList.remove('viewport-tree'); createFullTreeRenderer(treeRendererOptions).update(projection); },
        redraw: () => { previousRender = null; render(); },
        resetRows: () => { window.viewportTabBuilds = 0; releaseTree(); render(); },
        calls: [],
        intercept: () => { request = async (type, args) => { viewportTest.calls.push({ type, ...args }); return confirmedState; }; },
      };`
  );
}
