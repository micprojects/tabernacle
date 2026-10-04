import { icon } from './icons.js';
import { children, groupById, groupContainer, isWithin, tabSubtree } from './model.js';
import { containerListIcon, createContainerManagement } from './container-dialogs.js';
import { sortContainers } from './containers.js';
import { normalizeLook } from './look.js';
import { createGroupCreation } from './group-creation.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Own modal state here; the sidebar owns the current snapshot and rendering.
export function createDialogs({ getState, request, closeMenu, onChange }) {
  let dialogAction, dialogContext, dialogCancel, dialogComplete, dialogCleanup;
  let dialogBusy = false;

  function showDialog({
    title,
    description = '',
    value = '',
    submit = 'Save',
    choices,
    input = true,
    compact = false,
    label = 'Group name',
    cancel = 'Cancel',
    content,
    onSubmit,
    onCancel,
    afterSubmit,
    cleanup,
    onBack,
    backLabel = 'Back',
  }) {
    closeMenu();
    dialogCleanup?.();
    dialogCleanup = cleanup;
    dialogContext = Symbol();
    dialogBusy = false;
    $('dialog').classList.toggle('compact-container-dialog', compact);
    $('dialog-icon').replaceChildren(icon('groupPlus'));
    $('dialog-back').hidden = !onBack;
    $('dialog-back').textContent = `← ${backLabel}`;
    $('dialog-back').onclick = onBack;
    $('dialog-options').hidden = true;
    $('dialog-options').replaceChildren();
    $('container-tools').hidden = true;
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
    $('dialog-select').setAttribute('aria-label', 'Destination group');
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

  const { createContainerDialog, draftContainerDialog, manageContainersDialog } =
    createContainerManagement({
      showDialog,
      request,
      onChange,
      isCurrent: (context) => dialogContext === context && $('dialog').open,
    });

  const createDialog = createGroupCreation({
    getState,
    request,
    onChange,
    showDialog,
    draftContainerDialog,
    isCurrent: (context) => dialogContext === context && $('dialog').open,
  });

  function aboutDialog(manifest) {
    const content = el('dl', 'about-details');
    const website = new URL(manifest.homepage_url);
    for (const [label, text, href] of [
      ['Website', website.host + website.pathname.replace(/\/$/, ''), website.href],
      [
        'Source code',
        'github.com/micprojects/tabernacle',
        'https://github.com/micprojects/tabernacle',
      ],
      ['Contact email', 'tabernacle@michaelprojects.com', 'mailto:tabernacle@michaelprojects.com'],
      ['Made by', manifest.author, 'https://michaelprojects.com'],
    ]) {
      const detail = el('dd');
      const link = el('a', '', text);
      link.href = href;
      if (href.startsWith('https:')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      detail.append(link);
      content.append(el('dt', '', label), detail);
    }
    showDialog({
      title: `About ${manifest.name}`,
      description: `Version ${manifest.version}`,
      input: false,
      submit: 'Close',
      cancel: '',
      content,

      onSubmit: () => {},

      afterSubmit: () => $('more').focus(),
      onCancel: () => $('more').focus(),
    });
    const logo = el('img');
    logo.src = new URL('../icons/tabernacle-toolbar-full.svg', import.meta.url).href;
    logo.alt = '';
    logo.width = 48;
    logo.height = 48;
    $('dialog-icon').replaceChildren(logo);
  }

  function lookDialog() {
    const look = normalizeLook(getState().look);
    const content = el('div', 'look-options');
    const mode = el('select');
    mode.id = 'look-color-scheme';
    mode.setAttribute('aria-describedby', 'look-color-scheme-help');
    for (const [value, text] of [
      ['default', 'Default'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ]) {
      const option = el('option', '', text);
      option.value = value;
      option.selected = look.colorScheme === value;
      mode.append(option);
    }
    const modeField = el('div', 'look-color-scheme');
    const modeLabel = el('label', '', 'Colour mode');
    modeLabel.htmlFor = mode.id;
    const modeHelp = el('p', 'look-help', 'Default follows Firefox’s light/dark preference.');
    modeHelp.id = 'look-color-scheme-help';
    modeField.append(modeLabel, mode, modeHelp);
    content.append(modeField);
    const controls = {};
    for (const [key, text] of [
      ['connectingLines', 'Show connecting lines'],
      ['domains', 'Show the domain as a second line'],
    ]) {
      const label = el('label', 'look-option');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = look[key];
      controls[key] = checkbox;
      label.append(checkbox, el('span', '', text));
      content.append(label);
    }
    showDialog({
      title: 'Appearance',
      description: 'Choose your colours and tab list details.',
      input: false,
      content,

      onSubmit: async () => {
        const value = Object.fromEntries(
          Object.entries(controls).map(([key, checkbox]) => [key, checkbox.checked]),
        );
        value.colorScheme = mode.value;
        onChange(await request('setLook', { value }));
      },
    });
    $('dialog-icon').replaceChildren(icon('list'));
    mode.focus();
  }

  function containerDialog(id, groupId) {
    const creating = id === undefined;
    return containerPicker({
      title: creating ? 'New tab in container' : 'Reopen in container',
      description: creating
        ? `Open a new tab in ${groupById(getState(), groupId)?.name || 'Home'} with the selected container’s sign-in.`
        : 'Reopens this page with the selected container’s sign-in. Page history and unsaved changes won’t carry over.',
      submit: creating ? 'Create tab' : 'Reopen tab',

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
      description: `New tabs created through Tabernacle in “${group.name}” use this container. Subgroups inherit this default.`,
      submit: 'Save',

      load: async () => {
        // Even with containers disabled, allow clearing a saved default.
        const { containers = [], warning } = await request('getContainers').catch((error) => ({
          warning: error.message,
        }));
        const current = groupById(getState(), groupId);
        if (!current) throw new Error('That group no longer exists.');
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

  async function containerPicker({ load, ...options }) {
    const context = showDialog({ ...options, input: false, compact: true });
    $('container-tools').hidden = false;

    const resume = (cookieStoreId) => {
      const selectedStore =
        cookieStoreId ?? $('dialog-options').querySelector('input:checked')?.value;
      return () =>
        containerPicker({
          ...options,

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
      list.replaceChildren();
      for (const container of [
        ...(inheritName ? [{ cookieStoreId: '', name: inheritName }] : []),
        { cookieStoreId: 'firefox-default', name: 'No container' },
        ...sortContainers(containers),
      ]) {
        const label = el('label', 'container-option');
        const radio = el('input');
        radio.type = 'radio';
        radio.name = 'container';
        radio.value = container.cookieStoreId;
        radio.checked = container.cookieStoreId === selectedStore;
        radio.dataset.current = String(container.cookieStoreId === currentStore);
        radio.addEventListener('change', () => {
          $('dialog-submit').disabled = radio.dataset.current === 'true';
        });
        const name = el('span', 'container-name', container.name);
        label.title = container.name;
        label.append(radio, containerListIcon(container), name);
        if (radio.dataset.current === 'true')
          label.append(el('span', 'container-current', 'Current'));
        label.append(icon('check', 'container-check'));
        list.append(label);
      }
      if (!containers.length)
        list.append(el('p', 'container-empty', 'No containers are configured in Firefox.'));
      if (warning) {
        $('dialog-error').textContent = warning;
        $('dialog-error').hidden = false;
      }
      const checked = list.querySelector('input:checked');
      const current = checked || list.querySelector('input');
      $('dialog-submit').disabled = !checked || checked.dataset.current === 'true';
      current.focus();
      current.scrollIntoView({ block: 'nearest' });
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
      title: 'Rename group',
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
      description: 'Counting tabs and subgroups across all Firefox windows…',
      input: false,
      submit: 'Delete group',

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
        `Delete this group${subgroups ? ` and its ${subgroups} ${subgroups === 1 ? 'subgroup' : 'subgroups'}` : ''}, and close ${tabs} ${tabs === 1 ? 'tab' : 'tabs'} across all Firefox windows.${pinned ? ` This includes ${pinned} pinned ${pinned === 1 ? 'tab' : 'tabs'}.` : ''}`;
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
    const tabs = state.tabs.filter((tab) => isWithin(state, tab.groupId, id));
    const pinned = tabs.filter((tab) => tab.pinned).length;
    const count = `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`;
    showDialog({
      title: `Close all tabs in “${group.name}”?`,
      description: `Close ${count} in this group and its subgroups in this window.${pinned ? ` This includes ${pinned} pinned ${pinned === 1 ? 'tab' : 'tabs'}.` : ''} The groups will stay.`,
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
    const current =
      kind !== 'tab'
        ? groupById(getState(), id).parentId
        : getState().tabs.find((tab) => tab.id === id).groupId;
    const choices = [{ value: '', label: 'Home' }];

    function walk(parentId, depth) {
      for (const group of children(getState(), parentId)) {
        if (kind !== 'tab' && isWithin(getState(), group.id, id)) continue;
        choices.push({
          value: group.id,
          label: `${'　'.repeat(depth)}${group.name}`,
        });
        walk(group.id, depth + 1);
      }
    }

    walk(null, 0);
    showDialog({
      title:
        kind === 'contents' ? 'Move group contents' : kind === 'group' ? 'Move group' : 'Move tab',
      description:
        kind === 'contents'
          ? `Move all tabs and subgroups in “${groupById(getState(), id).name}” into the destination, across all Firefox windows. Subgroups keep their contents and this group stays empty.`
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

  function cancelDialog() {
    if (dialogBusy) return;
    const back = dialogCancel;
    $('dialog').close();
    back?.();
  }

  $('dialog-cancel').addEventListener('click', cancelDialog);
  $('dialog').addEventListener('close', () => {
    // A cancel callback can immediately reopen this shared dialog for another step.
    if (!$('dialog').open) {
      dialogCleanup?.();
      dialogCleanup = undefined;
    }
  });
  $('dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    cancelDialog();
  });
  $('dialog-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (dialogBusy || $('dialog-submit').disabled) return;
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
    for (const { node } of controls) node.disabled = true;
    const complete = dialogComplete;
    let result,
      succeeded = false;
    $('dialog-error').hidden = true;
    try {
      result = await dialogAction(value);
      succeeded = true;
      $('dialog').close();
    } catch (error) {
      $('dialog-error').textContent = error.message;
      $('dialog-error').hidden = false;
    } finally {
      dialogBusy = false;
      for (const { node, disabled } of controls) node.disabled = disabled;
    }
    if (succeeded) complete?.(result);
  });

  return {
    createDialog,
    renameDialog,
    removeDialog,
    closeGroupTabsDialog,
    closeTabTreeDialog,
    moveDialog,
    containerDialog,
    newContainerDialog,
    groupContainerDialog,
    createContainerDialog,
    manageContainersDialog,
    lookDialog,
    aboutDialog,
  };
}
