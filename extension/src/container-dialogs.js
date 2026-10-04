import { icon } from './icons.js';
import { containerIconUrl, sortContainers } from './containers.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(error) {
  $('dialog-error').textContent = error.message;
  $('dialog-error').hidden = false;
}

export function containerListIcon(identity) {
  const node = el('span', 'container-list-icon');
  node.setAttribute('aria-hidden', 'true');
  if (identity.colorCode && CSS.supports('color', identity.colorCode))
    node.style.color = identity.colorCode;
  const url = containerIconUrl(identity);
  if (url) {
    node.classList.add('container-list-icon-mask');
    node.style.maskImage = `url("${url}")`;
  } else node.append(icon('container'));
  return node;
}

function visualChoices(key, title, choices, current) {
  const field = el('fieldset', 'container-choice-field');
  field.append(el('legend', '', title));
  const grid = el('div', 'container-choice-grid');
  const aliases = { toolbar: 'gray', turquoise: 'cyan' };
  const selected = [current, aliases[current], choices[0]?.[key]].find((value) =>
    choices.some((choice) => choice[key] === value),
  );
  for (const choice of choices) {
    const value = choice[key];
    const name = value === 'toolbar' ? 'Toolbar colour' : value[0].toUpperCase() + value.slice(1);
    const label = el('label', 'container-choice');
    label.title = name;
    const radio = el('input');
    radio.type = 'radio';
    radio.name = `container-${key}`;
    radio.value = value;
    radio.checked = value === selected;
    radio.required = true;
    radio.setAttribute('aria-label', name);
    const tile = el('span', 'container-choice-tile');
    tile.setAttribute('aria-hidden', 'true');
    const preview = el('span', `container-choice-${key}`);
    if (key === 'color') preview.style.backgroundColor = choice.colorCode;
    else preview.style.maskImage = `url("${containerIconUrl(choice)}")`;
    tile.append(preview);
    label.append(radio, tile);
    grid.append(label);
  }
  field.append(grid);
  return field;
}

export function createContainerManagement({ showDialog, request, onChange, isCurrent }) {
  async function editContainerDialog(identity, back, { draft, onBack, onCancel } = {}) {
    const fields = el('div', 'container-fields');
    const current = identity ?? draft;
    let choices;
    const context = showDialog({
      title: identity ? 'Edit container' : 'New container',
      description: draft
        ? 'Available throughout Firefox. Created when you save the group.'
        : 'Use this container throughout Firefox.',
      label: 'Container name',
      value: current?.name || '',
      submit: draft ? 'Use this container' : identity ? 'Save' : 'Create container',
      content: fields,
      onCancel: onCancel ?? (() => back?.()),
      onBack,
      backLabel: 'Back to containers',
      afterSubmit: (cookieStoreId) => back?.(cookieStoreId),

      onSubmit: async (name) => {
        const details = {
          name: name.trim(),
          color: fields.querySelector('[name="container-color"]:checked').value,
          icon: fields.querySelector('[name="container-icon"]:checked').value,
        };
        if (!details.name) throw new Error('Enter a container name.');
        if (draft)
          return {
            ...details,
            colorCode: choices.colors.find((item) => item.color === details.color)?.colorCode,
            iconUrl: choices.icons.find((item) => item.icon === details.icon)?.iconUrl,
          };
        const next = await request(identity ? 'updateContainer' : 'createContainer', {
          cookieStoreId: identity?.cookieStoreId,
          ...details,
        });
        onChange(next);
        return next.createdCookieStoreId;
      },
    });
    $('dialog-icon').replaceChildren(icon('container'));
    $('dialog-submit').disabled = true;
    try {
      choices = await request('getContainerChoices');
      const { colors, icons } = choices;
      if (!isCurrent(context)) return;
      fields.append(
        visualChoices('color', 'Colour', colors, current?.color || 'blue'),
        visualChoices('icon', 'Icon', icons, current?.icon || 'fingerprint'),
      );

      const updateIconColor = () => {
        const selected = fields.querySelector('[name="container-color"]:checked').value;
        const color = colors.find((choice) => choice.color === selected);
        fields.style.setProperty('--container-icon-color', color?.colorCode || 'currentColor');
      };

      fields.addEventListener('change', updateIconColor);
      updateIconColor();
      $('dialog-submit').disabled = false;
    } catch (error) {
      if (isCurrent(context)) showError(error);
    }
  }

  function removeContainerDialog(identity, back) {
    showDialog({
      title: `Remove “${identity.name}”?`,
      description:
        'This deletes the container and its cookies and site data from Firefox. Close its tabs in all windows first. Groups using it will need a new default container. This cannot be undone.',
      input: false,
      submit: 'Remove container',
      onCancel: back,
      afterSubmit: back,

      onSubmit: async () => {
        onChange(await request('removeContainer', { cookieStoreId: identity.cookieStoreId }));
      },
    });
    $('dialog-icon').replaceChildren(icon('trash'));
    $('dialog-cancel').focus();
  }

  async function manageContainersDialog(back) {
    const list = el('div', 'container-management-list');
    const loading = el('p', '', 'Loading containers…');
    loading.setAttribute('role', 'status');
    list.append(loading);
    const resume = () => manageContainersDialog(back);
    const context = showDialog({
      title: 'Manage containers',
      description: 'Changes apply throughout Firefox.',
      input: false,
      compact: true,
      content: list,
      submit: 'New container…',
      cancel: 'Done',
      onCancel: back,

      onSubmit: async () => {},

      afterSubmit: () => editContainerDialog(null, resume),
    });
    $('dialog-icon').replaceChildren(icon('container'));
    try {
      const { containers } = await request('getContainers');
      if (!isCurrent(context)) return;
      list.replaceChildren();
      if (!containers.length)
        list.append(el('p', 'container-empty', 'No containers are configured in Firefox.'));
      for (const identity of sortContainers(containers)) {
        const row = el('div', 'container-management-row');
        const name = el('span', 'container-name', identity.name);
        name.title = identity.name;
        row.append(containerListIcon(identity), name);
        for (const [label, iconName, run] of [
          ['Edit', 'rename', () => editContainerDialog(identity, resume)],
          ['Remove', 'trash', () => removeContainerDialog(identity, resume)],
        ]) {
          const button = el('button', 'icon-button');
          button.type = 'button';
          button.title = `${label} ${identity.name}`;
          button.setAttribute('aria-label', button.title);
          button.append(icon(iconName));
          button.addEventListener('click', run);
          row.append(button);
        }
        list.append(row);
      }
    } catch (error) {
      if (!isCurrent(context)) return;
      list.replaceChildren();
      showError(error);
    }
  }

  return {
    createContainerDialog: (back) => editContainerDialog(null, back),
    draftContainerDialog: (draft, { onSubmit, onBack, onCancel }) =>
      editContainerDialog(null, onSubmit, { draft, onBack, onCancel }),
    manageContainersDialog,
  };
}
