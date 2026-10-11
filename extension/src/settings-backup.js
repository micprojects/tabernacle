import { createFolderPicker } from './folder-picker.js';
import { groupPath } from './model.js';
import { MAX_BACKUP_BYTES, parseFolderBackup } from './folder-backup.js';

const $ = (id) => document.getElementById(id);
const countFolders = (count) => `${count} folder${count === 1 ? '' : 's'}`;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function createSettingsBackup({ request }) {
  let state = { groups: [], containers: [] },
    backup,
    picker,
    preview;
  let busy = false,
    ready = false,
    generation = 0,
    parentId = null;
  const mappings = new Map();

  function error(error) {
    $('backup-error').textContent = error?.message || '';
    $('backup-error').hidden = !error;
  }

  function setBusy(value) {
    busy = value;
    $('backup-fields').disabled = busy || !ready;
    $('backup-export').disabled = busy || !ready;
    $('backup-cancel').disabled = busy;
    for (const select of mappings.values()) select.disabled = busy;
    $('backup-import').disabled =
      busy || !preview || [...mappings.values()].some((select) => !select.value);
  }

  function invalidate() {
    generation++;
    preview = null;
    mappings.clear();
    $('backup-preview').hidden = true;
    $('backup-status').textContent = '';
    error();
  }

  function renderPicker() {
    picker?.destroy();
    picker = null;
    $('backup-picker').replaceChildren();
    const mode = $('backup-destination').value;
    $('backup-name-field').hidden = mode !== 'new';
    if (mode === 'home') return;
    picker = createFolderPicker({
      getState: () => state,
      parentId,
      dialog: document,
      idPrefix: 'backup-',
      labelText: mode === 'new' ? 'Create in' : 'Destination folder',
      helpText: 'Choose where the imported folders will go.',

      onChange: (id) => {
        parentId = id;
        invalidate();
      },
    });
    $('backup-picker').append(picker.element);
  }

  async function refresh() {
    if (busy) return;
    try {
      state = await request('getFolderBackupState');
      ready = true;
      if (parentId !== null && !state.groups.some((group) => group.id === parentId)) {
        parentId = null;
        invalidate();
      }
      renderPicker();
      error();
    } catch (reason) {
      error(reason);
    }
    setBusy(false);
  }

  function destination() {
    const mode = $('backup-destination').value;
    return {
      parentId: mode === 'home' ? null : parentId,
      ...(mode === 'new' ? { newFolderName: $('backup-name').value } : {}),
    };
  }

  function showPreview(value) {
    preview = value;
    state = { groups: value.groups, containers: value.availableContainers };
    renderPicker();
    const path = [
      'Home',
      ...groupPath(state, value.destination.parentId).map((group) => group.name),
    ];
    if (value.destination.newFolderName) path.push(value.destination.newFolderName);
    $('backup-preview-destination').textContent = `Import into ${path.join(' / ')}`;
    $('backup-preview-counts').textContent =
      `${countFolders(value.createCount)} to create · ${countFolders(value.reuseCount)} to reuse${value.destination.newFolderName ? ' · 1 new destination folder' : ''}`;
    const rows = value.rows.map(({ name, existingId, depth }) => {
      const row = el('li');
      row.style.setProperty('--backup-depth', Math.min(depth, 8));
      const label = el('span', name);
      row.append(label, el('span', existingId ? 'Use existing' : 'Create', 'backup-folder-action'));
      return row;
    });
    $('backup-preview-tree').replaceChildren(...rows);
    $('backup-preview-tree').hidden = !rows.length;
    mappings.clear();
    const fields = $('backup-container-mappings');
    fields.replaceChildren();
    if (value.containers.length) {
      fields.append(el('h3', 'Default containers'));
      if (value.containerError) fields.append(el('p', value.containerError, 'setting-help'));
    }
    for (const saved of value.containers) {
      const wrapper = el('div', undefined, 'backup-container-mapping');
      const label = el('label', saved.name || 'Unavailable container');
      const select = el('select');
      select.id = `backup-container-${mappings.size}`;
      label.htmlFor = select.id;

      const option = (text, value) => {
        const node = el('option', text);
        node.value = value;
        select.append(node);
      };

      option('Choose a container…', '');
      for (const identity of value.availableContainers)
        option(identity.name, identity.cookieStoreId);
      if (saved.canCreate) option(`Create “${saved.name}”`, 'create');
      option('No container', 'none');
      select.value = saved.suggestedStore || '';
      select.addEventListener('change', () => setBusy(busy));
      mappings.set(saved.id, select);
      wrapper.append(label, select);
      if (!saved.canCreate && !saved.suggestedStore)
        wrapper.append(
          el(
            'p',
            'Choose an existing container or No container. This saved definition cannot be created in this Firefox installation.',
            'setting-help',
          ),
        );
      fields.append(wrapper);
    }
    $('backup-container-note').hidden = !value.containers.length;
    $('backup-preview').hidden = false;
    $('backup-preview-title').focus();
  }

  $('backup-export').addEventListener('click', async () => {
    setBusy(true);
    error();
    try {
      const value = await request('exportFolders');
      const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' });
      if (blob.size > MAX_BACKUP_BYTES)
        throw new Error('This folder backup exceeds the 5 MB import limit.');
      const url = URL.createObjectURL(blob);
      const link = el('a');
      link.href = url;
      link.download = `tabernacle-folders-${value.exportedAt.slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      $('backup-export-status').textContent =
        `Download started · ${countFolders(value.folders.length)}`;
    } catch (reason) {
      error(reason);
    } finally {
      setBusy(false);
    }
  });

  $('backup-file').addEventListener('change', async () => {
    invalidate();
    backup = null;
    $('backup-destination-fields').hidden = true;
    $('backup-file-status').textContent = 'Choose a JSON file exported by Tabernacle.';
    const file = $('backup-file').files[0];
    if (!file) return;
    const current = generation;
    try {
      if (file.size > MAX_BACKUP_BYTES)
        throw new Error('Choose a folder backup smaller than 5 MB.');
      const text = await file.text();
      if (current !== generation) return;
      const parsed = parseFolderBackup(text);
      backup = text;
      $('backup-file-status').textContent =
        `${countFolders(parsed.folders.length)} · Exported ${new Date(parsed.exportedAt).toLocaleDateString()}`;
      $('backup-destination-fields').hidden = false;
      renderPicker();
    } catch (reason) {
      if (current === generation) error(reason);
    }
  });
  $('backup-destination').addEventListener('change', () => {
    invalidate();
    renderPicker();
  });
  $('backup-name').addEventListener('input', invalidate);
  $('backup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !backup) return;
    invalidate();
    setBusy(true);
    try {
      showPreview(await request('previewFolderImport', { backup, destination: destination() }));
    } catch (reason) {
      error(reason);
    } finally {
      setBusy(false);
    }
  });
  $('backup-cancel').addEventListener('click', () => {
    invalidate();
    $('backup-preview-button').focus();
  });
  $('backup-import').addEventListener('click', async () => {
    if (busy || !preview) return;
    setBusy(true);
    error();
    try {
      const result = await request('importFolders', {
        token: preview.token,
        fingerprint: preview.fingerprint,
        destination: preview.destination,
        backup,
        containers: Object.fromEntries([...mappings].map(([id, select]) => [id, select.value])),
      });
      if (result.stale) {
        showPreview(result.preview);
        $('backup-status').textContent =
          'Folders or containers changed. Review the updated preview before importing.';
      } else {
        invalidate();
        $('backup-status').textContent =
          `Imported ${countFolders(result.createdFolders)} · Reused ${result.reusedFolders}${result.createdDestination ? ' · Created destination folder' : ''}${result.createdContainers ? ` · Created ${result.createdContainers} container${result.createdContainers === 1 ? '' : 's'}` : ''}`;
        $('backup-status').focus();
        state = await request('getFolderBackupState');
        renderPicker();
      }
    } catch (reason) {
      error(reason);
    } finally {
      setBusy(false);
    }
  });

  window.addEventListener('pagehide', () => picker?.destroy(), { once: true });
  return { refresh, isBusy: () => busy };
}
