import { icon } from './icons.js';
import { groupPath } from './model.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Keep destination selection local to the form; browsing never changes the sidebar scope.
export function createFolderPicker({ getState, parentId, dialog, onChange }) {
  let selectedId = parentId;
  let rows = [];
  const expanded = new Set([null, ...groupPath(getState(), parentId).map((group) => group.id)]);
  const events = new AbortController();
  const field = el('div', 'folder-field');
  const label = el('label', '', 'Create in');
  label.htmlFor = 'create-in';
  const trigger = el('button', 'folder-picker-trigger');
  trigger.type = 'button';
  trigger.id = 'create-in';
  trigger.setAttribute('aria-haspopup', 'tree');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'folder-picker-tree');
  trigger.setAttribute('aria-describedby', 'create-in-help');
  const value = el('span', 'folder-picker-value');
  trigger.append(icon('group'), value, icon('chevron', 'folder-picker-chevron'));
  const help = el('p', 'folder-picker-help', 'Defaults to your current folder');
  help.id = 'create-in-help';
  const popup = el('div', 'folder-picker-popup');
  popup.hidden = true;
  const searchWrap = el('div', 'folder-picker-search');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Find a folder…';
  search.setAttribute('aria-label', 'Find a folder');
  search.autocomplete = 'off';
  searchWrap.append(icon('search'), search);
  const tree = el('div', 'folder-picker-tree');
  tree.id = 'folder-picker-tree';
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Destination folders');
  const empty = el('p', 'folder-picker-empty', 'No folders found.');
  empty.setAttribute('role', 'status');
  empty.hidden = true;
  popup.append(searchWrap, tree, empty);
  field.append(label, trigger, help, popup);

  function pathFor(id) {
    return ['Home', ...groupPath(getState(), id).map((group) => group.name)].join(' / ');
  }

  function updateValue() {
    value.textContent = pathFor(selectedId);
    trigger.title = value.textContent;
  }

  function close(restoreFocus = false) {
    popup.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }

  function choose(id) {
    selectedId = id;
    updateValue();
    onChange?.(id);
    close(true);
  }

  function focusRow(index) {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))]?.node;
    if (!row) return;
    for (const { node } of rows) node.tabIndex = node === row ? 0 : -1;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  }

  function position() {
    if (popup.hidden) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 5;
    const above = rect.top - gap - 8;
    const below = window.innerHeight - rect.bottom - gap - 8;
    const upwards = above >= Math.min(280, popup.scrollHeight) || above > below;
    popup.style.width = `${Math.min(rect.width, window.innerWidth - 16)}px`;
    popup.style.maxHeight = `${Math.max(0, Math.min(280, upwards ? above : below))}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`;
    popup.style.top = `${upwards ? rect.top - gap - popup.getBoundingClientRect().height : rect.bottom + gap}px`;
  }

  function render(focusId) {
    const groups = getState().groups;
    const byParent = new Map();
    for (const group of groups) {
      if (!byParent.has(group.parentId)) byParent.set(group.parentId, []);
      byParent.get(group.parentId).push(group);
    }
    const query = search.value.trim().toLocaleLowerCase();
    const entries = [];
    const visited = new Set();

    function visit(group, depth, path) {
      if (visited.has(group.id)) return;
      visited.add(group.id);
      const nested = byParent.get(group.id) || [];
      const fullPath = [...path, group.name];
      if (!query || fullPath.join(' / ').toLocaleLowerCase().includes(query))
        entries.push({ ...group, depth, path: fullPath.join(' / '), hasChildren: !!nested.length });
      if (query || expanded.has(group.id))
        for (const child of nested) visit(child, depth + 1, fullPath);
    }

    visit({ id: null, name: 'Home' }, 0, []);
    rows = [];
    for (const entry of entries) {
      const open = !query && entry.hasChildren && expanded.has(entry.id);
      const row = el('div', 'folder-picker-row');
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-label', entry.name);
      row.setAttribute('aria-level', query ? '1' : String(entry.depth + 1));
      row.setAttribute('aria-selected', String(entry.id === selectedId));
      row.tabIndex = -1;
      row.title = entry.path;
      row.style.setProperty('--folder-depth', query ? 0 : Math.min(entry.depth, 5));
      const disclosure = el(
        entry.hasChildren && !query ? 'button' : 'span',
        'folder-picker-toggle',
      );
      if (entry.hasChildren && !query) {
        row.setAttribute('aria-expanded', String(open));
        disclosure.type = 'button';
        disclosure.tabIndex = -1;
        disclosure.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${entry.name}`);
        disclosure.append(icon('chevron'));
        disclosure.addEventListener('click', (event) => {
          event.stopPropagation();
          if (open) expanded.delete(entry.id);
          else expanded.add(entry.id);
          render(entry.id);
        });
      }
      const text = el('span', 'folder-picker-text');
      text.append(el('span', 'folder-picker-name', entry.name));
      if (query) text.append(el('span', 'folder-picker-path', entry.path));
      row.append(disclosure, icon(open ? 'groupOpen' : 'group'), text);
      if (entry.id === selectedId) row.append(icon('check', 'folder-picker-check'));
      row.addEventListener('click', () => choose(entry.id));
      row.addEventListener('keydown', (event) => {
        const index = rows.findIndex((item) => item.id === entry.id);
        switch (event.key) {
          case 'ArrowDown':
            focusRow(index + 1);
            break;
          case 'ArrowUp':
            if (index === 0) search.focus();
            else focusRow(index - 1);
            break;
          case 'Home':
            focusRow(0);
            break;
          case 'End':
            focusRow(rows.length - 1);
            break;
          case 'ArrowRight':
            if (!query && entry.hasChildren) {
              if (expanded.has(entry.id)) focusRow(index + 1);
              else {
                expanded.add(entry.id);
                render(entry.id);
              }
            }
            break;
          case 'ArrowLeft':
            if (!query && entry.hasChildren && expanded.has(entry.id)) {
              expanded.delete(entry.id);
              render(entry.id);
            } else if (!query && entry.id !== null) {
              focusRow(rows.findIndex((item) => item.id === entry.parentId));
            }
            break;
          case 'Enter':
          case ' ':
            choose(entry.id);
            break;
          default:
            return;
        }
        event.preventDefault();
        event.stopPropagation();
      });
      rows.push({ ...entry, node: row });
    }
    tree.replaceChildren(...rows.map((row) => row.node));
    empty.hidden = rows.length > 0;
    const active = rows.findIndex(
      (row) => row.id === (focusId === undefined ? selectedId : focusId),
    );
    if (rows.length) rows[Math.max(0, active)].node.tabIndex = 0;
    position();
    if (focusId !== undefined) focusRow(active);
  }

  function open() {
    search.value = '';
    for (const group of groupPath(getState(), selectedId)) expanded.add(group.id);
    expanded.add(null);
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    render();
    search.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', () => (popup.hidden ? open() : close(true)));
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    }
  });
  search.addEventListener('input', () => render());
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(event.key === 'ArrowDown' ? 0 : rows.length - 1);
    } else if (event.key === 'Enter') {
      // Enter in the search must never submit the create-group form.
      event.preventDefault();
      if (rows.length) choose(rows[0].id);
    }
  });
  field.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !field.contains(event.relatedTarget)) close();
  });
  dialog.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && !popup.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    },
    { signal: events.signal },
  );
  dialog.addEventListener(
    'pointerdown',
    (event) => {
      if (!field.contains(event.target)) close();
    },
    { signal: events.signal },
  );
  dialog.addEventListener('scroll', position, { signal: events.signal });
  window.addEventListener('resize', position, { signal: events.signal });
  updateValue();
  return {
    element: field,
    getValue: () => selectedId,

    destroy() {
      close();
      events.abort();
    },
  };
}
