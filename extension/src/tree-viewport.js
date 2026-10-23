import { treeLayout, visibleRange, revealOffset } from './tree-geometry.js';
import { bufferRange } from './viewport-range.js';

const emptyChildren = [];

export function createViewportTreeRenderer({
  tree,
  pins,
  full,
  renderRow,
  renderSaved,
  reconcile,
  begin = () => {},
  prepare = () => {},
  finish = () => {},
  reuse = () => {},
  retained = () => [],
  captureView,
  restoreView,
}) {
  let projection;
  let geometry;
  let mounted = new Map();
  let rendered = new Map();
  let spacers = new Map();
  let virtual = false;
  let disposed = false;
  let drawing = false;
  const presses = new Map();
  let scheduled;
  let widthOwners = [];
  let previousGeometry;
  let previousIndexes = [];
  let previousOwners = [];
  let bufferedRange;
  let previousVisibleStart;
  let previousVisibleEnd;
  let rangeOverscan = 12;
  let bufferedOwners;
  let bufferedIndexes;
  let viewportHeight;
  const spareSpacers = [];
  const events = new AbortController();

  let range;

  function synchroniseRect() {
    const height = tree.clientHeight;
    if (height === viewportHeight) return false;
    viewportHeight = height;
    bufferedRange = undefined;
    return true;
  }

  const resizeObserver = new ResizeObserver(() => {
    if (synchroniseRect()) draw();
  });
  resizeObserver.observe(tree);
  synchroniseRect();
  tree.addEventListener('scroll', () => draw(emptyChildren, true), {
    passive: true,
    signal: events.signal,
  });

  function rangeExtractor(range) {
    if (!bufferedRange) previousVisibleStart = previousVisibleEnd = undefined;
    if (range.startIndex !== previousVisibleStart || range.endIndex !== previousVisibleEnd) {
      const jumped =
        previousVisibleStart !== undefined &&
        Math.abs(range.startIndex - previousVisibleStart) >
          (range.endIndex - range.startIndex + 1) / 2;
      // Gradual scrolling benefits from fewer refills. Keep startup and large
      // jumps small: their larger refills increased measured frame intervals.
      // Owner-only invalidation must keep the current policy and buffer.
      rangeOverscan = previousVisibleStart === undefined ? 12 : jumped ? 8 : range.overscan;
      // Gradual movement benefits from avoiding repeated visibility checks.
      // At startup and after jumps, Firefox's offscreen paint suppression saves
      // work even though the viewport already bounds the mounted rows.
      tree.classList.toggle('viewport-wide-buffer', rangeOverscan === range.overscan);
      previousVisibleStart = range.startIndex;
      previousVisibleEnd = range.endIndex;
    }
    const next = bufferRange({ ...range, overscan: rangeOverscan }, bufferedRange);
    if (next === bufferedRange && bufferedOwners === previousOwners) return bufferedIndexes;
    bufferedRange = next;
    bufferedOwners = previousOwners;
    const wanted = new Set();

    const add = (entry) => {
      // Reaching an included ancestor also means its parents are included.
      // Visit each retained row once, even in deeply nested branches.
      while (entry && !wanted.has(entry.index)) {
        wanted.add(entry.index);
        entry = geometry.byKey.get(entry.parentKey);
      }
    };

    for (let index = next.start; index <= next.end; index++) add(geometry.entries[index]);
    for (const key of previousOwners) add(geometry.byKey.get(key));
    bufferedIndexes = [...wanted].sort((a, b) => a - b);
    return bufferedIndexes;
  }

  function owners(extra = []) {
    return [
      ...retained(),
      ...widthOwners,
      ...extra,
      ...[...presses.values()].map((press) => press.key),
      document.activeElement?.closest('[data-key]')?.dataset.key,
      ...[...tree.querySelectorAll('[data-tree-motion]')].map(
        (branch) => branch.parentElement.querySelector('.row')?.dataset.key,
      ),
    ].filter(Boolean);
  }

  function draw(extra = emptyChildren, scrolling = false) {
    if (!virtual || disposed || drawing || !geometry) return;
    const nextRange = visibleRange(geometry.entries, tree.scrollTop, viewportHeight, range);
    if (scrolling && nextRange === range && bufferedRange) return;
    range = nextRange;
    drawing = true;
    try {
      const nextOwners = owners(extra);
      if (
        nextOwners.length !== previousOwners.length ||
        nextOwners.some((key, i) => key !== previousOwners[i])
      )
        previousOwners = nextOwners;
      const indexes = range ? rangeExtractor(range) : emptyChildren;
      if (
        previousGeometry === geometry &&
        indexes.length === previousIndexes.length &&
        indexes.every((index, i) => index === previousIndexes[i])
      )
        return;
      const wanted = indexes.map((index) => geometry.entries[index]);
      const sameGeometry = previousGeometry === geometry;
      begin();
      prepare(wanted, projection.pins, nextOwners);
      const children = new Map();
      for (const entry of wanted) {
        const parent = entry.parentKey;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(entry);
      }
      const nodes = new Map();
      const nextSpacers = new Map();
      const nextMounted = new Map();
      const nextRendered = new Map();

      const space = (key, height) => {
        let node = spacers.get(key);
        if (!node) {
          node = spareSpacers.pop();
          if (!node) {
            node = document.createElement('div');
            node.className = 'viewport-gap';
            node.setAttribute('aria-hidden', 'true');
            node.setAttribute('role', 'none');
          }
        }
        node.style.height = `${height}px`;
        nextSpacers.set(key, node);
        return node;
      };

      const list = (key, start, end) => {
        const result = [];
        let cursor = start;
        for (const entry of children.get(key) || []) {
          if (entry.start > cursor) result.push(space(`${key}:${cursor}`, entry.start - cursor));
          result.push(nodes.get(entry.row.key));
          cursor = entry.end;
        }
        if (end > cursor) result.push(space(`${key}:${cursor}`, end - cursor));
        return result;
      };

      for (let i = wanted.length - 1; i >= 0; i--) {
        const entry = wanted[i];
        const { row } = entry;
        const childNodes =
          entry.last === entry.index
            ? emptyChildren
            : list(row.key, entry.top + entry.height, entry.end);
        const previous = sameGeometry ? rendered.get(row.key) : undefined;
        let result;
        if (
          previous?.node.isConnected &&
          previous.children.length === childNodes.length &&
          childNodes.every((node, i) => node === previous.children[i])
        ) {
          // Scrolling changes membership, not the presentation of survivors.
          // Keep their cache ownership without rewriting attributes or controls.
          reuse(row);
          result = previous;
        } else {
          result = renderRow(row, childNodes);
          result.node.style.setProperty('--viewport-gap', `${entry.margin}px`);
          const item = result.target.closest('[role="treeitem"]');
          item?.setAttribute('aria-level', String(row.depth + 1));
          item?.setAttribute('aria-posinset', String(entry.sibling + 1));
          item?.setAttribute('aria-setsize', String(geometry.sizes.get(entry.parentKey)));
          result.children = childNodes;
        }
        nextRendered.set(row.key, result);
        nextMounted.set(row.key, result.target);
        nodes.set(row.key, result.node);
      }
      const rootKey = projection.roots.find((row) => row.visible)?.parentKey ?? null;
      const roots = list(rootKey, 0, geometry.saved?.start ?? geometry.totalSize);
      if (geometry.saved) {
        const { key, top } = geometry.saved;
        roots.push(renderSaved(list(key, top, geometry.totalSize)));
      }
      reconcile(tree, roots);
      reconcile(
        pins,
        projection.pins.map((row) => {
          const result = renderRow(row, []);
          nextMounted.set(row.key, result.target);
          return result.node;
        }),
      );
      mounted = nextMounted;
      for (const [key, node] of spacers)
        if (!nextSpacers.has(key) && spareSpacers.length < 128) {
          node.remove();
          spareSpacers.push(node);
        }
      spacers = nextSpacers;
      finish();
      rendered = nextRendered;
      previousGeometry = geometry;
      previousIndexes = indexes;
    } finally {
      drawing = false;
    }
  }

  function measure() {
    bufferedRange = undefined;
    const style = getComputedStyle(tree);
    const number = (name, fallback) => parseFloat(style.getPropertyValue(name)) || fallback;
    geometry = treeLayout(projection, {
      rowHeight: number('--row-height', 30),
      tabHeight: tree.classList.contains('show-domains') ? 38 : number('--row-height', 30),
      gap: number('--branch-gap', 0),
      groupGap: number('--group-gap', 0),
      addHeight: matchMedia('(hover: none)').matches ? 44 : number('--row-height', 30),
    });
    range = undefined;
    measureWidthOwners();
  }

  // Deep controls can overflow horizontally. Retain the deepest representative
  // of each control shape so vertical scrolling never shrinks the native rail.
  function measureWidthOwners() {
    const shapes = new Map();
    for (const { row } of geometry.entries) {
      if (row.depth < 4) continue;
      const tab = row.tab;
      const playing = Boolean(tab?.audible && !tab.mutedInfo?.muted);
      const childIndicator = tab && !playing && (projection.index.audio.get(tab.id) || 0) > 0;
      const shape =
        row.kind === 'tab'
          ? `tab:${Boolean(tab.audible || tab.mutedInfo?.muted)}:${Boolean(childIndicator)}`
          : row.kind === 'group'
            ? `group:${String(projection.index.groupStats.get(row.id).count).length}:${Boolean(projection.index.groupStats.get(row.id).audio)}`
            : row.kind;
      if (!shapes.has(shape) || shapes.get(shape).depth < row.depth) shapes.set(shape, row);
    }
    widthOwners = [...shapes.values()].map((row) => row.key);
  }

  const refresh = (force = false) => {
    scheduled = undefined;
    if (force === true) previousGeometry = undefined;
    draw();
  };

  tree.addEventListener(
    'focusin',
    () => {
      if (!scheduled) scheduled = requestAnimationFrame(refresh);
    },
    { signal: events.signal },
  );
  tree.addEventListener(
    'pointerdown',
    (event) => {
      const key = event.target.closest('[data-key]')?.dataset.key;
      if (key) presses.set(event.pointerId, { key });
      else presses.delete(event.pointerId);
    },
    { capture: true, signal: events.signal },
  );
  for (const type of ['pointerup', 'pointercancel'])
    document.addEventListener(
      type,
      (event) => {
        // Keep the pressed target until its click has been dispatched.
        const press = presses.get(event.pointerId);
        if (!press) return;
        setTimeout(() => {
          // A newer press can reuse the same pointer before this task runs.
          if (presses.get(event.pointerId) !== press) return;
          presses.delete(event.pointerId);
          draw();
        }, 0);
      },
      { signal: events.signal },
    );
  const api = {
    get virtual() {
      return virtual;
    },

    update(next) {
      // Native scrolling and pane restoration can precede queued browser events.
      // Read the current rectangle here and the live offset in draw().
      synchroniseRect();
      projection = next;
      virtual = next.visibleRows.length > 100;
      tree.classList.toggle('viewport-tree', virtual);
      if (!virtual) {
        tree.classList.remove('viewport-wide-buffer');
        bufferedRange = bufferedOwners = bufferedIndexes = undefined;
        previousGeometry = undefined;
        previousIndexes = widthOwners = [];
        previousOwners = [];
        range = undefined;
        geometry = undefined;
        mounted.clear();
        rendered.clear();
        spacers.clear();
        return full.update(next);
      }
      measure();
      draw();
      full.forget();
      return true;
    },

    target(key) {
      return virtual ? mounted.get(key) : full.target(key);
    },

    mount(key) {
      if (!virtual) return full.target(key);
      if (!mounted.has(key) && geometry.byKey.has(key)) draw([key]);
      return mounted.get(key);
    },

    ensureVisible(key, { focus = false } = {}) {
      if (!virtual) return full.ensureVisible(key, { focus });
      const entry = geometry.byKey.get(key);
      if (entry) {
        synchroniseRect();
        tree.scrollTop = revealOffset(
          entry,
          tree.scrollTop,
          viewportHeight,
          tree.scrollHeight - viewportHeight,
        );
        draw([key]);
      }
      const target = mounted.get(key);
      if (!target) return false;
      target.scrollIntoView({ block: 'nearest' });
      draw([key]);
      if (focus) target.focus({ preventScroll: true });
      return true;
    },

    replaceTarget(key, target) {
      if (virtual) {
        if (mounted.has(key)) mounted.set(key, target);
        const result = rendered.get(key);
        if (result) result.target = target;
        const entry = geometry.byKey.get(key);
        if (entry) {
          target.setAttribute('aria-level', String(entry.row.depth + 1));
          target.setAttribute('aria-posinset', String(entry.sibling + 1));
          target.setAttribute('aria-setsize', String(geometry.sizes.get(entry.parentKey)));
        }
      } else full.replaceTarget(key, target);
    },

    capture: () => captureView(),

    restore(saved) {
      if (!projection || !saved) return;
      if (virtual && saved.scroll?.anchor?.key) api.mount(saved.scroll.anchor.key);
      restoreView(saved);
      draw();
    },

    refresh,

    refreshWidth() {
      if (!virtual || !geometry) return;
      measureWidthOwners();
      draw();
    },

    suspend() {
      tree.classList.remove('viewport-wide-buffer');
      presses.clear();
      bufferedRange = bufferedOwners = bufferedIndexes = undefined;
      range = undefined;
      projection = geometry = undefined;
      previousGeometry = undefined;
      previousIndexes = widthOwners = [];
      previousOwners = [];
      spareSpacers.length = 0;
      virtual = false;
      mounted.clear();
      rendered.clear();
      spacers.clear();
      full.suspend();
    },

    dispose() {
      disposed = true;
      cancelAnimationFrame(scheduled);
      events.abort();
      api.suspend();
      resizeObserver.disconnect();
      full.dispose();
    },
  };
  tree.addEventListener(
    'keydown',
    (event) => {
      if (!virtual || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target.closest('[data-key]');
      const entry = geometry.byKey.get(target?.dataset.key);
      if (!entry) return;
      const controls = (node) =>
        [node, ...node.querySelectorAll('button, [tabindex]')].filter(
          (item) => item.tabIndex >= 0 && !item.disabled,
        );
      const current = controls(target);
      const atEdge = event.target === (event.shiftKey ? current[0] : current.at(-1));
      if (!atEdge) return;
      const next = geometry.entries[entry.index + (event.shiftKey ? -1 : 1)];
      if (!next) return;
      event.preventDefault();
      api.ensureVisible(next.row.key);
      const node = api.target(next.row.key);
      (event.shiftKey ? controls(node).at(-1) : node).focus({ preventScroll: true });
    },
    { capture: true, signal: events.signal },
  );
  return api;
}
