import { captureScroll, restoreScroll, captureFocus, restoreFocusToken } from '../view-state.js';

// Existing row-cache/wrapper/tree-motion builders adapt renderRow(row, children)
// to { node, target }. Every visible result is mounted, including offscreen text,
// preserving native Find. No thresholds, viewport slicing or observer is used.
export function createFullTreeRenderer({
  tree,
  pins,
  renderRow,
  renderSaved,
  reconcile,
  release = () => {},
  captureView = () => ({
    scroll: captureScroll(tree, '.row, .new-tab-action'),
    focus: captureFocus(),
  }),
  restoreView = (saved) => {
    restoreScroll(tree, saved.scroll);
    restoreFocusToken(saved.focus);
  },
}) {
  let projection = null;
  let mounted = new Map();
  let disposed = false;

  const render = (row, children = []) => {
    const result = renderRow(row, children);
    mounted.set(row.key, result.target);
    return result.node;
  };

  const suspend = () => {
    projection = null;
    mounted.clear();
    reconcile(tree, []);
    reconcile(pins, []);
    release();
  };

  return {
    update(next) {
      if (disposed) return false;
      projection = next;
      mounted = new Map();
      const nodes = new Map();
      for (let i = next.visibleRows.length - 1; i >= 0; i--) {
        const row = next.visibleRows[i];
        if (row.mode === 'saved') continue;
        if (!row.visible) continue;
        const children = row.children
          .filter((child) => child.visible)
          .map((child) => nodes.get(child.key));
        nodes.set(row.key, render(row, children));
      }
      const roots = next.roots.filter((row) => row.visible).map((row) => nodes.get(row.key));
      if (next.saved.length) roots.push(renderSaved(next.saved.map((row) => render(row))));
      reconcile(tree, roots);
      reconcile(
        pins,
        next.pins.map((row) => render(row)),
      );
      return true;
    },

    ensureVisible(key, { focus = false } = {}) {
      const target = mounted.get(key);
      if (!target) return false;
      target.scrollIntoView({ block: 'nearest' });
      if (focus) target.focus({ preventScroll: true });
      return true;
    },

    capture() {
      return captureView();
    },

    restore(saved) {
      if (!projection || !saved) return;
      restoreView(saved);
    },

    target: (key) => mounted.get(key),

    replaceTarget(key, target) {
      if (mounted.has(key)) mounted.set(key, target);
    },

    forget() {
      projection = null;
      mounted.clear();
    },

    suspend,

    dispose() {
      if (disposed) return;
      suspend();
      disposed = true;
    },
  };
}
