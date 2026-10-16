import test from 'node:test';
import assert from 'node:assert/strict';
import {
  knownThemes,
  paletteFrom,
  resolveTheme,
  themeColor,
  createPaletteRenderer,
} from '../extension/src/theme-palette.js';
import { observeTheme } from '../extension/src/theme-observer.js';
import { normalizeLook, requireLook } from '../extension/src/look.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),

    emit: (data) => {
      for (const listener of listeners) listener(data);
    },

    get size() {
      return listeners.size;
    },
  };
}

test('theme settings default, validate, and keep fallback colour preferences', () => {
  assert.equal(normalizeLook().themeSource, 'tabernacle');
  assert.equal(resolveTheme({}, { active: knownThemes[0] }, false).palette, null);
  assert.deepEqual(normalizeLook({ themeSource: 'unknown', colorScheme: 'dark' }), {
    connectingLines: true,
    domains: false,
    animations: true,
    folderCounts: false,
    tintFavicons: false,
    themeSource: 'tabernacle',
    colorScheme: 'dark',
  });
  for (const themeSource of ['firefox', 'tabernacle'])
    assert.equal(
      requireLook({ connectingLines: true, domains: false, themeSource }).themeSource,
      themeSource,
    );
  for (const themeSource of [null, true, 'sun'])
    assert.throws(
      () => requireLook({ connectingLines: true, domains: false, themeSource }),
      /Choose Neutral or Use Firefox theme/,
    );
});

test('all 24 Mozilla variants preserve exact manifest roles and gradients', () => {
  assert.equal(knownThemes.length, 12);
  assert.equal(new Set(knownThemes.map((theme) => theme.id)).size, 12);
  for (const theme of knownThemes) {
    if (theme.id !== 'default-theme@mozilla.org') {
      assert.equal(theme.manifest.version, '1.1');
      assert.equal(theme.id, `nova-${theme.name.toLowerCase()}@mozilla.org`);
      assert.equal(theme.manifest.browser_specific_settings.gecko.id, theme.id);
      assert.match(theme.sha256, /^[a-f0-9]{64}$/);
    }
    for (const dark of [false, true]) {
      const details = dark ? theme.manifest.dark_theme : theme.manifest.theme;
      const { palette, status } = resolveTheme(
        { themeSource: 'firefox', colorScheme: dark ? 'light' : 'dark' },
        { active: theme },
        dark,
      );
      assert.equal(status, `Using ${theme.name}`);
      assert.equal(palette.dark, dark);
      for (const [role, token] of Object.entries({
        frame: 'background',
        tab_selected: 'selected',
        tab_text: 'selected-text',
        tab_line: 'selected-border',
        icons: 'toolbar-icon',
        toolbar: 'toolbar-surface',
        toolbar_field: 'field',
        toolbar_field_focus: 'field-focus',
      })) {
        assert.equal(
          palette.vars[token],
          themeColor(details.colors[role]),
          `${theme.name}/${dark}/${role}`,
        );
      }
      const gradients =
        (details.images?.additional_backgrounds || [])
          .map((image) =>
            Object.entries(image)
              .map(([kind, stops]) => `${kind}(${stops})`)
              .join(', '),
          )
          .join(', ') || 'none';
      assert.equal(palette.vars['theme-gradient'], gradients);
    }
  }
  const sun = knownThemes.find((theme) => theme.name === 'Sun');
  assert.equal(
    paletteFrom(sun.manifest.dark_theme, true, { bundled: true }).vars['theme-gradient'],
    'none',
  );
  assert.match(knownThemes.find((theme) => theme.name === 'Flame').source, /nova_flame\/$/);
});

test('manual and empty themes restore fallback; unknown themes use validated colours only', () => {
  for (const dark of [false, true]) {
    assert.equal(
      resolveTheme({ themeSource: 'tabernacle' }, { active: knownThemes[1] }, dark).palette,
      null,
    );
    assert.equal(resolveTheme({}, {}, dark).palette, null);
  }
  const unknown = {
    active: { id: 'custom', name: 'Custom' },
    details: {
      colors: { frame: '#123456', tab_selected: [1, 2, 3, 0.5], popup: 'invalid' },
      images: { additional_backgrounds: ['https://example.com/image.png'] },
    },
  };
  const { palette } = resolveTheme({ themeSource: 'firefox' }, unknown, false);
  assert.equal(palette.vars.background, '#123456');
  assert.equal(palette.vars.selected, 'rgba(1, 2, 3, 0.5)');
  assert.equal(palette.vars.panel, 'Field');
  assert.equal(palette.vars['theme-gradient'], 'none');
  for (const invalid of [
    [-1, 0, 0],
    [0, 0, 256],
    [1, 2, 3, 2],
    [NaN, 1, 2],
    'var(--text)',
    'inherit',
    'red; color: blue',
    'url(https://example.com)',
    'currentColor',
  ])
    assert.equal(themeColor(invalid), null);
  assert.equal(paletteFrom({ colors: { unrelated: '#fff', frame: 'invalid' } }, false), null);
});

