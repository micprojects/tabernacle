import { createRefreshScheduler } from './refresh-scheduler.js';
import { normalizeLook } from './look.js';
import { containerListIcon, visualChoices } from './container-dialogs.js';
import { sortContainers } from './containers.js';
import { icon } from './icons.js';
import { createSettingsBackup } from './settings-backup.js';
import { createNewTabSettings } from './new-tab-settings.js';

const $ = (id) => document.getElementById(id);
const demo = !globalThis.browser?.runtime?.id && new URLSearchParams(location.search).has('demo');
const fields = $('appearance-form').elements;
const dirty = new Set();
let savedLook, request, windowId;
let savingLook = false,
  savingContainer = false;
let containerItems = [],
  containerKey,
  editorGeneration = 0,
  editorTrigger;
let settingsState;
let disposed = false;
const folderBackup = createSettingsBackup({ request: (...args) => request(...args) });
const newTabSettings = createNewTabSettings({ request: (...args) => request(...args), demo });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorAt(id, error) {
  $(id).textContent = error?.message || '';
  $(id).hidden = !error;
}

function readLook() {
  return Object.fromEntries(
    Object.keys(normalizeLook()).map((key) => [
      key,
      fields[key].type === 'checkbox' ? fields[key].checked : fields[key].value,
    ]),
  );
}

function renderAppearance() {
  if (!savedLook) return;
  document.documentElement.dataset.colorScheme = savedLook.colorScheme;
}

function updateSaveState(message) {
  $('appearance-save').disabled = savingLook || !dirty.size || !savedLook;
  $('appearance-reset').disabled = savingLook || !dirty.size || !savedLook;
  $('appearance-status').textContent =
    message ?? (savingLook ? 'Saving…' : dirty.size ? 'Unsaved changes' : 'All changes saved');
}

function acceptLook(value) {
  savedLook = normalizeLook(value);
  for (const [key, value] of Object.entries(savedLook)) {
    const control = fields[key];
    if (!dirty.has(key)) {
      if (control.type === 'checkbox') control.checked = value;
      else control.value = value;
    } else if (readLook()[key] === value) dirty.delete(key);
  }
  renderAppearance();
  updateSaveState();
}

$('appearance-form').addEventListener('change', () => {
  const value = readLook();
  for (const key of Object.keys(savedLook)) {
    if (value[key] === savedLook[key]) dirty.delete(key);
    else dirty.add(key);
  }
  errorAt('appearance-error');
  renderAppearance();
  updateSaveState();
});
$('appearance-reset').addEventListener('click', () => {
  dirty.clear();
  errorAt('appearance-error');
  acceptLook(savedLook);
});
$('appearance-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (savingLook || !dirty.size) return;
  savingLook = true;
  $('appearance-fields').disabled = true;
  updateSaveState('Saving…');
  errorAt('appearance-error');
  try {
    const value = readLook();
    // Merge only the edited fields inside the controller's queue, preserving
    // concurrent changes from another settings tab or window.
    const next = await request('setLook', {
      value: Object.fromEntries([...dirty].map((key) => [key, value[key]])),
      partial: true,
    });
    dirty.clear();
    acceptLook(next.look);
  } catch (error) {
    errorAt('appearance-error', error);
  } finally {
    savingLook = false;
    $('appearance-fields').disabled = false;
    updateSaveState();
  }
});

function renderContainers() {
  const query = $('container-search').value.trim().toLocaleLowerCase();
  const items = sortContainers(containerItems).filter((item) =>
    item.name.toLocaleLowerCase().includes(query),
  );
  const key = JSON.stringify(items);
  if (key === containerKey) return;
  containerKey = key;
  const list = $('container-list');
  list.replaceChildren();
  if (!items.length)
    list.append(
      el(
        'p',
        'settings-note',
        query
          ? 'No containers match your search.'
          : 'No containers yet. Create one to keep a separate set of sign-ins.',
      ),
    );
  for (const identity of items) {
    const row = el('div', 'settings-container');
    const name = el('span', 'settings-container-name', identity.name);
    const actions = el('div', 'settings-container-actions');
    for (const [label, glyph, handler] of [
      ['Edit', 'rename', () => editContainer(identity)],
      ['Remove', 'trash', () => removeContainer(identity)],
    ]) {
      const button = el('button', 'icon-button');
      button.type = 'button';
      button.title = `${label} ${identity.name}`;
      button.setAttribute('aria-label', button.title);
      button.dataset.store = identity.cookieStoreId;
      button.dataset.action = label;
      button.append(icon(glyph));
      button.addEventListener('click', () => {
        if (savingContainer) return;
        editorTrigger = { store: identity.cookieStoreId, action: label };
        handler();
      });
      actions.append(button);
    }
    row.append(containerListIcon(identity), name, actions);
    list.append(row);
  }
}

let containersLoading = false,
  containersAgain = false;

