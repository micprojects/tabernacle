import { icon } from './icons.js';
import { groupById, groupContainer } from './model.js';
import { containerListIcon } from './container-dialogs.js';
import { sortContainers } from './containers.js';
import { createFolderPicker } from './folder-picker.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The group and container stay local drafts while the shared dialog changes steps.
export function createGroupCreation({
  getState,
  request,
  onChange,
  showDialog,
  draftContainerDialog,
  isCurrent,
}) {
  return function createDialog(parentId = getState().view.scopeId) {
    const draft = { id: crypto.randomUUID(), name: '', parentId, selection: null, container: null };
    let identities = getState().containers ?? [];

    function identityFor(cookieStoreId) {
      return cookieStoreId === 'firefox-default'
        ? { name: 'No container' }
        : (identities.find((item) => item.cookieStoreId === cookieStoreId) ?? {
            name: 'Unavailable container',
          });
    }

    function inherited() {
      return identityFor(groupContainer(getState(), draft.parentId) ?? 'firefox-default');
    }

    function showGroup(restoreFocus = false) {
      const content = el('div');
      const field = el('div', 'group-container-field');
      const label = el('span', 'group-container-label', 'Default container');
      label.id = 'group-container-label';
      const summary = el('div', 'group-container-summary');
      summary.setAttribute('role', 'group');
      summary.setAttribute('aria-labelledby', label.id);
      const details = el('div', 'group-container-details');
      details.setAttribute('aria-live', 'polite');
      const change = el('button', 'group-container-change', 'Change');
      change.id = 'change-group-container';
      change.type = 'button';
      change.setAttribute('aria-label', 'Change default container');
      change.append(icon('chevron'));
      const help = el(
        'p',
        'group-container-help',
        'New tabs created here through Tabernacle use this container.',
      );
      field.append(label, summary, help);

      function updateSummary() {
        const identity =
          draft.selection === 'new'
            ? draft.container
            : draft.selection === null
              ? inherited()
              : identityFor(draft.selection);
        const note =
          draft.selection === 'new'
            ? 'New container · ready to create'
            : draft.selection === null
              ? `Inherited from ${groupById(getState(), draft.parentId)?.name ?? 'Home'}`
              : draft.selection === 'firefox-default'
                ? 'Regular Firefox browsing'
                : 'Existing Firefox container';
        const name = el('span', 'container-name', identity.name);
        name.title = identity.name;
        details.replaceChildren(name, el('span', 'group-container-note', note));
        summary.replaceChildren(containerListIcon(identity), details, change);
      }

      const destination = createFolderPicker({
        getState,
        parentId: draft.parentId,
        dialog: $('dialog'),

        onChange: (id) => {
          draft.parentId = id;
          updateSummary();
        },
      });
      content.append(destination.element, field);
      change.addEventListener('click', () => {
        draft.name = $('dialog-input').value;
        showPicker();
      });
      showDialog({
        title: 'A new place for your tabs',
        description: 'Give your tabs a place to belong.',
        value: draft.name,
        submit: 'Create group',
        content,
        cleanup: destination.destroy,

        onSubmit: async (name) => {
          draft.name = name;
          const data = await request('createGroup', {
            id: draft.id,
            name,
            parentId: draft.parentId,
            ...(draft.selection === 'new'
              ? { newContainer: draft.container }
              : { cookieStoreId: draft.selection }),
          });
          onChange(data, `group:${data.createdGroupId}`);
        },
      });
      updateSummary();
      if (restoreFocus) change.focus();
    }

    function showEditor() {
      draftContainerDialog(draft.container ?? { name: draft.name.trim() }, {
        onSubmit: (container) => {
          draft.container = container;
          draft.selection = 'new';
          showGroup(true);
        },

        onBack: showPicker,
        onCancel: () => showGroup(true),
      });
    }

    async function showPicker() {
      const content = el('div');
      const list = el('div', 'group-container-list');
      const loading = el('p', '', 'Loading containers…');
      loading.setAttribute('role', 'status');
      list.append(loading);
      const create = el(
        'button',
        'group-container-create',
        draft.container ? 'Edit new container…' : 'Create new container…',
      );
      create.type = 'button';
      create.prepend(icon('plus'));
      create.disabled = true;
      create.addEventListener('click', showEditor);
      content.append(list, create);
      const context = showDialog({
        title: 'Default container',
        description: 'Choose where new tabs will open.',
        input: false,
        compact: true,
        submit: false,
        cancel: '',
        content,
        onBack: () => showGroup(true),
        backLabel: 'Back to group',
        onCancel: () => showGroup(true),
      });
      $('dialog-icon').replaceChildren(icon('container'));
      const { containers = [], warning } = await request('getContainers').catch((error) => ({
        warning: error.message,
      }));
      if (!isCurrent(context)) return;
      identities = containers;
      list.replaceChildren();
      const choices = [
        { value: null, ...inherited(), name: `Inherit (${inherited().name})` },
        { value: 'firefox-default', name: 'No container' },
        ...sortContainers(containers).map((identity) => ({
          ...identity,
          value: identity.cookieStoreId,
        })),
        ...(draft.container
          ? [{ ...draft.container, value: 'new', name: `${draft.container.name} (new)` }]
          : []),
      ];
      for (const choice of choices) {
        const button = el('button', 'group-container-choice');
        button.type = 'button';
        button.title = choice.name;
        button.setAttribute('aria-pressed', String(choice.value === draft.selection));
        button.append(
          containerListIcon(choice),
          el('span', 'container-name', choice.name),
          icon('check', 'group-container-check'),
        );
        button.addEventListener('click', () => {
          draft.selection = choice.value;
          showGroup(true);
        });
        list.append(button);
      }
      create.disabled = Boolean(warning);
      if (warning) {
        $('dialog-error').textContent = warning;
        $('dialog-error').hidden = false;
      }
      // Do not steal focus if the user moved to Back while the list was loading.
      if (document.activeElement === $('dialog-back')) {
        const selected =
          list.querySelector('[aria-pressed="true"]') ?? list.querySelector('button');
        selected.focus();
        selected.scrollIntoView({ block: 'nearest' });
      }
    }

    showGroup();
  };
}
