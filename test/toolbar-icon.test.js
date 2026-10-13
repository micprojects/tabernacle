import test from 'node:test';
import assert from 'node:assert/strict';
import { followToolbarTheme, toolbarIconPath } from '../extension/src/toolbar-icon.js';
import { knownThemes } from '../extension/src/theme-palette.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const svg = (path) => decodeURIComponent(path.slice(path.indexOf(',') + 1));

function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),

    emit: (value) => {
      for (const fn of listeners) fn(value);
    },
  };
}

test('a per-window theme override takes precedence over a recognised global theme', () => {
  const active = knownThemes[0];
  const path = toolbarIconPath(active, { colors: { icons: '#c12345', toolbar: '#eeeeee' } });
  assert.match(svg(path), /stroke="#c12345"/);
  assert.doesNotMatch(svg(path), /#75669f|#e7e1f8/);
});

test('unknown theme colours fall back safely and cannot inject SVG markup', () => {
  const path = toolbarIconPath(null, {
    colors: { icons: 'url(https://example.com/icon)', toolbar_text: '#123456' },
  });
  assert.match(svg(path), /stroke="#123456"/);
  assert.doesNotMatch(svg(path), /example\.com/);
  const invalid = toolbarIconPath(null, { colors: { icons: '"><script>bad()</script>' } });
  assert.doesNotMatch(svg(invalid), /<script>/);
  assert.equal(toolbarIconPath(null, null), 'icons/tabernacle-toolbar.svg');
});

function harness() {
  const action = [],
    sidebar = [],
    errors = [];
  let windows = [{ id: 1 }, { id: 2 }];
  const api = {
    windows: {
      getAll: async () => windows,
      onCreated: event(),
      onRemoved: event(),
    },
    management: {
      getAll: async () => [],
      onEnabled: event(),
      onDisabled: event(),
      onInstalled: event(),
      onUninstalled: event(),
    },
    theme: {
      getCurrent: async (id) => ({ colors: { icons: id === 1 ? '#112233' : '#445566' } }),
      onUpdated: event(),
    },
    action: {
      setIcon: async (value) => {
        action.push(value);
      },
    },
    sidebarAction: {
      setIcon: async (value) => {
        sidebar.push(value);
      },
    },
  };
  return {
    api,
    action,
    sidebar,
    errors,

    setWindows: (value) => {
      windows = value;
    },
  };
}

test('icons initialise per window, update without a sidebar and avoid redundant writes', async () => {
  const { api, action, sidebar, setWindows } = harness();
  const stop = followToolbarTheme(api);
  await settle();
  assert.deepEqual(sidebar, action);
  assert.match(svg(action.find((entry) => entry.windowId === 1).path), /#112233/);
  assert.match(svg(action.find((entry) => entry.windowId === 2).path), /#445566/);
  api.theme.onUpdated.emit({ windowId: 1 });
  await settle();
  assert.equal(action.length, 2);
  setWindows([{ id: 1 }, { id: 2 }, { id: 3 }]);
  api.windows.onCreated.emit({ id: 3 });
  await settle();
  assert.equal(action.at(-1).windowId, 3);
  assert.equal(action.length, 3);
  stop();
  api.theme.onUpdated.emit({});
  await settle();
  assert.equal(action.length, 3);
});

test('a slow old theme read cannot overwrite a newer theme', async () => {
  const { api, action } = harness();
  let release;
  const stale = new Promise((resolve) => {
    release = resolve;
  });
  api.theme.getCurrent = () => stale;
  const stop = followToolbarTheme(api);
  await settle();
  api.theme.getCurrent = async () => ({ colors: { icons: '#abcdef' } });
  api.theme.onUpdated.emit({});
  release({ colors: { icons: '#000000' } });
  await settle();
  assert.equal(action.length, 2);
  for (const entry of action) assert.match(svg(entry.path), /#abcdef/);
  stop();
});

test('a failed icon update retries on the next theme event', async () => {
  const { api, action, errors } = harness();
  const setIcon = api.action.setIcon;
  api.action.setIcon = async () => {
    throw new Error('temporary failure');
  };
  const stop = followToolbarTheme(api, (error) => errors.push(error));
  await settle();
  assert.equal(errors.length, 2);
  api.action.setIcon = setIcon;
  api.theme.onUpdated.emit({});
  await settle();
  assert.equal(action.length, 2);
  stop();
});
