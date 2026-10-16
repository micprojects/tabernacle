import { icon } from './icons.js';
import { domainFromUrl } from './domain-filter.js';
import { resolveDomainTitle } from './domain-title.js';

// Weight coloured, opaque pixels so white backgrounds and transparent padding
// do not drown out the favicon's main colour.
export function faviconColour(pixels) {
  const buckets = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, alpha] = pixels.subarray(i, i + 4);
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (alpha < 64 || spread < 24) continue;
    const weight = (alpha / 255) * (spread / 255);
    const key = [r, g, b].map((value) => Math.round(value / 32)).join(',');
    const bucket = buckets.get(key) || { weight: 0, rgb: [0, 0, 0] };
    bucket.weight += weight;
    [r, g, b].forEach((value, channel) => (bucket.rgb[channel] += value * weight));
    buckets.set(key, bucket);
  }
  const main = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
  return main ? main.rgb.map((value) => Math.round(value / main.weight)) : null;
}

function paintWash(image, canvas) {
  const source = document.createElement('canvas');
  source.width = source.height = 32;
  const sample = source.getContext('2d', { willReadFrequently: true });
  sample.drawImage(image, 0, 0, 32, 32);
  const context = canvas.getContext('2d');
  try {
    const colour = faviconColour(sample.getImageData(0, 0, 32, 32).data);
    context.fillStyle = colour ? `rgb(${colour.join(',')})` : '#808080';
    context.fillRect(0, 0, 1, 1);
  } catch {
    // Cross-origin icons can be displayed but their pixels cannot be read.
    // Blend samples directly into a display-only canvas instead. It remains
    // tainted; no pixel data is extracted and no extra permissions are needed.
    let count = 0;
    for (let y = 2; y < 32; y += 4)
      for (let x = 2; x < 32; x += 4) {
        context.globalAlpha = 1 / ++count;
        context.drawImage(source, x, y, 1, 1, 0, 0, 1, 1);
      }
    context.globalAlpha = 1;
  }
}

const faviconUrl = (tab) =>
  typeof tab?.favIconUrl === 'string' &&
  /^(https?:|data:image\/|moz-extension:)/i.test(tab.favIconUrl)
    ? tab.favIconUrl
    : null;

export function createDomainHeader(header) {
  const name = header.querySelector('#domain-name');
  const address = header.querySelector('#domain-address');
  const slot = header.querySelector('#domain-icon');
  const wash = header.querySelector('canvas');
  let currentDomain;
  let currentUrl;
  let currentImage;
  let currentTitle;

  function resetIcon() {
    currentImage = null;
    slot.replaceChildren(icon('globe'));
    // Reset both pixels and the canvas's origin-clean flag between sites.
    wash.width = wash.height = 1;
  }

  return (domain, tabs = [], sourceId = null) => {
    header.hidden = !domain;
    if (domain !== currentDomain) {
      currentDomain = domain;
      currentUrl = null;
      currentTitle = null;
      resetIcon();
    }
    // Retain a resolved name if its source tab closes, including an empty view.
    currentTitle = (domain && resolveDomainTitle(domain, tabs)) || currentTitle;
    name.textContent = currentTitle || domain || '';
    name.title = name.textContent;
    address.textContent = domain || '';
    address.title = domain || '';
    address.hidden = !currentTitle;
    if (!domain) return;
    const source = tabs.find((tab) => tab.id === sourceId);
    const exact = tabs.find((tab) => domainFromUrl(tab.url) === domain && faviconUrl(tab));
    // Keep the last icon when the final result closes, so the empty view retains
    // its identity. Prefer the chosen tab, then another tab on the same host.
    const url = faviconUrl(source) || faviconUrl(exact) || faviconUrl(tabs.find(faviconUrl));
    if (!url || url === currentUrl) return;
    currentUrl = url;
    resetIcon();
    const image = new Image();
    currentImage = image;
    image.alt = '';
    image.draggable = false;
    image.referrerPolicy = 'no-referrer';
    image.addEventListener(
      'load',
      () => {
        if (currentImage !== image) return;
        paintWash(image, wash);
      },
      { once: true },
    );
    image.addEventListener(
      'error',
      () => {
        if (currentImage === image) resetIcon();
      },
      { once: true },
    );
    slot.replaceChildren(image);
    image.src = url;
  };
}
