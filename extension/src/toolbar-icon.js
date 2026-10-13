import { knownThemes, themeColor } from './theme-palette.js';
import { firefoxDefaults } from '../themes/firefox-default.js';

const catalogue = new Map(knownThemes.map((theme) => [theme.id, theme]));

function iconColor(colors, fallback) {
  for (const key of [
    'icons',
    'toolbar_text',
    'bookmark_text',
    'tab_background_text',
    'textcolor',
  ]) {
    const color = themeColor(colors?.[key]);
    if (color && color !== 'transparent') return color;
  }
  return fallback;
}

function escapeXML(value) {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// Let the SVG's browser-chrome context choose its light/dark variant. The
// background page's media query can follow a different website colour setting.
export function toolbarIconSVG(
  light = firefoxDefaults(false).icons,
  dark = firefoxDefaults(true).icons,
) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
  <style>
    .dark {
      display: none;
    }
    @media (prefers-color-scheme: dark) {
      .light {
        display: none;
      }
      .dark {
        display: inline;
      }
    }
  </style>
  <defs>
    <g id="mark" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="0.75" y="0.75" width="14.5" height="14.5" rx="2.75" />
      <path d="M0.75 5.25h14.5M6.25 5.25v10" />
    </g>
  </defs>
  <use class="light" href="#mark" stroke="${escapeXML(light)}" />
  <use class="dark" href="#mark" stroke="${escapeXML(dark)}" />
</svg>
`;
}

export function toolbarIconPath(active, details) {
  const known = catalogue.get(active?.id);
  // A dynamic theme may override a built-in theme in an individual window.
  const matches = (variant) =>
    !details?.colors ||
    Object.entries(details.colors).every(
      ([key, value]) => value == null || themeColor(value) === themeColor(variant?.colors?.[key]),
    );
  const bundled = known && (matches(known.manifest.theme) || matches(known.manifest.dark_theme));
  if (!bundled && !details?.colors) return 'icons/tabernacle-toolbar.svg';
  const light = iconColor(
    bundled ? known.manifest.theme.colors : details.colors,
    firefoxDefaults(false).icons,
  );
  const dark = bundled
    ? iconColor(
        (known.manifest.dark_theme || known.manifest.theme).colors,
        firefoxDefaults(true).icons,
      )
    : iconColor(details.colors, firefoxDefaults(true).icons);
  return `data:image/svg+xml,${encodeURIComponent(toolbarIconSVG(light, dark))}`;
}

export function followToolbarTheme(
  api,
  report = (error) => console.warn('Tabernacle could not update its toolbar icon:', error.message),
) {
  let revision = 0;
  let pending = false;
  let running = false;
  let disposed = false;
  const paths = new Map();
  const removers = [];

  async function refresh() {
    if (running || disposed) return;
    running = true;
    try {
      while (pending && !disposed) {
        pending = false;
        const current = revision;
        const [windows, addons] = await Promise.all([
          api.windows.getAll({ windowTypes: ['normal'] }),
          api.management.getAll().catch(() => []),
        ]);
        const active = addons.find((addon) => addon.type === 'theme' && addon.enabled);
        const updates = await Promise.all(
          windows.map(async ({ id }) => {
            const details = await api.theme.getCurrent(id).catch(() => null);
            return { id, path: toolbarIconPath(active, details) };
          }),
        );
        if (disposed || current !== revision) continue;
        for (const id of paths.keys())
          if (!windows.some((window) => window.id === id)) paths.delete(id);
        await Promise.all(
          updates.map(async ({ id, path }) => {
            if (paths.get(id) === path) return;
            try {
              await Promise.all([
                api.action.setIcon({ windowId: id, path }),
                api.sidebarAction.setIcon({ windowId: id, path }),
              ]);
              paths.set(id, path);
            } catch (error) {
              report(error);
            }
          }),
        );
      }
    } catch (error) {
      report(error);
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (disposed) return;
    revision++;
    pending = true;
    queueMicrotask(refresh);
  }

  function listen(event, listener) {
    event.addListener(listener);
    removers.push(() => event.removeListener(listener));
  }

  // Register synchronously so Firefox can wake the MV3 background event page.
  listen(api.theme.onUpdated, schedule);
  listen(api.windows.onCreated, schedule);
  listen(api.windows.onRemoved, (id) => paths.delete(id));
  for (const type of ['onEnabled', 'onDisabled', 'onInstalled', 'onUninstalled'])
    listen(api.management[type], (addon) => {
      if (addon.type === 'theme') schedule();
    });
  schedule();
  return () => {
    disposed = true;
    for (const remove of removers) remove();
    paths.clear();
  };
}
