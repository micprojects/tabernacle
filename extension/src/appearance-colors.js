// Preserve container hues while giving text and thin indicators enough contrast
// on the neutral surfaces. CSS light-dark() also responds to live colour-mode changes.
const cache = new Map();
const guideCache = new Map();
// Softer light/dark pairs for Firefox's container colours (including the older
// identity palette). Custom folder colours retain their chosen hue below.
const containerTones = new Map([
  ...['#37adff', '#00a7e0'].map((color) => [color, ['#1679db', '#79bfff', '#0067c0']]),
  ...['#ff9f00', '#f89c24'].map((color) => [color, ['#b96805', '#ffad59', '#995000']]),
  ...['#51cd00', '#00a465'].map((color) => [color, ['#168736', '#70cf79', '#168736']]),
  ...['#ff4bda', '#d65780'].map((color) => [color, ['#b8218a', '#f57ac2', '#b8218a']]),
]);

function luminance(rgb) {
  return rgb
    .map((value) => {
      value /= 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
}

function shade(rgb, background, target, endpoint) {
  const surface = luminance(background);
  const mix = (amount) => rgb.map((value) => Math.round(value + (endpoint - value) * amount));

  const contrast = (colour) => {
    const value = luminance(colour);
    return (Math.max(value, surface) + 0.05) / (Math.min(value, surface) + 0.05);
  };

  let low = 0,
    high = 1;
  if (contrast(rgb) >= target) high = 0;
  else
    for (let i = 0; i < 16; i++) {
      const middle = (low + high) / 2;
      if (contrast(mix(middle)) >= target) high = middle;
      else low = middle;
    }
  return `#${mix(high)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function appearanceColor(color, text = false) {
  if (!/^#[\da-f]{6}$/i.test(color || '')) return null;
  const key = `${color}:${text}`;
  if (!cache.has(key)) {
    const channels = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
    const tones = containerTones.get(color.toLowerCase());
    const light = channels(tones?.[text ? 2 : 0] || color);
    const dark = channels(tones?.[1] || color);
    const target = text ? 4.6 : 3.1;
    cache.set(
      key,
      `light-dark(${shade(light, [247, 247, 247], target, 0)}, ${shade(dark, [32, 32, 32], target, 255)})`,
    );
  }
  return cache.get(key);
}

// Guides have their own contrast range instead of using the darker text shades.
// Adjust OKLab lightness while retaining hue/chroma; reduce chroma only to fit sRGB.
function guideTone(color, dark, target) {
  const linear = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = linear;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  let a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  let labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  if (Math.hypot(a, labB) < 0.00001) a = labB = 0;

  function at(lightness) {
    let chroma = 1,
      rgb;
    for (let i = 0; i < 120; i++) {
      const l = (lightness + chroma * (0.3963377774 * a + 0.2158037573 * labB)) ** 3;
      const m = (lightness - chroma * (0.1055613458 * a + 0.0638541728 * labB)) ** 3;
      const s = (lightness - chroma * (0.0894841775 * a + 1.291485548 * labB)) ** 3;
      rgb = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
      ].map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
      if (rgb.every((c) => c >= 0 && c <= 1)) break;
      chroma *= 0.97;
    }
    return rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * 255))));
  }

  const background = dark ? luminance([32, 32, 32]) : 1;
  let low = 0,
    high = 1;
  for (let i = 0; i < 28; i++) {
    const middle = (low + high) / 2;
    const value = luminance(at(middle));
    const enough =
      (Math.max(value, background) + 0.05) / (Math.min(value, background) + 0.05) >= target;
    if (dark ? enough : !enough) high = middle;
    else low = middle;
  }
  return `#${at(dark ? high : low)
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;
}

// Three opaque shades, cached per identity. CSS picks the visible depth and
// holds the third shade for deeper folders/tabs, including after scope changes.
export function guideColors(color) {
  const key = /^#[\da-f]{6}$/i.test(color || '') ? color.toLowerCase() : '#858585';
  if (!guideCache.has(key)) {
    const source = containerTones.get(key)?.[0] || key;
    guideCache.set(
      key,
      Object.freeze(
        [4.1, 3.55, 3.1].map(
          (target, i) =>
            `light-dark(${guideTone(source, false, target)}, ${guideTone(source, true, [6.5, 5.5, 4.6][i])})`,
        ),
      ),
    );
  }
  return guideCache.get(key);
}

// Keep the identity hue as strong as possible while meeting text contrast on
// every supplied surface. Surfaces that cannot share a readable identity shade
// use the neutral text colour instead.
export function labelColor(color, backgrounds, target = 7) {
  if (!/^#[\da-f]{6}$/i.test(color || '') || !backgrounds.length) return null;
  const rgb = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
  const surfaces = backgrounds.map(luminance);

  const contrast = (rgb) => {
    const value = luminance(rgb);
    return Math.min(
      ...surfaces.map(
        (surface) => (Math.max(value, surface) + 0.05) / (Math.min(value, surface) + 0.05),
      ),
    );
  };

  const endpoint = contrast([0, 0, 0]) >= contrast([255, 255, 255]) ? 0 : 255;
  const threshold = Math.min(target, contrast([endpoint, endpoint, endpoint]));
  if (threshold < 4.5) return null;
  for (let step = 0; step <= 255; step++) {
    const shade = rgb.map((value) => Math.round(value + ((endpoint - value) * step) / 255));
    if (contrast(shade) >= threshold)
      return `#${shade.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}
