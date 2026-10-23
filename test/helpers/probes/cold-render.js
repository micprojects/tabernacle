export function instrumentSource(source) {
  return (
    source +
    `
        window.coldTest = {
          ready: () => Boolean(state),
          set: next => { acceptState(next); render(); },
          search: query => { $('search').value = query; render(); },
          stop: () => refreshScheduler.dispose(),
          reveal: key => treeRenderer.ensureVisible(key),
          full: () => { tree.classList.remove('viewport-tree'); createFullTreeRenderer(treeRendererOptions).update(projection); },
          redraw: () => { previousRender = null; render(); },
          count: () => projection.filterTabIds.length,
          calls: [],
          intercept: () => { request = async (type, args) => {
            coldTest.calls.push({type, ...args}); return confirmedState;
          }; },
        };`
  );
}
