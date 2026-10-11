/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Firefox role fallbacks and brightness heuristic adapted from Mozilla.
 * See ../themes/NOTICE.txt. */
import { mozillaThemes } from '../themes/mozilla.js';
import { firefoxDefault, firefoxDefaults } from '../themes/firefox-default.js';

export const knownThemes = [firefoxDefault, ...mozillaThemes];
const catalogue = new Map(knownThemes.map((theme) => [theme.id, theme]));
const roles = Object.keys({
  ...firefoxDefaults(false),
  toolbar_field_border_focus: '',
  popup_highlight: '',
  popup_highlight_text: '',
  toolbar_bottom_separator: '',
  icons_attention: '',
  bookmark_text: '',
  accentcolor: '',
  textcolor: '',
});

export function themeColor(
  value,
  supports = (value) =>
    globalThis.CSS?.supports('color', value) ??
    /^(#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s/+-]+\)|transparent|black|white|red|blue|green)$/i.test(
      value,
    ),
) {
  if (Array.isArray(value)) {
    if (
      ![3, 4].includes(value.length) ||
      value.some((v, i) => !Number.isFinite(v) || v < 0 || v > (i === 3 ? 1 : 255))
    )
      return null;
    return `${value.length === 4 ? 'rgba' : 'rgb'}(${value.join(', ')})`;
  }
  if (
    typeof value !== 'string' ||
    /[;{}\\]|\b(?:var|env|url|light-dark)\s*\(|\b(?:currentcolor|inherit|initial|unset|revert)\b/i.test(
      value,
    )
  )
    return null;
  return supports(value) ? value : null;
}

function colorsFrom(details) {
  return Object.fromEntries(
    roles.flatMap((role) => {
      const value = themeColor(details?.colors?.[role]);
      return value === null ? [] : [[role, value]];
    }),
  );
}

function mix(color, percent) {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

// Incomplete external themes use Firefox's role fallbacks, not a mix of its
// colours and Tabernacle's purple palette. Images are trusted bundled data only.
export function paletteFrom(details, dark, { bundled = false, isDefault = false, platform } = {}) {
  const supplied = colorsFrom(details);
  if (!Object.keys(supplied).length) return null;
  const defaults = firefoxDefaults(dark);
  const c = { ...defaults, ...supplied };
  c.frame = supplied.frame || supplied.accentcolor || (isDefault ? defaults.frame : '#ffffff');
  c.tab_background_text =
    supplied.tab_background_text ||
    supplied.textcolor ||
    (isDefault ? defaults.tab_background_text : '#000000');
  c.toolbar = supplied.toolbar || (isDefault ? defaults.toolbar : 'rgba(255, 255, 255, 0.4)');
  c.toolbar_text = supplied.toolbar_text || supplied.bookmark_text || c.tab_background_text;
  c.icons = supplied.icons || c.toolbar_text;
  c.tab_selected = supplied.tab_selected || (isDefault ? defaults.tab_selected : c.toolbar);
  c.tab_text = supplied.tab_text || c.toolbar_text;
  c.tab_line = supplied.tab_line || (isDefault ? 'transparent' : c.tab_text);
  const nativeText = globalThis.CSS?.supports('color', '-moz-dialogtext')
    ? '-moz-dialogtext'
    : 'CanvasText';
  if (isDefault) c.popup_border = mix(nativeText, 24);
  if (!isDefault) {
    // Firefox content documents resolve Field to a generic dark grey. Chrome
    // uses macOS's native text background instead (verified in Firefox 157.0.1).
    c.popup = supplied.popup || (platform === 'mac' ? (dark ? '#1e1e1e' : '#ffffff') : 'Field');
    c.popup_text = supplied.popup_text || nativeText;
    c.toolbar_field =
      supplied.toolbar_field || (dark ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 0, 0, 0.05)');
    c.toolbar_field_text = supplied.toolbar_field_text || c.toolbar_text;
    c.toolbar_field_border = supplied.toolbar_field_border || 'transparent';
    c.toolbar_field_focus =
      supplied.toolbar_field_focus ||
      (platform === 'mac' ? (dark ? '#1e1e1e' : '#ffffff') : 'Field');
    c.toolbar_field_text_focus = supplied.toolbar_field_text_focus || 'FieldText';
    c.button_background_hover = supplied.button_background_hover || mix(c.icons, 17);
    c.button_background_active = supplied.button_background_active || mix(c.icons, 30);
    c.popup_border = supplied.popup_border || mix(c.tab_background_text, 24);
  }
  // Extension controls follow the selected palette rather than the OS accent.
  // Keep primary button colours paired, including themes without a highlight.
  const accent = isDefault
    ? dark
      ? '#b89cff'
      : '#764edd'
    : supplied.popup_highlight || c.popup_text;
  const accentText = isDefault
    ? dark
      ? '#252428'
      : '#ffffff'
    : supplied.popup_highlight
      ? supplied.popup_highlight_text || c.popup_text
      : c.popup;
  const focus = supplied.toolbar_field_border_focus || (isDefault ? accent : c.icons);
  const menuHover =
    supplied.popup_highlight ||
    (isDefault ? (dark ? '#75669f' : '#d2c8ec') : mix(c.popup_text, 17));
  const gradient = bundled
    ? (details.images?.additional_backgrounds || [])
        .flatMap((image) => {
          if (!image || typeof image !== 'object') return [];
          return Object.entries(image)
            .filter(([type]) =>
              /^(linear|radial|conic|repeating-linear|repeating-radial|repeating-conic)-gradient$/.test(
                type,
              ),
            )
            .map(([type, stops]) => `${type}(${stops})`);
        })
        .join(', ') || 'none'
    : 'none';
  const vars = {
    background: c.frame,
    text: c.tab_background_text,
    icon: c.tab_background_text,
    'toolbar-surface': c.toolbar,
    'toolbar-text': c.toolbar_text,
    'toolbar-icon': c.icons,
    muted: mix(c.tab_background_text, 72),
    line: supplied.toolbar_bottom_separator || mix(c.tab_background_text, 24),
    subtle: mix(c.tab_background_text, 7),
    hover: mix(c.tab_background_text, 17),
    'toolbar-hover': c.button_background_hover,
    'toolbar-active': c.button_background_active,
    control: c.tab_selected,
    selected: c.tab_selected,
    'selected-text': c.tab_text,
    'selected-border': c.tab_line,
    accent,
    'accent-text': accentText,
    focus,
    'action-text': c.tab_background_text,
    'action-hover': mix(c.tab_background_text, 17),
    'folder-icon': 'currentColor',
    panel: c.popup,
    'panel-text': c.popup_text,
    'panel-muted': mix(c.popup_text, 72),
    'panel-line': c.popup_border,
    'panel-hover': menuHover,
    'panel-hover-text': supplied.popup_highlight_text || c.popup_text,
    field: c.toolbar_field,
    'field-text': c.toolbar_field_text,
    'field-line': c.toolbar_field_border,
    'field-focus': c.toolbar_field_focus,
    'field-focus-text': c.toolbar_field_text_focus,
    'field-focus-line': supplied.toolbar_field_border_focus || (isDefault ? focus : mix(focus, 50)),
    'theme-gradient': gradient,
    'theme-background-size': bundled
      ? (details.properties?.additional_backgrounds_size || ['auto']).join(', ')
      : 'auto',
    'theme-background-position': bundled
      ? (details.properties?.additional_backgrounds_alignment || ['right top']).join(', ')
      : 'right top',
    'theme-background-repeat': bundled
      ? (details.properties?.additional_backgrounds_tiling || ['no-repeat']).join(', ')
      : 'no-repeat',
    'selected-border-gradient': isDefault
      ? 'linear-gradient(96deg, #b89cff 20.68%, #ff9565 79.34%)'
      : 'none',
  };
  return { vars, dark, isDefault };
}

// Firefox chooses the toolbar scheme from an opaque toolbar first, then text,
// then frame. Use the exposed base palette even if its dark variant is hidden.
function externalThemeDark(details, preference) {
  if (!details?.colors) return preference;
  const scheme = details?.properties?.color_scheme;
  if (scheme === 'dark' || scheme === 'light') return scheme === 'dark';
  if (scheme === 'system') return preference;
  const colors = details?.colors || {};
  const canvas = globalThis.document?.createElement('canvas').getContext('2d');

  function channels(value) {
    const color = themeColor(value);
    if (!color) return null;
    if (Array.isArray(value)) return [...value.slice(0, 3), value[3] ?? 1];
    if (canvas) {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    }
    const hex = /^#([0-9a-f]{6})$/i.exec(color);
    return hex ? [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) : null;
  }

  const isDark = ([r, g, b]) => 0.2125 * r + 0.7154 * g + 0.0721 * b <= 127;
  const toolbar = channels(colors.toolbar);
  if (toolbar?.[3] === 1) return isDark(toolbar);
  const text = channels(colors.toolbar_text || colors.bookmark_text);
  if (text) return !isDark(text);
  const frame = channels(colors.frame || colors.accentcolor);
  if (frame?.[3] === 1) return isDark(frame);
  const frameText = channels(colors.tab_background_text || colors.textcolor);
  return frameText ? !isDark(frameText) : preference;
}

export function resolveTheme(look, snapshot, dark) {
  if (look.themeSource === 'tabernacle')
    return { palette: null, status: 'Using Tabernacle’s colours' };
  const known = catalogue.get(snapshot.active?.id);
  if (known)
    return {
      palette: paletteFrom(
        dark && known.manifest.dark_theme ? known.manifest.dark_theme : known.manifest.theme,
        dark,
        { bundled: true, isDefault: known === firefoxDefault, platform: snapshot.platform },
      ),
      status: `Using ${known.name}`,
    };
  const palette = paletteFrom(snapshot.details, externalThemeDark(snapshot.details, dark), {
    platform: snapshot.platform,
  });
  return {
    palette,
    status: palette
      ? `Using ${snapshot.active?.name || 'Firefox theme colours'}`
      : 'Using Tabernacle’s fallback colours',
  };
}

// Only remove properties owned by this adapter. This also makes reverting to
// Tabernacle exactly restore its original CSS, including forced-colour rules.
export function createPaletteRenderer(root) {
  let previous = [];
  return (palette, colorScheme = 'default') => {
    for (const name of previous) root.style.removeProperty(name);
    previous = [];
    root.dataset.colorScheme = palette ? (palette.dark ? 'dark' : 'light') : colorScheme;
    delete root.dataset.firefoxTheme;
    if (!palette) return;
    root.dataset.firefoxTheme = palette.isDefault ? 'default' : 'custom';
    for (const [key, value] of Object.entries(palette.vars)) {
      const name = `--${key}`;
      root.style.setProperty(name, value);
      previous.push(name);
    }
  };
}