async function loadContainers() {
  if (!request) return;
  if (containersLoading) {
    containersAgain = true;
    return;
  }
  containersLoading = true;
  if (containerKey === undefined) $('containers-status').textContent = 'Loading containers…';
  try {
    do {
      containersAgain = false;
      containerItems = (await request('getContainers')).containers;
      renderContainers();
    } while (containersAgain);
    errorAt('containers-error');
    $('containers-retry').hidden = true;
    $('containers-status').textContent = '';
  } catch (error) {
    errorAt('containers-error', error);
    $('containers-retry').hidden = false;
    $('containers-status').textContent = '';
  } finally {
    containersLoading = false;
  }
}

function closeEditor() {
  if (savingContainer) return;
  editorGeneration++;
  $('container-editor').close();
  $('container-editor').replaceChildren();
  const trigger = [...$('container-list').querySelectorAll('button')].find(
    (button) =>
      button.dataset.store === editorTrigger?.store &&
      button.dataset.action === editorTrigger?.action,
  );
  (trigger || $('container-new')).focus();
}

function editorForm(title, submitLabel, onSubmit) {
  const editor = $('container-editor');
  const heading = el('h2', '', title);
  heading.id = 'container-editor-title';
  const form = el('form');
  form.setAttribute('aria-labelledby', heading.id);
  const body = el('fieldset');
  body.className = 'container-form-body';
  const error = el('p', 'settings-error');
  error.id = 'container-edit-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const actions = el('div', 'settings-actions');
  const submit = el('button', 'settings-button primary', submitLabel);
  submit.type = 'submit';
  const cancel = el('button', 'settings-button', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeEditor);
  actions.append(submit, cancel);
  form.append(body, error, actions);
  editor.replaceChildren(heading, form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (savingContainer || submit.disabled) return;
    savingContainer = true;
    const controls = [...form.querySelectorAll('button, input')];
    for (const control of controls) control.disabled = true;
    errorAt('container-edit-error');
    try {
      await onSubmit(form);
      await loadContainers();
      savingContainer = false;
      closeEditor();
      $('containers-status').textContent =
        submitLabel === 'Remove container' ? 'Container removed.' : 'Container saved.';
    } catch (error) {
      errorAt('container-edit-error', error);
    } finally {
      savingContainer = false;
      for (const control of controls) control.disabled = false;
    }
  });
  editor.showModal();
  return { body, submit, cancel };
}

async function editContainer(identity) {
  const generation = ++editorGeneration;
  const { body, submit, cancel } = editorForm(
    identity ? 'Edit container' : 'New container',
    identity ? 'Save container' : 'Create container',
    async (form) => {
      const name = form.elements.name.value.trim();
      if (!name) throw new Error('Enter a container name.');
      await request(identity ? 'updateContainer' : 'createContainer', {
        cookieStoreId: identity?.cookieStoreId,
        name,
        color: form.elements['container-color'].value,
        icon: form.elements['container-icon'].value,
      });
    },
  );
  const label = el('label', '', 'Container name');
  label.htmlFor = 'container-name';
  const name = el('input');
  name.id = 'container-name';
  name.name = 'name';
  name.type = 'text';
  name.required = true;
  name.maxLength = 80;
  name.autocomplete = 'off';
  name.value = identity?.name || '';
  const choices = el('div', 'container-edit-fields');
  body.append(label, name, choices);
  submit.disabled = true;
  name.focus();
  try {
    const { colors, icons } = await request('getContainerChoices');
    if (generation !== editorGeneration) return;
    choices.append(
      visualChoices('color', 'Colour', colors, identity?.color || 'blue'),
      visualChoices('icon', 'Icon', icons, identity?.icon || 'fingerprint'),
    );

    const updateColour = () => {
      const selected = body.querySelector('[name="container-color"]:checked').value;
      choices.style.setProperty(
        '--container-icon-color',
        colors.find((item) => item.color === selected)?.colorCode || 'currentColor',
      );
    };

    choices.addEventListener('change', updateColour);
    updateColour();
    submit.disabled = false;
  } catch (error) {
    if (generation !== editorGeneration) return;
    errorAt('container-edit-error', error);
    cancel.focus();
  }
}

function removeContainer(identity) {
  editorGeneration++;
  const { body, submit, cancel } = editorForm(
    `Remove “${identity.name}”?`,
    'Remove container',
    () => request('removeContainer', { cookieStoreId: identity.cookieStoreId }),
  );
  body.append(
    el(
      'p',
      '',
      'This deletes the container and its cookies and site data from Firefox. Close its tabs in all windows first. Folders using it will need a new default container. This cannot be undone.',
    ),
  );
  submit.className = 'settings-button danger';
  cancel.focus();
}

$('container-new').addEventListener('click', () => {
  if (savingContainer || !request) return;
  editorTrigger = null;
  editContainer();
});
$('container-search').addEventListener('input', renderContainers);
$('containers-retry').addEventListener('click', loadContainers);
$('container-editor').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeEditor();
});

