import { createCollectionDialogs } from './collection-dialogs.js';
import { createFolderIndex } from './folder-index.js';
import { icon } from './icons.js';
import { groupById, groupContainer, isSavedForLater, tabSubtree } from './model.js';
import { createContainerManagement } from './container-dialogs.js';
import { populateContainerPicker } from './container-picker.js';
import { createGroupCreation } from './group-creation.js';
import { createAppearancePicker } from './appearance-picker.js';
import { folderContainer, folderIcon } from './folder-icons.js';
import { pinActionLabels } from './pinned-items.js';
import { createMovePicker } from './move-dialog.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Own modal state here; the sidebar owns the current snapshot and rendering.
export function createDialogs({
  getState,
  request,
  closeMenu,
  onChange,
  onMove,
  favicon,
  onNotice = () => {},
}) {
  let dialogAction, dialogContext, dialogCancel, dialogComplete, dialogCleanup;
  let dialogBusy = false;
  let disposed = false;
  let disabledControls;

  function showDialog({
    title,
    description = '',
    value = '',
    submit = 'Save',
    choices,
    input = true,
    compact = false,
    label = 'Folder name',
    cancel = 'Cancel',
    content,
    onSubmit,
    onCancel,
    afterSubmit,
    cleanup,
    onBack,
    backLabel = 'Back',
  }) {
    if (disposed) return;
    restoreControls(disabledControls);
    clearPickerHandlers();
    closeMenu();
    dialogCleanup?.();
    dialogCleanup = cleanup;
    dialogContext = Symbol();
    dialogBusy = false;
    $('dialog').classList.toggle('compact-container-dialog', compact);
    $('dialog').classList.remove(
      'folder-appearance-dialog',
      'picker-dialog',
      'move-dialog',
      'container-picker-dialog',
    );
    $('dialog').removeAttribute('aria-describedby');
    $('dialog-close').hidden = true;
    $('dialog-icon').replaceChildren(icon('groupPlus'));
    $('dialog-back').hidden = !onBack;
    $('dialog-back').replaceChildren(icon('back'), document.createTextNode(backLabel));
    $('dialog-back').onclick = onBack;
    $('dialog-options').hidden = true;
    $('dialog-options').replaceChildren();
    $('container-tools').hidden = true;
    $('container-picker-content').hidden = true;
    $('dialog-content').hidden = !content;
    $('dialog-content').replaceChildren(...(content ? [content] : []));
    $('dialog-title').textContent = title;
    $('dialog-description').textContent = description;
    $('dialog-description').hidden = !description;
    $('dialog-label').hidden = !input || Boolean(choices);
    $('dialog-label').textContent = label;
    $('dialog-input').hidden = !input || Boolean(choices);
    $('dialog-input').required = input && !choices;
    $('dialog-input').value = value;
    $('dialog-select').hidden = !choices;
    $('dialog-select').setAttribute('aria-label', 'Destination folder');
    $('dialog-select').replaceChildren();
    if (choices)
      choices.forEach((choice) => {
        const option = el('option', '', choice.label);
        option.value = choice.value;
        option.selected = choice.value === value;
        $('dialog-select').append(option);
      });
    $('dialog-submit').textContent = submit || '';
    $('dialog-submit').hidden = !submit;
    $('dialog-submit').disabled = !submit;
    $('dialog-cancel').disabled = false;
    $('dialog-cancel').textContent = cancel;
    $('dialog-cancel').hidden = !cancel;
    $('dialog-cancel').parentElement.hidden = !submit && !cancel;
    $('dialog-error').hidden = true;
    dialogAction = onSubmit;
    dialogCancel = onCancel;
    dialogComplete = afterSubmit;
    $('dialog').showModal();
    if (input && !choices) {
      $('dialog-input').focus();
      $('dialog-input').select();
    } else if (choices) $('dialog-select').focus();
    else if (submit) $('dialog-submit').focus();
    else $('dialog-back').focus();
    return dialogContext;
  }

  const collections = createCollectionDialogs({
    showDialog,
    getState,
    request,
    onChange,
    onNotice,
  });

  const { createContainerDialog, draftContainerDialog, manageContainersDialog } =
    createContainerManagement({
      showDialog,
      request,
      onChange,
      isCurrent: (context) => !disposed && dialogContext === context && $('dialog').open,
      canShow: () => !disposed,
    });

  const createDialog = createGroupCreation({
    getState,
    request,
    onChange,
    showDialog,
    draftContainerDialog,
    editAppearance,
    isCurrent: (context) => !disposed && dialogContext === context && $('dialog').open,
    canShow: () => !disposed,
  });

  function editAppearance({ group, container, onSubmit, onSave, onCancel }) {
    const state = getState();
    const picker = createAppearancePicker({ group, container, state });
    showDialog({
      title: 'Folder appearance',
      input: false,
      compact: true,
      content: picker.element,
      onCancel,

      afterSubmit: () => {
        if (!disposed) onSave?.(picker.getValue());
      },

      onSubmit: async () => {
        await onSubmit?.(picker.getValue());
      },
    });
    $('dialog').classList.add('folder-appearance-dialog');
    $('dialog-icon').replaceChildren(folderIcon(group, container, { state }));
    picker.focus();
  }

  function appearanceDialog(id) {
    const group = groupById(getState(), id);
    if (!group) return;
    editAppearance({
      group,
      container: folderContainer(getState(), group),

      onSubmit: async (appearance) => {
        onChange(await request('setGroupAppearance', { id, appearance }));
      },
    });
  }

  function pinFolderDialog(id) {
    const state = getState();
    const group = groupById(state, id);
    if (!group) return;
    const pin = state.folderPins.find((item) => item.id === id);
    showDialog({
      title: pin ? 'Change default action' : 'Pin folder',
      description: `Choose what happens when you click “${group.name}”.`,
      input: false,
      value: pin?.action ?? 'open',
      submit: pin ? 'Save' : 'Pin folder',
      choices: Object.entries(pinActionLabels).map(([value, label]) => ({ value, label })),
      onSubmit: async (action) => onChange(await request('setGroupPin', { id, action })),
    });
    $('dialog-select').setAttribute('aria-label', 'Default action');
    $('dialog-icon').replaceChildren(folderIcon(group, folderContainer(state, group), { state }));
  }

  function containerDialog(id, groupId) {
    const creating = id === undefined;
    return containerPicker({
      title: creating ? 'New tab in container' : 'Reopen in container',
      description: creating
        ? `Open a new tab in ${groupById(getState(), groupId)?.name || 'Home'} with the selected container’s sign-in.`
        : '',
      note: creating ? '' : 'Page history and unsaved changes won’t carry over.',
      submit: creating ? 'Create tab' : 'Reopen tab',

      onCancel: () => {
        const openingRow = creating
          ? $('new-tab')
          : document.querySelector(`[data-key="tab:${id}"]`);
        openingRow?.focus({ preventScroll: true });
      },

      load: async () => {
        const { containers, cookieStoreId } = await request('getContainers', { id });
        return {
          containers,
          selectedStore: creating
            ? (groupContainer(getState(), groupId) ?? containers[0]?.cookieStoreId ?? cookieStoreId)
            : cookieStoreId,
          currentStore: creating ? undefined : cookieStoreId,
        };
      },

      onSubmit: async (cookieStoreId) => {
        const next = await request(
          creating ? 'newTab' : 'reopenInContainer',
          creating ? { groupId, cookieStoreId } : { id, cookieStoreId },
        );
        onChange(next, `tab:${creating ? next.createdTabId : next.reopenedTabId}`);
      },
    });
  }

  function groupContainerDialog(groupId) {
    const group = groupById(getState(), groupId);
    return containerPicker({
      title: 'Default container',
      description: `New tabs created through Tabernacle in “${group.name}” use this container. Subfolders inherit this default.`,
      submit: 'Save',

      onCancel: () =>
        document
          .querySelector(`[data-key="group:${CSS.escape(groupId)}"]`)
          ?.focus({ preventScroll: true }),

      load: async () => {
        // Even with containers disabled, allow clearing a saved default.
        const { containers = [], warning } = await request('getContainers').catch((error) => ({
          warning: error.message,
        }));
        const current = groupById(getState(), groupId);
        if (!current) throw new Error('That folder no longer exists.');
        const inherited = groupContainer(getState(), current.parentId) ?? 'firefox-default';
        const name =
          inherited === 'firefox-default'
            ? 'No container'
            : containers.find((item) => item.cookieStoreId === inherited)?.name ||
              'Unavailable container';
        const selectedStore = current.defaultCookieStoreId ?? '';
        const unavailable =
          selectedStore &&
          selectedStore !== 'firefox-default' &&
          !containers.some((item) => item.cookieStoreId === selectedStore);
        return {
          containers,
          selectedStore,
          currentStore: selectedStore,
          inheritName: `Inherit (${name})`,
          warning:
            warning ||
            (unavailable ? 'The saved container is unavailable. Choose another default.' : ''),
        };
      },

      onSubmit: async (cookieStoreId) => {
        onChange(
          await request('setGroupContainer', { id: groupId, cookieStoreId: cookieStoreId || null }),
        );
      },
    });
  }

  async function containerPicker({ load, note = '', query = '', ...options }) {
    if (disposed) return;
    const context = showDialog({ ...options, input: false });
    $('dialog').classList.add('picker-dialog', 'container-picker-dialog');
    $('dialog-close').hidden = false;
    $('container-picker-content').hidden = false;
    $('container-tools').hidden = false;
    $('container-search').value = query;
    $('container-search').disabled = true;
    $('container-search-clear').hidden = true;
    $('container-search-status').textContent = '';
    $('container-picker-note').textContent = note;
    $('container-picker-note').hidden = !note;
    if (note) $('dialog').setAttribute('aria-describedby', 'container-picker-note');

    const resume = (cookieStoreId) => {
      const selectedStore =
        cookieStoreId ?? $('dialog-options').querySelector('input:checked')?.value;
      const savedQuery = cookieStoreId === undefined ? $('container-search').value : '';
      return () =>
        containerPicker({
          ...options,
          note,
          query: savedQuery,

          load: async () => {
            const data = await load();
            return { ...data, selectedStore: selectedStore ?? data.selectedStore };
          },
        });
    };

    $('create-container').onclick = () => {
      const back = resume();
      createContainerDialog((cookieStoreId) => (cookieStoreId ? resume(cookieStoreId)() : back()));
    };
    $('manage-containers').onclick = () => manageContainersDialog(resume());
    $('dialog-icon').replaceChildren(icon('container'));
    $('dialog-submit').disabled = true;
    const list = $('dialog-options');
    list.hidden = false;
    const loading = el('p', '', 'Loading containers…');
    loading.setAttribute('role', 'status');
    list.append(loading);
    $('dialog-cancel').focus();
    try {
      const { containers, selectedStore, currentStore, inheritName, warning } = await load();
      if (dialogContext !== context || !$('dialog').open) return;
      populateContainerPicker({
        containers,
        selectedStore,
        currentStore,
        inheritName,
        onSelect: (valid) => ($('dialog-submit').disabled = !valid),
      });
      if (warning) {
        $('dialog-error').textContent = warning;
        $('dialog-error').hidden = false;
      }
    } catch (error) {
      if (dialogContext !== context || !$('dialog').open) return;
      list.hidden = true;
      $('dialog-error').textContent = error.message;
      $('dialog-error').hidden = false;
    }
  }

  function newContainerDialog(groupId = getState().view.scopeId) {
    return containerDialog(undefined, groupId);
  }

  function renameDialog(id) {
    showDialog({
      title: 'Rename folder',
      value: groupById(getState(), id).name,

      onSubmit: async (name) => {
        onChange(await request('renameGroup', { id, name }));
      },
    });
  }

  async function removeDialog(id) {
    const group = groupById(getState(), id);
    if (!group) return;
    let contents;
    const context = showDialog({
      title: `Delete “${group.name}”?`,
      description: 'Counting tabs and subfolders across all Firefox windows…',
      input: false,
      submit: 'Delete folder',

      onSubmit: async () => {
        onChange(await request('removeGroup', { id, ...contents }));
      },
    });
    $('dialog-icon').replaceChildren(icon('trash'));
    $('dialog-submit').disabled = true;
    $('dialog-cancel').focus();
    try {
      contents = await request('getGroupContents', { id });
      if (dialogContext !== context || !$('dialog').open) return;
      const subgroups = contents.groupIds.length - 1;
      const tabs = contents.tabIds.length;
      const pinned = contents.pinnedCount;
      $('dialog-description').textContent =
        `Delete this folder${subgroups ? ` and its ${subgroups} ${subgroups === 1 ? 'subfolder' : 'subfolders'}` : ''}, and close ${tabs} ${tabs === 1 ? 'tab' : 'tabs'} across all Firefox windows.${pinned ? ` This includes ${pinned} pinned ${pinned === 1 ? 'tab' : 'tabs'}.` : ''}`;
      $('dialog-submit').disabled = false;
    } catch (error) {
      if (dialogContext !== context || !$('dialog').open) return;
      $('dialog-error').textContent = error.message;
      $('dialog-error').hidden = false;
    }
  }

  function closeGroupTabsDialog(id) {
    const state = getState();
    const group = groupById(state, id);
    if (!group) return;
    const folders = createFolderIndex(state);
    const tabs = state.tabs.filter(
      (tab) => !isSavedForLater(tab) && folders.isWithin(tab.groupId, id),
    );
    const pinned = tabs.filter((tab) => tab.pinned).length;
    const count = `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`;
    showDialog({
      title: `Close all tabs in “${group.name}”?`,
      description: `Close ${count} in this folder and its subfolders in this window.${pinned ? ` This includes ${pinned} pinned ${pinned === 1 ? 'tab' : 'tabs'}.` : ''} The folders will stay.`,
      input: false,
      submit: `Close ${count}`,

      onSubmit: async () => {
        onChange(await request('closeGroupTabs', { id, tabIds: tabs.map((tab) => tab.id) }));
      },
    });
    $('dialog-icon').replaceChildren(icon('close'));
    $('dialog-submit').disabled = tabs.length === 0;
    $('dialog-cancel').focus();
  }

  function closeTabTreeDialog(id) {
    const tabs = tabSubtree(getState().tabs, id);
    if (!tabs.length) return;
    const nested = tabs.length - 1;
    const pinned = tabs.filter((tab) => tab.pinned).length;
    showDialog({
      title: 'Close tab and nested tabs?',
      description: `“${tabs[0].title || 'New tab'}” and its ${nested} nested ${nested === 1 ? 'tab' : 'tabs'} will close.${pinned ? ` This includes ${pinned} pinned ${pinned === 1 ? 'tab' : 'tabs'}.` : ''}`,
      input: false,
      submit: `Close ${tabs.length} tabs`,

      onSubmit: async () => {
        onChange(await request('closeTabTree', { id, tabIds: tabs.map((tab) => tab.id) }));
      },
    });
    $('dialog-icon').replaceChildren(icon('close'));
    $('dialog-cancel').focus();
  }

  function moveDialog(kind, id) {
    if (kind !== 'contents') {
      const picker = createMovePicker(getState, kind, id, { favicon });
      let operationId = crypto.randomUUID();
      let message;
      const openingRow = document.querySelector(`[data-key="${kind}:${CSS.escape(String(id))}"]`);
      picker.node.addEventListener('destinationchange', () => {
        message = undefined;
        operationId = crypto.randomUUID();
        $('dialog-submit').disabled = !picker.valid();
        $('dialog-error').textContent = picker.error() || '';
        $('dialog-error').hidden = !picker.error();
      });
      showDialog({
        title: kind === 'tab' ? 'Move tab' : 'Move folder',
        input: false,
        content: picker.node,
        submit: 'Move',

        onSubmit: async () => {
          // Keep an identical request on retry when the response was lost.
          if (!message) {
            const plan = picker.plan();
            message = {
              operationId,
              source: plan.source,
              expected: plan.expected,
              destination: picker.intent(),
            };
          }
          const next = await request('moveItem', message);
          onChange(next);
          return next;
        },

        afterSubmit: (next) => {
          if (!disposed) onMove?.(next);
        },

        onCancel: () => openingRow?.isConnected && openingRow.focus({ preventScroll: true }),
      });
      $('dialog').classList.add('picker-dialog', 'move-dialog');
      $('dialog').setAttribute('aria-describedby', 'move-source');
      $('dialog-close').hidden = false;
      $('dialog-submit').disabled = !picker.valid();
      picker.focus();
      return;
    }
    const state = getState();
    const folders = createFolderIndex(state);
    const current =
      kind !== 'tab'
        ? folders.byId.get(id).parentId
        : state.tabs.find((tab) => tab.id === id).groupId;
    const choices = [{ value: '', label: 'Home' }];
    const pending = [{ parentId: null, depth: 0 }];
    while (pending.length) {
      const { parentId, depth, group } = pending.pop();
      if (group) {
        if (kind !== 'tab' && folders.isWithin(group.id, id)) continue;
        choices.push({ value: group.id, label: `${'　'.repeat(depth)}${group.name}` });
      }
      const nested = folders.children.get(group ? group.id : parentId) || [];
      for (let i = nested.length - 1; i >= 0; i--)
        pending.push({ group: nested[i], depth: group ? depth + 1 : depth });
    }
    showDialog({
      title:
        kind === 'contents'
          ? 'Move folder contents'
          : kind === 'group'
            ? 'Move folder'
            : 'Move tab',
      description:
        kind === 'contents'
          ? `Move all tabs and subfolders in “${groupById(getState(), id).name}” into the destination, across all Firefox windows. Subfolders keep their contents and this folder stays empty.`
          : kind === 'tab'
            ? 'The tab and its children will move together.'
            : 'Choose a destination.',
      choices,
      value: current ?? '',
      submit: 'Move',

      onSubmit: async (value) => {
        const next = await request(
          kind === 'contents' ? 'moveGroupContents' : kind === 'group' ? 'moveGroup' : 'moveTab',
          kind === 'group' ? { id, parentId: value || null } : { id, groupId: value || null },
        );
        onChange(next);
      },
    });
  }

  function restoreControls(owner) {
    if (!owner || owner !== disabledControls) return;
    disabledControls = undefined;
    if (!disposed) for (const { node, disabled } of owner) node.disabled = disabled;
  }

  function clearPickerHandlers() {
    $('container-search').oninput = null;
    $('container-search').onkeydown = null;
    $('dialog-options').onkeydown = null;
    for (const id of ['container-search-clear', 'create-container', 'manage-containers'])
      $(id).onclick = null;
  }

  function releaseDialog() {
    restoreControls(disabledControls);
    const cleanup = dialogCleanup;
    dialogAction = dialogCancel = dialogComplete = dialogCleanup = dialogContext = undefined;
    dialogBusy = false;
    $('dialog-back').onclick = null;
    clearPickerHandlers();
    for (const id of ['dialog-content', 'dialog-options', 'dialog-select']) $(id).replaceChildren();
    cleanup?.();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    releaseDialog();
  }

  window.addEventListener('pagehide', dispose, { once: true });

  function cancelDialog() {
    if (disposed || dialogBusy) return;
    const back = dialogCancel;
    $('dialog').close();
    back?.();
  }

  $('dialog-cancel').addEventListener('click', cancelDialog);
  $('dialog-close').replaceChildren(icon('close'));
  $('dialog-close').addEventListener('click', cancelDialog);
  $('dialog').addEventListener('close', () => {
    // A cancel callback can immediately reopen this shared dialog for another step.
    if (!$('dialog').open) releaseDialog();
  });
  $('dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    cancelDialog();
  });
  $('dialog-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (disposed || dialogBusy || $('dialog-submit').disabled) return;
    const container = $('dialog-options').querySelector('input:checked');
    const value = $('dialog-options').hidden
      ? $('dialog-select').hidden
        ? $('dialog-input').value
        : $('dialog-select').value
      : container?.value;
    dialogBusy = true;
    const controls = [...$('dialog-form').querySelectorAll('button, input, select')].map(
      (node) => ({ node, disabled: node.disabled }),
    );
    disabledControls = controls;
    for (const { node } of controls) node.disabled = true;
    const complete = dialogComplete;
    const context = dialogContext;
    const current = () => !disposed && dialogContext === context;
    let result,
      succeeded = false;
    $('dialog-error').hidden = true;
    try {
      result = await dialogAction(value);
      succeeded = true;
      if (current()) $('dialog').close();
    } catch (error) {
      if (current()) {
        $('dialog-error').textContent = error.message;
        $('dialog-error').hidden = false;
      }
    } finally {
      restoreControls(controls);
      if (current()) dialogBusy = false;
    }
    if (succeeded) complete?.(result);
  });

  return {
    ...collections,
    createDialog,
    renameDialog,
    appearanceDialog,
    pinFolderDialog,
    removeDialog,
    closeGroupTabsDialog,
    closeTabTreeDialog,
    moveDialog,
    containerDialog,
    newContainerDialog,
    groupContainerDialog,
    createContainerDialog,
    manageContainersDialog,
  };
}
