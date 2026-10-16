import { moveSource, resolveMove, sourcePlacement } from './move-plan.js';

// Pointer capture lives on the persistent sidebar, never a row which a hover
// expansion, navigation or external update can remove.
export function createPointerMove({
  root,
  tree,
  shelf,
  getState,
  canStart,
  onStart,
  onViewChange,
  onEnd,
  commit,
  announce,
}) {
  let session,
    frame,
    hoverTimer,
    hoverKey,
    suppressClick = false;
  const marked = new Set();
  const preview = document.createElement('div');
  preview.className = 'move-preview';
  preview.hidden = true;
  preview.setAttribute('aria-hidden', 'true');
  const marker = document.createElement('div');
  marker.className = 'move-marker';
  marker.hidden = true;
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  root.append(preview, marker, live);

  function mark(node, name) {
    node.classList.add(name);
    marked.add(node);
  }

  function clearMarkers() {
    for (const node of marked)
      node.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-invalid');
    marked.clear();
    marker.hidden = true;
  }

  function row(kind, id) {
    return tree.querySelector(`[data-key="${kind}:${CSS.escape(String(id))}"]`);
  }

  function project(state) {
    if (!session?.active) return state;
    if (session.scopeId !== null && !state.groups.some((group) => group.id === session.scopeId))
      session.scopeId = state.view.scopeId;
    const groups = new Set(session.groups);
    return {
      ...state,
      tabs: state.tabs.map((tab) =>
        session.tabs.has(tab.id) ? { ...tab, collapsed: false } : tab,
      ),
      view: {
        ...state.view,
        scopeId: session.scopeId,
        collapsed: state.view.collapsed.filter((id) => !groups.has(id)),
      },
    };
  }

  function position(node, y, insideOnly = false) {
    if (insideOnly || node.classList.contains('new-tab-item')) return 'inside';
    const rect = node.getBoundingClientRect();
    const edge = Math.max(8, Math.min(rect.height / 3, rect.height / 4));
    const offset = y - rect.top;
    let value = offset < edge ? 'before' : offset > rect.height - edge ? 'after' : 'inside';
    if (session.targetNode === node && session.position && value !== session.position) {
      const boundary =
        value === 'before' || session.position === 'before' ? edge : rect.height - edge;
      if (Math.abs(offset - boundary) < 2) value = session.position;
    }
    return value;
  }

  function pinSlot(x, y) {
    const pins = [...shelf.querySelectorAll('.pinned-tab')];
    for (const [index, node] of pins.entries()) {
      const rect = node.getBoundingClientRect();
      if (y < rect.top || (y <= rect.bottom && x < rect.right)) {
        const after = y >= rect.top && x >= rect.left + rect.width / 2;
        const before = after ? pins[index + 1] : node;
        return {
          node: before || node,
          after: !before,
          before: before ? { kind: before.dataset.pinKind, id: before.dataset.pinId } : null,
        };
      }
    }
    return { node: pins.at(-1), after: true, before: null };
  }

  function targetAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!root.contains(hit)) throw new Error('Drop within this sidebar.');
    const node = hit.closest('[data-drop-kind], .pinned-tab, #pinned-tabs, #tree');
    if (!node) throw new Error('Choose Home, a folder, a tab, or pinned items.');
    if (shelf.contains(node)) {
      if (node.dataset.pinKind === 'group' && session.source.kind !== 'pin-group') {
        const rect = node.getBoundingClientRect();
        if (x >= rect.left + 8 && x <= rect.right - 8)
          return {
            node,
            intent: { kind: 'group', id: node.dataset.pinId },
            hover: { kind: 'scope', id: node.dataset.pinId },
          };
      }
      return { node, intent: { kind: 'pins', before: pinSlot(x, y).before } };
    }
    if (node === tree) {
      const last = tree.lastElementChild?.getBoundingClientRect();
      if (last && y < last.bottom - 2 && !hit.closest('.empty-state'))
        throw new Error('Drop on a row to choose its destination.');
      return { node, intent: { kind: 'tree', groupId: session.scopeId } };
    }
    const kind = node.dataset.dropKind;
    const id = kind === 'tab' ? Number(node.dataset.dropId) : node.dataset.dropId || null;
    const pos = position(
      node,
      y,
      kind === 'inside' || (kind === 'group' && session.source.kind === 'tab'),
    );
    if (kind === 'inside')
      return {
        node,
        intent: { kind: 'tree', groupId: id },
        hover: node.closest('#breadcrumbs') ? { kind: 'scope', id } : null,
      };
    return {
      node,
      position: pos,
      intent: { kind, id, position: pos },
      hover: pos === 'inside' && !node.classList.contains('new-tab-item') ? { kind, id } : null,
    };
  }

  function scheduleHover(target) {
    const key = target?.hover ? JSON.stringify(target.hover) : null;
    if (key === hoverKey) return;
    clearTimeout(hoverTimer);
    hoverKey = key;
    if (!key) return;
    hoverTimer = setTimeout(() => {
      if (!session?.active || key !== hoverKey) return;
      const hover = target.hover;
      if (hover.kind === 'scope') {
        session.scopeId = hover.id;
        session.groups.add(hover.id);
        tree.scrollTop = 0;
      } else if (hover.kind === 'group') session.groups.add(hover.id);
      else session.tabs.add(hover.id);
      onViewChange();
      session.dirty = true;
    }, 600);
  }

  function paintPins() {
    const { node, after } = pinSlot(session.x, session.y);
    if (!node) {
      mark(shelf, 'drop-inside');
      return;
    }
    const bounds = shelf.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const previous = node.previousElementSibling?.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(shelf).columnGap);
    const x = after
      ? rect.right + gap / 2
      : previous?.top === rect.top
        ? (previous.right + rect.left) / 2
        : rect.left;
    const markerX = Math.max(bounds.left + 1, Math.min(x, bounds.left + shelf.clientWidth - 1));
    node.style.setProperty('--pin-drop-x', `${markerX - rect.left - node.clientLeft}px`);
    mark(node, after ? 'drop-after' : 'drop-before');
  }

  function paintTree(plan, target) {
    if (target.node !== tree && (!target.position || target.position === 'inside')) {
      mark(target.node, 'drop-inside');
      return;
    }
    const dest = plan.destination;
    const kind = dest.kind === 'folder' ? 'group' : 'tab';
    const parentId = dest.kind === 'folder' ? dest.parentId : dest.groupId;
    let container =
      parentId === session.scopeId
        ? tree
        : row('group', parentId)?.parentElement.querySelector(':scope > .branch');
    if (dest.parentTabId != null)
      container = row('tab', dest.parentTabId)?.parentElement.querySelector(':scope > .tab-branch');
    const before = dest.beforeId == null ? null : row(kind, dest.beforeId);
    const peers = container
      ? [...container.children].filter((node) => node.classList.contains(`${kind}-node`))
      : [];
    const nextKind =
      kind === 'group'
        ? container?.querySelector(':scope > .tab-node, :scope > .new-tab-item')
        : container?.querySelector(':scope > .new-tab-item');
    const anchor = before?.parentElement || peers.at(-1) || nextKind || container || target.node;
    const rect = anchor.getBoundingClientRect();
    const bounds = tree.getBoundingClientRect();
    const y = before || !peers.length ? rect.top : rect.bottom;
    marker.hidden = false;
    marker.style.left = `${Math.max(bounds.left + 8, rect.left + 4)}px`;
    marker.style.width = `${Math.max(8, Math.min(rect.right, bounds.right - 8) - Math.max(bounds.left + 8, rect.left + 4) - 4)}px`;
    marker.style.top = `${Math.max(bounds.top + 1, Math.min(y, bounds.bottom - 2))}px`;
    marker.classList.toggle('offscreen', y < bounds.top || y > bounds.bottom);
  }

  function update() {
    if (!session?.active) return;
    clearMarkers();
    let target;
    try {
      const state = getState();
      if (session.checkedState !== state) {
        if (sourcePlacement(state, session.source) !== session.sourceState)
          throw new Error('The source has changed. Cancel and try again.');
        session.checkedState = state;
        session.planKey = null;
      }
      target = targetAt(session.x, session.y);
      const key = JSON.stringify(target.intent);
      const plan =
        session.planKey === key && session.plan
          ? session.plan
          : resolveMove(state, session.source, target.intent);
      session.planKey = key;
      session.plan = plan;
      session.intent = target.intent;
      session.targetNode = target.node;
      session.position = target.position;
      const text = `${plan.title}${plan.count > 1 ? ` · ${plan.count} tabs` : ''}\n${plan.noOp ? 'Already in this position' : plan.label}`;
      if (preview.textContent !== text) preview.textContent = text;
      root.classList.remove('move-invalid');
      if (plan.destination.kind === 'pins') paintPins();
      else paintTree(plan, target);
      scheduleHover(target);
    } catch (error) {
      session.plan = null;
      if (preview.textContent !== error.message) preview.textContent = error.message;
      root.classList.add('move-invalid');
      if (target?.node) mark(target.node, 'drop-invalid');
      scheduleHover(null);
    }
    if (live.textContent !== preview.textContent) live.textContent = preview.textContent;
    const bounds = root.getBoundingClientRect();
    preview.style.left = `${Math.max(bounds.left + 6, Math.min(session.x + 12, bounds.right - preview.offsetWidth - 6))}px`;
    preview.style.top = `${Math.max(bounds.top + 6, Math.min(session.y + 20, bounds.bottom - preview.offsetHeight - 6))}px`;
    const source =
      session.source.kind === 'pin-group'
        ? shelf.querySelector(`[data-pin-id="${CSS.escape(session.source.id)}"]`)
        : document.querySelector(
            `[data-key="${session.source.kind}:${CSS.escape(String(session.source.id))}"]`,
          );
    source?.classList.add('dragging');
  }

  function tick(time) {
    if (!session?.active) return;
    const elapsed = Math.min(40, time - (session.time || time)) / 1000;
    session.time = time;
    let scrolled = false;
    for (const node of [tree, shelf]) {
      const rect = node.getBoundingClientRect();
      if (
        session.x < rect.left ||
        session.x > rect.right ||
        session.y < rect.top ||
        session.y > rect.bottom
      )
        continue;
      const speed =
        session.y < rect.top + 32
          ? -(1 - (session.y - rect.top) / 32)
          : session.y > rect.bottom - 32
            ? 1 - (rect.bottom - session.y) / 32
            : 0;
      const before = node.scrollTop;
      if (speed) node.scrollTop += speed * 600 * elapsed;
      scrolled ||= before !== node.scrollTop;
    }
    if (session.dirty || scrolled) {
      session.dirty = false;
      update();
    }
    frame = requestAnimationFrame(tick);
  }

  function finish(cancelled, event) {
    if (!session) return;
    const saved = session;
    if (saved.active && !cancelled) update();
    session = null;
    clearTimeout(hoverTimer);
    hoverKey = null;
    cancelAnimationFrame(frame);
    clearMarkers();
    preview.hidden = true;
    root.classList.remove('moving-item', 'move-invalid');
    document.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
    if (root.hasPointerCapture(saved.pointerId)) root.releasePointerCapture(saved.pointerId);
    if (!saved.active) {
      onEnd();
      return;
    }
    suppressClick = true;
    event?.preventDefault();
    onEnd();
    onViewChange();
    if (cancelled || !saved.plan) {
      tree.scrollTop = saved.scroll;
      shelf.scrollTop = saved.pinScroll;
      const focus = saved.focus?.isConnected
        ? saved.focus
        : saved.focusKey
          ? root.querySelector(`[data-key="${CSS.escape(saved.focusKey)}"]`)
          : null;
      focus?.focus({ preventScroll: true });
      announce(cancelled ? 'Move cancelled.' : preview.textContent, !cancelled);
    } else void commit(saved.plan, saved.intent);
  }

  document.addEventListener(
    'pointerdown',
    (event) => {
      suppressClick = false;
      if (
        session ||
        event.button !== 0 ||
        !event.isPrimary ||
        !canStart() ||
        event.target.closest('.close-tab, .audio-button')
      )
        return;
      const node = event.target.closest('.row, .pinned-tab');
      if (!node || !root.contains(node)) return;
      try {
        const state = getState();
        let kind = node.dataset.kind,
          id = node.dataset.id;
        if (node.matches('.pinned-tab')) {
          kind = node.dataset.pinKind === 'group' ? 'pin-group' : 'tab';
          id =
            kind === 'tab'
              ? state.tabs.find((tab) => tab.treeId === node.dataset.pinId)?.id
              : node.dataset.pinId;
        } else if (kind === 'tab') id = Number(id);
        const source = moveSource(state, kind, id);
        session = {
          source,
          sourceState: sourcePlacement(state, source),
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          startX: event.clientX,
          startY: event.clientY,
          scopeId: state.view.scopeId,
          groups: new Set(),
          tabs: new Set(),
          scroll: tree.scrollTop,
          pinScroll: shelf.scrollTop,
          focus: document.activeElement,
          focusKey: document.activeElement?.closest('[data-key]')?.dataset.key,
          active: false,
        };
      } catch (error) {
        announce(error.message, true);
      }
    },
    true,
  );
  document.addEventListener(
    'pointermove',
    (event) => {
      if (!session || event.pointerId !== session.pointerId) return;
      session.x = event.clientX;
      session.y = event.clientY;
      if (!session.active) {
        if (Math.hypot(session.x - session.startX, session.y - session.startY) < 5) return;
        session.active = true;
        root.setPointerCapture(event.pointerId);
        root.classList.add('moving-item');
        preview.hidden = false;
        onStart();
        onViewChange();
        frame = requestAnimationFrame(tick);
      }
      event.preventDefault();
      session.dirty = true;
    },
    true,
  );
  document.addEventListener(
    'pointerup',
    (event) => {
      if (event.pointerId === session?.pointerId) finish(false, event);
    },
    true,
  );
  document.addEventListener('pointercancel', () => finish(true), true);
  root.addEventListener('lostpointercapture', () => finish(true));
  window.addEventListener('blur', () => finish(true));
  window.addEventListener('resize', () => {
    if (session) session.dirty = true;
  });
  root.addEventListener(
    'scroll',
    () => {
      if (session) session.dirty = true;
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (!session?.active) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(true);
      }
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!suppressClick || !event.detail) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  root.addEventListener('dragstart', (event) => event.preventDefault());
  return {
    project,

    refresh() {
      if (session) {
        session.dirty = true;
        session.checkedState = null;
      }
    },

    get active() {
      return Boolean(session?.active);
    },
  };
}