async function refreshShortcuts() {
  try {
    if (demo) {
      $('sidebar-shortcut').textContent = 'Alt+Shift+E';
      return;
    }
    const commands = await browser.commands.getAll();
    $('sidebar-shortcut').textContent =
      commands.find((command) => command.name === '_execute_sidebar_action')?.shortcut || 'Not set';
  } catch {
    $('sidebar-shortcut').textContent = 'Unavailable';
  }
}

$('shortcut-settings').addEventListener('click', async () => {
  errorAt('shortcuts-error');
  try {
    if (demo) throw new Error('Install Tabernacle in Firefox to change its extension shortcuts.');
    await browser.commands.openShortcutSettings();
  } catch (error) {
    errorAt(
      'shortcuts-error',
      demo
        ? error
        : new Error(
            'Could not open shortcut settings. Try Add-ons and themes → Manage Extension Shortcuts.',
          ),
    );
  }
});

function navigate(focus = false) {
  const sections = ['appearance', 'new-tab', 'containers', 'backup', 'shortcuts', 'about'];
  const section = sections.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'appearance';
  for (const id of sections) $(id).hidden = id !== section;
  for (const link of document.querySelectorAll('nav a')) {
    if (link.hash === `#${section}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (focus) $(`${section}-title`).focus();
  if (section === 'containers' && request) loadContainers();
  if (section === 'backup' && request) folderBackup.refresh();
  if (section === 'shortcuts') refreshShortcuts();
}

const refreshScheduler = createRefreshScheduler({
  delay: 50,
  globalOnly: true,
  getState: () => settingsState,
  canRefresh: () => Boolean(request) && !document.hidden,

  async refresh() {
    try {
      const next = await request('getSettings');
      if (disposed) return;
      settingsState = next;
      acceptLook(next.look);
      newTabSettings.accept(next.newTab);
      $('appearance-fields').disabled = savingLook;
      errorAt('page-error');
      if (!$('containers').hidden) await loadContainers();
    } catch (error) {
      if (!disposed) errorAt('page-error', error);
    }
  },
});
const scheduleRefresh = refreshScheduler.schedule;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh();
});
window.addEventListener(
  'pagehide',
  () => {
    disposed = true;
    refreshScheduler.dispose();
    newTabSettings.dispose();
  },
  { once: true },
);

window.addEventListener('hashchange', () => navigate(true));
window.addEventListener('focus', () => {
  scheduleRefresh();
  if (!$('shortcuts').hidden) refreshShortcuts();
});
window.addEventListener('beforeunload', (event) => {
  if (dirty.size || savingContainer || folderBackup.isBusy() || newTabSettings.isBusy())
    event.preventDefault();
});
for (const link of document.querySelectorAll('nav a')) link.prepend(icon(link.dataset.icon));
navigate();

async function start() {
  let manifest;
  if (demo) {
    $('demo-notice').hidden = false;
    const { connectDemo } = await import('../../preview/session.js');
    const controller = await connectDemo(scheduleRefresh);
    request = (type, args = {}) => controller.request({ type, windowId: 1, ...args });
    windowId = 1;
    manifest = await fetch(new URL('../manifest.json', import.meta.url)).then((response) =>
      response.json(),
    );
  } else {
    if (!globalThis.browser?.runtime?.id)
      throw new Error('Load Tabernacle in Firefox, or open the settings preview.');
    windowId = (await browser.windows.getCurrent()).id;
    request = async (type, args = {}) => {
      const result = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!result?.ok)
        throw new Error(result?.error || 'Could not load settings. Reload this page to try again.');
      return result.data;
    };

    // Firefox's native options launcher can open a second tab when the first
    // has a section fragment. Hand back before loading an editable second view.
    const tab = await browser.tabs.getCurrent();
    const owner = await request('claimSettingsPage', { id: tab.id });
    if (owner.tabId !== tab.id) {
      await browser.tabs.remove(tab.id);
      return;
    }

    const changed = (message) => {
      if (message.type === 'tabernacle:changed') scheduleRefresh(message);
      if (
        message.type === 'tabernacle:showSettingsSection' &&
        message.tabId === tab.id &&
        message.section === 'new-tab'
      )
        location.hash = 'new-tab';
    };

    browser.runtime.onMessage.addListener(changed);
    window.addEventListener('pagehide', () => browser.runtime.onMessage.removeListener(changed), {
      once: true,
    });
    manifest = browser.runtime.getManifest();
  }
  $('extension-version').textContent = `Version ${manifest.version}`;
  settingsState = await request('getSettings');
  acceptLook(settingsState.look);
  newTabSettings.accept(settingsState.newTab);
  $('appearance-fields').disabled = false;
  navigate();
}

start().catch((error) => {
  errorAt('page-error', error);
  $('appearance-status').textContent =
    'Settings could not be loaded. Reload this page to try again.';
});
