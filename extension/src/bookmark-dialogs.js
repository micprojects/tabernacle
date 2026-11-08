import {
  bookmarkEditable,
  bookmarkMove,
  bookmarkRecord,
  bookmarkSubtree,
} from './bookmark-edit.js';
import { createSidebarControls } from './sidebar/controls.js';
import { icon } from './icons.js';

export function createBookmarkDialogs({
  getIndex,
  getState,
  request,
  showDialog,
  menu,
  refresh,
  reveal,
  announce,
}) {
  const { el, button } = createSidebarControls();

  function field(content, label, value = '', tag = 'input') {
    const wrapper = el('label', 'bookmark-field', label);
    const input = el(tag);
    input.setAttribute('aria-label', label);
    if (tag === 'input') {
      input.value = value;
      input.required = true;
    }
    wrapper.append(input);
    content.append(wrapper);
    return input;
  }

  // A failed submit keeps its operation ID. Changing the draft starts a new
  // operation; unfinished work remains available from the Bookmarks menu.
  function submitter() {
    let previous, operationId;
    return async (command) => {
      const serialized = JSON.stringify(command);
      if (serialized !== previous) {
        previous = serialized;
        operationId = crypto.randomUUID();
      }
      try {
        return await request('editBookmark', { operationId, command });
      } finally {
        await refresh();
      }
    };
  }

  function show(options, focus) {
    showDialog({
      input: false,
      compact: true,
      onCancel: () => reveal(options.restoreId),
      ...options,
    });
    document.getElementById('dialog-icon').replaceChildren(icon('bookmark'));
    focus?.focus();
    focus?.select?.();
  }

  function folders(index, exclude) {
    const result = [];
    const stack = (index.byId.get(index.rootId).children || [])
      .map((node) => ({ node, path: '' }))
      .reverse();
    while (stack.length) {
      const { node, path } = stack.pop();
      if (node.id === exclude || node.type !== 'folder' || node.unmodifiable) continue;
      const label = path ? `${path} / ${node.title}` : node.title;
      result.push({ node, label });
      for (const child of [...(node.children || [])].reverse())
        stack.push({ node: child, path: label });
    }
    return result;
  }

  function destination(content, index, value, exclude) {
    const select = field(content, 'Bookmark folder', '', 'select');
    for (const { node, label } of folders(index, exclude)) {
      const option = el('option', '', label);
      option.value = node.id;
      select.append(option);
    }
    select.value = value;
    if (!select.value) select.selectedIndex = 0;
    return select;
  }

  function edit(id) {
    const node = getIndex()?.byId.get(id);
    if (!node) return announce('That bookmark is no longer available.', true);
    const content = el('div');
    const name = field(content, 'Name', node.title);
    const address = node.type === 'bookmark' ? field(content, 'Address', node.url) : null;
    const submit = submitter();
    show(
      {
        title: address ? 'Edit bookmark' : 'Rename bookmark folder',
        content,
        restoreId: id,
        onSubmit: () =>
          submit({
            kind: 'update',
            id,
            expected: bookmarkRecord(node),
            title: name.value,
            ...(address ? { url: address.value } : {}),
          }),
        afterSubmit: () => reveal(id),
      },
      name,
    );
  }

  function create(type, parentId) {
    const index = getIndex();
    if (!index) return announce('Reload your bookmarks before creating an item.', true);
    const content = el('div');
    const tab = getState().tabs.find((tab) => tab.active);
    const name = field(content, 'Name', type === 'bookmark' ? tab?.title || '' : '');
    const address = type === 'bookmark' ? field(content, 'Address', tab?.url || '') : null;
    const parent = destination(content, index, parentId);
    const submit = submitter();
    show(
      {
        title: address ? 'New bookmark' : 'New bookmark folder',
        submit: 'Create',
        content,
        restoreId: parentId,
        onSubmit: () =>
          submit({
            kind: 'create',
            type,
            parentId: parent.value,
            title: name.value,
            ...(address ? { url: address.value } : {}),
          }),
        afterSubmit: (result) => reveal(result.id),
      },
      name,
    );
  }

  function move(id) {
    const index = getIndex();
    const node = index?.byId.get(id);
    if (!node) return announce('That bookmark is no longer available.', true);
    const content = el('div');
    const parent = destination(content, index, node.parentId, id);
    const position = field(content, 'Position', '', 'select');

    function positions() {
      position.replaceChildren(el('option', '', 'At the end'));
      position.firstElementChild.value = '';
      for (const sibling of index.byId.get(parent.value)?.children || []) {
        if (sibling.id === id) continue;
        const option = el(
          'option',
          '',
          `Before ${sibling.title || (sibling.type === 'separator' ? 'separator' : sibling.url)}`,
        );
        option.value = sibling.id;
        position.append(option);
      }
    }

    parent.addEventListener('change', positions);
    positions();
    const submit = submitter();
    show(
      {
        title: 'Move bookmark' + (node.type === 'folder' ? ' folder' : ''),
        description: `Move “${node.title}” within your Firefox bookmarks.`,
        submit: 'Move',
        content,
        restoreId: id,
        onSubmit: () =>
          submit({
            kind: 'move',
            id,
            expected: bookmarkRecord(node),
            targetId: position.value || parent.value,
            position: position.value ? 'before' : 'inside',
          }),
        afterSubmit: () => reveal(id),
      },
      parent,
    );
  }

  async function remove(id) {
    const index = getIndex();
    const node = index?.byId.get(id);
    if (!node) return announce('That bookmark is no longer available.', true);
    const contents = bookmarkSubtree(index, id);
    const command = { kind: 'delete', id, expected: bookmarkRecord(node), contents };
    const submit = submitter();
    if (node.type === 'folder' && contents.length === 1) {
      try {
        await submit(command);
        await reveal(node.parentId);
        announce('Bookmark folder deleted.');
      } catch (error) {
        announce(`${error.message} Review unfinished changes in the Bookmarks menu.`, true);
      }
      return;
    }
    const bookmarks = contents.filter((entry) => entry.type === 'bookmark').length;
    const childFolders =
      contents.filter((entry) => entry.type === 'folder').length - Number(node.type === 'folder');
    const separators = contents.filter((entry) => entry.type === 'separator').length;
    const summary = `${bookmarks} bookmark${bookmarks === 1 ? '' : 's'}, ${childFolders} folder${childFolders === 1 ? '' : 's'}${separators ? `, ${separators} separator${separators === 1 ? '' : 's'}` : ''}`;
    const description =
      node.type === 'folder'
        ? `Delete “${node.title}” and its contents (${summary}) from Firefox? This cannot be undone here.`
        : `Delete “${node.title}” from Firefox? This cannot be undone here.`;
    show({
      title: node.type === 'folder' ? 'Delete bookmark folder' : 'Delete bookmark',
      description,
      submit: 'Delete',
      restoreId: id,
      onSubmit: () => submit(command),
      afterSubmit: () => reveal(node.parentId),
    });
    document.getElementById('dialog-cancel').focus();
  }

  async function recovery() {
    try {
      const pending = await request('getBookmarkEdits');
      const content = el('div', 'bookmark-recovery');
      if (!pending.length) content.append(el('p', '', 'There are no unfinished bookmark changes.'));
      for (const operation of pending) {
        const { command } = operation;
        const row = el('div');
        row.append(
          el(
            'p',
            '',
            `${{ create: 'Create', update: 'Edit', move: 'Move', delete: 'Delete' }[command.kind]} “${command.title || command.expected?.title || 'bookmark'}”`,
          ),
        );
        const retry = button('Retry change', null, () => run('editBookmark'), 'pane-back');
        retry.textContent = 'Retry';
        const keep = button(
          'Keep changes so far',
          null,
          () => run('dismissBookmarkEdit'),
          'pane-back',
        );
        keep.textContent = 'Keep changes so far';
        const error = el('p');
        error.setAttribute('role', 'status');

        async function run(type) {
          retry.disabled = keep.disabled = true;
          try {
            await request(type, operation);
            row.replaceChildren(
              el(
                'p',
                '',
                type === 'editBookmark' ? 'Change completed.' : 'Kept the current bookmarks.',
              ),
            );
          } catch (failure) {
            error.textContent = failure.message;
          } finally {
            retry.disabled = keep.disabled = false;
            await refresh();
          }
        }

        row.append(retry, keep, error);
        content.append(row);
      }
      show({
        title: 'Unfinished bookmark changes',
        description:
          'Retry an interrupted change, or keep the bookmarks as they are now. Keeping them does not undo any changes already made.',
        content,
        submit: null,
        cancel: 'Close',
      });
      document.getElementById('dialog-cancel').focus();
    } catch (error) {
      announce(error.message, true);
    }
  }

  function openMenu(id, event) {
    const index = getIndex();
    if (!index) return;
    const node = index.byId.get(id);
    const parentId = node?.type === 'folder' ? id : node?.parentId || folders(index)[0]?.node.id;
    const editable = bookmarkEditable(index, id);
    const items = [
      ...(editable
        ? [
            {
              label: node.type === 'folder' ? 'Rename folder…' : 'Edit bookmark…',
              icon: 'rename',
              run: () => edit(id),
            },
            { label: 'Move…', icon: 'group', run: () => move(id) },
            null,
          ]
        : []),
      { label: 'New bookmark…', icon: 'bookmark', run: () => create('bookmark', parentId) },
      { label: 'New folder…', icon: 'groupPlus', run: () => create('folder', parentId) },
      ...(editable
        ? [
            null,
            {
              label:
                node.type === 'folder'
                  ? `Delete folder${node.children.length ? '…' : ''}`
                  : 'Delete bookmark…',
              icon: 'trash',
              danger: true,
              run: () => remove(id),
            },
          ]
        : []),
      ...(!id ? [null, { label: 'Unfinished changes…', icon: 'history', run: recovery }] : []),
    ];
    const trigger = event.currentTarget || event.target;
    const rect = trigger.getBoundingClientRect();
    menu(
      items,
      event.type === 'contextmenu' ? event.clientX : rect.right,
      event.type === 'contextmenu' ? event.clientY : rect.bottom,
      { trigger, alignRight: event.type !== 'contextmenu', label: 'Bookmark actions' },
    );
  }

  async function drop(id, targetId, position, expected) {
    try {
      const target = bookmarkMove(getIndex(), id, targetId, position);
      if (target.noOp) return;
      await submitter()({ kind: 'move', id, targetId, position, expected });
      await reveal(id);
      announce('Bookmark moved.');
    } catch (error) {
      announce(`${error.message} Review unfinished changes in the Bookmarks menu.`, true);
    }
  }

  return { openMenu, drop, edit, remove };
}
