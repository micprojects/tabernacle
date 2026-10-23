// Keep only scalar references when a hidden view releases its rows.
export function captureFocus(node = document.activeElement) {
  if (node?.id) return { id: node.id };
  const row = node?.closest('[data-key]');
  if (!row) return null;
  const controls = [...row.querySelectorAll('button, a, input, select, textarea, [tabindex]')];
  return { key: row.dataset.key, control: controls.indexOf(node) };
}

export function restoreFocusToken(reference, fallback) {
  let target = reference?.id ? document.getElementById(reference.id) : null;
  if (!target && reference?.key) {
    const row = document.querySelector('[data-key="' + CSS.escape(reference.key) + '"]');
    target =
      reference.control >= 0
        ? row?.querySelectorAll('button, a, input, select, textarea, [tabindex]')[reference.control]
        : row;
  }
  (target || fallback)?.focus({ preventScroll: true });
}

export function captureScroll(root, selector, attribute = 'data-key', scroller = root) {
  const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
  let anchor;
  for (const row of root.querySelectorAll(selector)) {
    const bounds = row.getBoundingClientRect();
    if (bounds.height && bounds.bottom > top) {
      anchor = { key: row.getAttribute(attribute), offset: bounds.top - top };
      break;
    }
  }
  return { top: scroller.scrollTop, left: scroller.scrollLeft, anchor, attribute };
}

export function restoreScroll(root, saved, scroller = root) {
  if (!saved) return;
  scroller.scrollTop = saved.top;
  scroller.scrollLeft = saved.left;
  if (!saved.anchor?.key) return;
  const row = root.querySelector(
    '[' + saved.attribute + '="' + CSS.escape(saved.anchor.key) + '"]',
  );
  if (!row) return;
  const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
  scroller.scrollTop += row.getBoundingClientRect().top - top - saved.anchor.offset;
}
