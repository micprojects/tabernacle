import { bookmarkEditable, bookmarkMove, bookmarkRecord } from './bookmark-edit.js';

export function createBookmarkDrag({
  root,
  list,
  getIndex,
  expand,
  commit,
  captureExpansion,
  restoreExpansion,
}) {
  const events = new AbortController();
  const marker = document.createElement('div');
  marker.className = 'move-marker';
  marker.hidden = true;
  const preview = document.createElement('div');
  preview.className = 'move-preview';
  preview.setAttribute('role', 'status');
  let session,
    frame,
    hoverTimer,
    hoverId,
    marked,
    suppressClick = false;

  function clear() {
    marker.hidden = true;
    marked?.classList.remove('drop-inside');
    marked = null;
  }

  function paint() {
    if (!session?.active) return;
    clear();
    const { x, y } = session;
    const bounds = list.getBoundingClientRect();
    if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
      if (y < bounds.top + 28) list.scrollTop -= 7;
      else if (y > bounds.bottom - 28) list.scrollTop += 7;
    }
    const row = document.elementFromPoint(x, y)?.closest('.bookmark-row');
    session.target = null;
    let feedback = 'Drop on a bookmark or folder.';
    let nextHover;
    if (row && list.contains(row)) {
      const targetId = row.dataset.bookmarkId;
      const node = getIndex()?.byId.get(targetId);
      const rect = row.getBoundingClientRect();
      const offset = (y - rect.top) / rect.height;
      const position =
        node?.type === 'folder' && offset > 0.25 && offset < 0.75
          ? 'inside'
          : offset < 0.5
            ? 'before'
            : 'after';
      try {
        bookmarkMove(getIndex(), session.id, targetId, position);
        session.target = { targetId, position };
        feedback = `${position === 'inside' ? 'Into' : position === 'before' ? 'Before' : 'After'} “${node.title || 'Untitled'}”`;
        if (position === 'inside') {
          row.classList.add('drop-inside');
          marked = row;
          nextHover = targetId;
        } else {
          marker.hidden = false;
          const edge =
            position === 'before' ? rect.top : row.parentElement.getBoundingClientRect().bottom;
          const clipped = Math.max(bounds.top, Math.min(bounds.bottom, edge));
          marker.classList.toggle('offscreen', clipped !== edge);
          Object.assign(marker.style, {
            left: `${rect.left}px`,
            top: `${clipped}px`,
            width: `${rect.width}px`,
          });
        }
      } catch (error) {
        feedback = error.message;
      }
    }
    const text = `Move “${session.expected.title || 'Untitled'}”\n${feedback}`;
    if (preview.textContent !== text) preview.textContent = text;
    const rect = preview.getBoundingClientRect();
    preview.style.left = `${Math.max(bounds.left + 4, Math.min(x + 12, bounds.right - rect.width - 4))}px`;
    preview.style.top = `${Math.min(y + 20, window.innerHeight - rect.height - 8)}px`;
    root.classList.toggle('move-invalid', !session.target);
    if (nextHover !== hoverId) {
      clearTimeout(hoverTimer);
      hoverId = nextHover;
      if (nextHover) hoverTimer = setTimeout(() => expand(nextHover), 600);
    }
    frame = requestAnimationFrame(paint);
  }

  function finish(keepExpansion = false) {
    const previous = session;
    session = null;
    cancelAnimationFrame(frame);
    clearTimeout(hoverTimer);
    hoverId = null;
    clear();
    marker.remove();
    preview.remove();
    previous?.row.classList.remove('dragging');
    root.classList.remove('moving-item', 'move-invalid');
    if (previous && root.hasPointerCapture(previous.pointerId))
      root.releasePointerCapture(previous.pointerId);
    if (previous?.expansion && !keepExpansion) restoreExpansion?.(previous.expansion);
    return previous;
  }

  const cancel = () => finish();

  root.addEventListener(
    'pointerdown',
    (event) => {
      suppressClick = false;
      cancel();
      if (
        event.button !== 0 ||
        !event.isPrimary ||
        event.target.closest('button') ||
        document.querySelector('dialog[open]')
      )
        return;
      const row = event.target.closest('.bookmark-row');
      const id = row?.dataset.bookmarkId;
      const index = getIndex();
      if (!index || !bookmarkEditable(index, id)) return;
      session = {
        id,
        row,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        expected: bookmarkRecord(index.byId.get(id)),
      };
    },
    { signal: events.signal },
  );
  root.addEventListener(
    'pointermove',
    (event) => {
      if (!session || session.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) {
        cancel();
        return;
      }
      session.x = event.clientX;
      session.y = event.clientY;
      if (
        !session.active &&
        Math.hypot(session.x - session.startX, session.y - session.startY) >= 5
      ) {
        session.active = true;
        session.expansion = captureExpansion?.();
        suppressClick = true;
        root.setPointerCapture(event.pointerId);
        session.row.classList.add('dragging');
        root.classList.add('moving-item');
        root.append(marker, preview);
        paint();
      }
      if (session.active) event.preventDefault();
    },
    { signal: events.signal },
  );
  root.addEventListener(
    'pointerup',
    (event) => {
      if (!session || session.pointerId !== event.pointerId) return;
      if (session.active) {
        session.x = event.clientX;
        session.y = event.clientY;
        cancelAnimationFrame(frame);
        paint();
      }
      const ended = finish(Boolean(session.target));
      if (ended.active && ended.target)
        commit(ended.id, ended.target.targetId, ended.target.position, ended.expected);
    },
    { signal: events.signal },
  );
  for (const type of ['pointercancel', 'lostpointercapture'])
    root.addEventListener(type, cancel, { signal: events.signal });
  window.addEventListener('blur', cancel, { signal: events.signal });
  document.addEventListener(
    'keydown',
    (event) => {
      if (session?.active && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    },
    { capture: true, signal: events.signal },
  );
  root.addEventListener(
    'click',
    (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true, signal: events.signal },
  );
  return {
    cancel,

    dispose() {
      cancel();
      events.abort();
      marker.remove();
    },
  };
}
