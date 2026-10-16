import { appearanceColor } from './appearance-colors.js';

function svgElement(name, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

// Share one local filter per container colour. The original image is retained,
// with no canvas readback, replacement favicon request or flattened silhouette.
export function createFaviconTints() {
  const filters = new Map();
  let definitions;
  return (color) => {
    const shade = appearanceColor(color, true);
    if (!shade) return null;
    if (!filters.has(color)) {
      if (!definitions) {
        const svg = svgElement('svg', {
          width: '0',
          height: '0',
          'aria-hidden': 'true',
          focusable: 'false',
        });
        svg.style.position = 'absolute';
        definitions = svgElement('defs');
        svg.append(definitions);
        document.body.append(svg);
      }
      const id = `favicon-tint-${filters.size}`;
      const filter = svgElement('filter', { id, 'color-interpolation-filters': 'sRGB' });
      const flood = svgElement('feFlood', { result: 'tint' });
      // light-dark() follows the sidebar's colour scheme without rebuilding icons.
      flood.style.floodColor = shade;
      filter.append(
        svgElement('feColorMatrix', {
          in: 'SourceGraphic',
          type: 'saturate',
          values: '0',
          result: 'grey',
        }),
        flood,
        svgElement('feBlend', { in: 'tint', in2: 'grey', mode: 'color' }),
        svgElement('feComposite', { in2: 'SourceAlpha', operator: 'in' }),
      );
      definitions.append(filter);
      filters.set(color, { filter: `url(#${id})`, color: shade });
    }
    return filters.get(color);
  };
}
