// Preserve container hues while giving text and thin indicators enough contrast
// on the neutral surfaces. CSS light-dark() also responds to live theme changes.
const cache = new Map();
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

export function setItemColor(node, color) {
  node.style.setProperty('--item-colour', appearanceColor(color) || 'var(--neutral-marker)');
}
