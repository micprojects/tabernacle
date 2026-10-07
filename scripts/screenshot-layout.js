import assert from 'node:assert/strict';

// Rectangles come from Firefox; only the presentation crop changes, never the UI.
export function resolveScreenshotCrop(framing, measured, sourceOrigin) {
  let left = 0,
    top = 0,
    right = measured.viewport.width,
    bottom;
  if (measured.element) {
    ({ left, top, right, bottom } = measured.element);
  } else {
    top = measured.top ? measured.top.top - (framing.paddingTop || 0) : 0;
    bottom = measured.bottom.bottom + (framing.paddingBottom || 0);
    bottom = Math.max(bottom, top + (framing.minimumHeight || 0));
    assert(
      measured.bottom.bottom <= measured.treeBottom + 1,
      'Screenshot content is scrolled out of view; increase capture.sourceSize.height',
    );
  }
  left = Math.floor(left);
  top = Math.floor(top);
  right = Math.ceil(right);
  bottom = Math.ceil(bottom);
  assert(
    left >= 0 && top >= 0 && right <= measured.viewport.width && bottom <= measured.viewport.height,
    'Screenshot crop extends outside the captured sidebar',
  );
  assert(right > left && bottom > top, 'Screenshot crop is empty');
  return {
    left: left + sourceOrigin.left,
    top: top + sourceOrigin.top,
    width: right - left,
    height: bottom - top,
  };
}

export function fitScreenshotImage(image, imageHeight, canvas) {
  const margin = 24;
  const ratio = Math.min(1, (canvas.height - 2 * margin) / imageHeight);
  const width = image.width * ratio;
  const height = imageHeight * ratio;
  const left = image.left + (image.width - width) / 2;
  const top = Math.max(margin, Math.min(image.top, canvas.height - margin - height));
  assert(
    left >= margin && left + width <= canvas.width - margin,
    'Screenshot is outside its composition',
  );
  return { left, top, width, height };
}
