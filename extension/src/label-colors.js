import { labelColor } from './appearance-colors.js';

// Resolve theme surfaces once per appearance change, not once per tab. Shared
// CSS variables update existing labels without replacing focused/clicked rows.
export function createLabelColors(root, surface) {
  const colors = new Map();
  let themeKey, backgrounds;

  function paint(entry) {
    for (const [name, surfaces] of Object.entries(backgrounds)) {
      const value = labelColor(entry.color, surfaces, name.startsWith('muted') ? 4.6 : 7);
      const property = `--caption-${entry.id}-${name}`;
      if (value) root.style.setProperty(property, value);
      else root.style.removeProperty(property);
    }
  }

  return {
    configure(palette, dark, forcedColors) {
      const key = JSON.stringify([palette, root.dataset.colorScheme, dark, forcedColors]);
      if (key === themeKey) return;
      themeKey = key;
      const probe = document.createElement('span');
      probe.hidden = true;
      surface.append(probe);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });

      function composite(...layers) {
        context.clearRect(0, 0, 1, 1);
        for (const layer of layers) {
          probe.style.color = layer;
          context.fillStyle = getComputedStyle(probe).color;
          context.fillRect(0, 0, 1, 1);
        }
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      }

      // Bundled themes use a uniform translucent tint over their frame colour.
      const tint = palette?.vars['theme-sidebar-gradient']?.match(
        /^linear-gradient\((.+), \1\)$/,
      )?.[1];
      const base = ['Canvas', 'var(--background)', ...(tint ? [tint] : [])];
      // Firefox themes blend the top of the tree into the native Canvas surface.
      const layers = palette ? [base, ['Canvas']] : [base];
      const normal = layers.map((layers) => composite(...layers));
      const hover = layers.map((layers) => composite(...layers, 'var(--hover)'));
      backgrounds = {
        color: normal,
        muted: normal,
        hover,
        'muted-hover': hover,
        selected: layers.map((layers) => composite(...layers, 'var(--selected)')),
      };
      probe.remove();
      for (const entry of colors.values()) paint(entry);
    },

    apply(row, color) {
      let entry;
      if (/^#[\da-f]{6}$/i.test(color || '')) {
        const key = color.toLowerCase();
        if (!colors.has(key)) {
          const next = { color: key, id: colors.size };
          colors.set(key, next);
          paint(next);
        }
        entry = colors.get(key);
      }
      for (const name of Object.keys(backgrounds)) {
        const property = `--label-${name}`;
        const value = entry ? `var(--caption-${entry.id}-${name}, currentColor)` : 'currentColor';
        if (row.style.getPropertyValue(property) !== value) row.style.setProperty(property, value);
      }
    },
  };
}