test('palette replacement clears every owned override, preserving unrelated inline styles', () => {
  const properties = new Map([['--unrelated', 'value']]);
  const root = {
    dataset: {},
    style: {
      setProperty: (key, value) => properties.set(key, value),
      removeProperty: (key) => properties.delete(key),
    },
  };
  const paint = createPaletteRenderer(root);
  paint(resolveTheme({ themeSource: 'firefox' }, { active: knownThemes[1] }, false).palette);
  assert.match(properties.get('--theme-gradient'), /gradient/);
  paint(resolveTheme({ themeSource: 'firefox' }, { active: knownThemes[1] }, true).palette);
  assert.equal(properties.get('--theme-gradient'), 'none');
  paint(null, 'dark');
  assert.deepEqual([...properties], [['--unrelated', 'value']]);
  assert.deepEqual(root.dataset, { colorScheme: 'dark' });
});

test('custom controls use theme roles instead of unrelated system accent colours', () => {
  const colors = {
    frame: '#f5ece0',
    tab_background_text: '#321d0b',
    icons: '#67421a',
    popup: '#fff5e5',
    popup_text: '#3a2200',
    popup_highlight: '#775500',
    popup_highlight_text: '#ffffee',
    toolbar_field_border_focus: '#5a3100',
  };
  const { vars } = paletteFrom({ colors }, false);
  assert.equal(vars['action-text'], colors.tab_background_text);
  assert.equal(vars.accent, colors.popup_highlight);
  assert.equal(vars['accent-text'], colors.popup_highlight_text);
  assert.equal(vars.focus, colors.toolbar_field_border_focus);

  const { popup_highlight, popup_highlight_text, toolbar_field_border_focus, ...partial } = colors;
  const fallback = paletteFrom({ colors: partial }, false).vars;
  assert.equal(fallback.accent, colors.popup_text);
  assert.equal(fallback['accent-text'], colors.popup);
  assert.equal(fallback.focus, colors.icons);
  for (const theme of knownThemes)
    for (const dark of [false, true]) {
      const { palette } = resolveTheme({ themeSource: 'firefox' }, { active: theme }, dark);
      assert.doesNotMatch(Object.values(palette.vars).join(' '), /AccentColor/);
    }
});

test('observer scopes events, coalesces refreshes, ignores stale results and cleans up', async () => {
  const onUpdated = event(),
    onEnabled = event(),
    media = new EventTarget();
  media.matches = false;
  let requests = [],
    updates = 0,
    reads = 0;
  const api = {
    management: {
      onEnabled,
      getAll: async () => [
        { type: 'extension', enabled: true, name: 'Private inventory' },
        { type: 'theme', enabled: true, id: 'custom', name: 'Custom' },
      ],
    },
    theme: {
      onUpdated,

      getCurrent: (id) => {
        assert.equal(id, 7);
        reads++;
        return new Promise((resolve) => requests.push(resolve));
      },
    },
  };
  const observer = observeTheme({ api, windowId: 7, media, onChange: () => updates++ });
  await settle();
  onUpdated.emit({ windowId: 8 });
  onEnabled.emit({ type: 'extension' });
  await settle();
  assert.equal(reads, 1);
  onUpdated.emit({ windowId: 7 });
  onUpdated.emit({});
  onEnabled.emit({ type: 'theme' });
  await settle();
  assert.equal(reads, 2);
  requests[1]({ colors: { frame: '#222' } });
  await settle();
  requests[0]({ colors: { frame: '#111' } });
  await settle();
  assert.equal(observer.snapshot.details.colors.frame, '#222');
  assert.deepEqual(observer.snapshot.active, { id: 'custom', name: 'Custom', version: undefined });
  assert.equal(updates, 1);
  media.matches = true;
  media.dispatchEvent(new Event('change'));
  assert.equal(observer.dark, true);
  assert.equal(updates, 2);
  onUpdated.emit({});
  await settle();
  observer.dispose();
  requests[2]({});
  await settle();
  assert.equal(updates, 2);
  assert.equal(onUpdated.size, 0);
  assert.equal(onEnabled.size, 0);
});

test('observer API failures remain safe and recover on a later theme event', async () => {
  const onUpdated = event();
  let fail = true;
  const observer = observeTheme({
    windowId: 1,

    onChange() {},

    api: {
      management: {
        getAll: async () => {
          throw new Error('Unavailable');
        },
      },
      theme: {
        onUpdated,

        getCurrent: async () => {
          if (fail) throw new Error('Unavailable');
          return { colors: { frame: '#fff' } };
        },
      },
    },
  });
  await settle();
  assert.deepEqual(observer.snapshot, { active: null, details: null, platform: undefined });
  fail = false;
  onUpdated.emit({});
  await settle();
  assert.equal(observer.snapshot.details.colors.frame, '#fff');
  observer.dispose();
});

test('external themes keep the exposed palette scheme rather than inventing a dark variant', () => {
  const resolve = (details, dark) =>
    resolveTheme({ themeSource: 'firefox' }, { details }, dark).palette;
  assert.equal(
    resolve({ colors: { toolbar: '#ffffff', toolbar_text: '#000000' } }, true).dark,
    false,
  );
  assert.equal(
    resolve({ colors: { toolbar: [10, 10, 10], toolbar_text: '#ffffff' } }, false).dark,
    true,
  );
  assert.equal(resolve({ colors: { toolbar_text: [255, 255, 255] } }, false).dark, true);
  assert.equal(
    resolve({ colors: { frame: '#123456' }, properties: { color_scheme: 'light' } }, true).dark,
    false,
  );
  assert.equal(
    resolve({ colors: { frame: '#123456' }, properties: { color_scheme: 'system' } }, false).dark,
    false,
  );
});
