import { reconcileChildren } from '../dom.js';

const standard = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const unfold = 'cubic-bezier(0.2, 0, 0, 1)';

// Only an explicit, local fold action supplies a key. Ordinary reconciliation
// never starts motion, including initial load, search and background updates.
export function createTreeMotion(tree, enabled, onSettle = () => {}) {
  const running = new Map();
  const feedback = new Set();
  let pending;

  function clear(branch) {
    branch.removeAttribute('data-tree-motion');
    branch.inert = false;
    branch.removeAttribute('aria-hidden');
  }

  function stop(branch, settle = true) {
    const entry = running.get(branch);
    if (!entry) return;
    running.delete(branch);
    entry.animation.cancel();
    clear(branch);
    if (settle && !entry.expanded) {
      branch.remove();
      branch.replaceChildren();
    }
    onSettle();
  }

  function finishAll() {
    pending = null;
    for (const branch of running.keys()) stop(branch);
    for (const animation of feedback) animation.cancel();
    feedback.clear();
  }

  return {
    finishAll,

    owns(node) {
      if (pending?.expanded && pending.node.contains(node)) return true;
      if (!running.size) return false;
      for (const branch of running.keys()) if (branch.contains(node)) return true;
      return false;
    },

    get active() {
      return running.size > 0;
    },

    prepare(key) {
      pending = null;
      if (!enabled()) return finishAll();
      if (!key) return;
      const row = tree.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (!row || row.closest('[inert]')) return;
      const node = row.parentElement;
      // Nested folds must measure settled content, not another animation's
      // temporary height. Unrelated branches can continue independently.
      for (const branch of running.keys())
        if (branch.contains(row) || (node.contains(branch) && branch.parentElement !== node))
          stop(branch);
      const bounds = row.getBoundingClientRect();
      const viewport = tree.getBoundingClientRect();
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) return;
      const branch = node.querySelector(':scope > .branch, :scope > .tab-branch');
      // A collapsed branch is detached, so reconcile() supplies it below.
      const entry = running.get(branch);
      pending = {
        node,
        expanded: row.getAttribute('aria-expanded') === 'true',
        height: branch?.getBoundingClientRect().height || 0,
        fullHeight: entry?.fullHeight,
        interrupted: Boolean(entry),
      };
      if (branch) stop(branch, false);
    },

    reconcile(node, row, branch, expanded, fill) {
      const queued = pending?.node === node;
      const entry = running.get(branch);
      if (entry && entry.expanded !== expanded) stop(branch);
      if (queued) {
        pending.branch = branch;
        pending.nextExpanded = expanded;
      }
      if (expanded) {
        branch.inert = false;
        branch.removeAttribute('aria-hidden');
        fill();
        reconcileChildren(node, [row, branch]);
      } else if ((queued && pending.height > 0) || running.has(branch)) {
        // Retain only the outgoing branch's visuals. It must stop accepting
        // focus, clicks and accessibility navigation as soon as it is folded.
        if (branch.contains(document.activeElement)) row.focus({ preventScroll: true });
        branch.inert = true;
        branch.setAttribute('aria-hidden', 'true');
        reconcileChildren(node, [row, branch]);
      } else {
        clear(branch);
        branch.replaceChildren();
        reconcileChildren(node, [row]);
      }
    },

    finish() {
      for (const branch of running.keys()) if (!tree.contains(branch)) stop(branch);
      const change = pending;
      pending = null;
      if (!change?.branch || !tree.contains(change.node)) return;
      const { branch, nextExpanded: expanded } = change;
      if (change.expanded === expanded && !change.interrupted) return;
      const height = expanded ? branch.getBoundingClientRect().height : 0;
      const fullHeight = expanded ? height : change.fullHeight || change.height;
      const distance = Math.abs(height - change.height);
      if (distance < 0.5) {
        clear(branch);
        if (!expanded) {
          branch.remove();
          branch.replaceChildren();
        }
        return;
      }
      branch.dataset.treeMotion = 'unfold';
      // One height animation per branch, with no per-frame script or per-row
      // effects. A reversal starts at the displayed height and only takes the
      // time needed for the remaining distance.
      const animation = branch.animate(
        [{ height: `${change.height}px` }, { height: `${height}px` }],
        {
          duration: (expanded ? 100 : 80) * Math.min(1, distance / fullHeight),
          easing: unfold,
          fill: 'both',
        },
      );
      running.set(branch, { animation, expanded, fullHeight });
      animation.onfinish = () => {
        if (running.get(branch)?.animation === animation) stop(branch);
      };
    },

    addFeedback(button) {
      if (!enabled()) return;
      const glyph = button.querySelector('svg');
      if (!glyph) return;
      // Repeated presses replace feedback instead of accumulating effects.
      for (const animation of feedback) {
        if (animation.effect.target === glyph) {
          animation.cancel();
          feedback.delete(animation);
        }
      }
      const animation = glyph.animate([{ transform: 'scale(0.9)' }, { transform: 'scale(1)' }], {
        duration: 100,
        easing: standard,
      });
      feedback.add(animation);
      animation.onfinish = () => feedback.delete(animation);
    },
  };
}
