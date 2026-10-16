import { children, groupById, groupPath, isWithin, tabSubtree } from './model.js';
import { moveSource, resolveMove, sourcePlacement } from './move-plan.js';
import { folderContainer, folderIcon } from './folder-icons.js';
import { icon } from './icons.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Browsing and filtering are local to the dialog, never the sidebar's saved view.
export function createMovePicker(getState, kind, id, { favicon } = {}) {
  const initial = getState();
  const source = moveSource(initial, kind, id);
  const original = sourcePlacement(initial, source);
  const tab = kind === 'tab' ? initial.tabs.find((tab) => tab.id === id) : null;
  const group = tab ? null : groupById(initial, id);
  let selectedId = tab ? tab.groupId : group.parentId;
  let rows = [],
    previewPlan,
    planError,
    searchPending = false;
  const expanded = new Set([null, ...groupPath(initial, selectedId).map((group) => group.id)]);
  const node = el('div', 'move-picker');
  const sourceRow = el('div', 'move-source');
  sourceRow.id = 'move-source';
  const sourceText = el('div', 'move-source-text');
  const title = el('span', 'move-source-title', tab?.title || group?.name || 'New tab');
  title.title = title.textContent;
  sourceText.append(title);
  const nested = tab ? tabSubtree(initial.tabs, id).length - 1 : 0;
  if (nested)
    sourceText.append(
      el('span', 'move-source-detail', `Includes ${nested} child ${nested === 1 ? 'tab' : 'tabs'}`),
    );
  sourceRow.append(
    tab
      ? favicon?.(tab) || icon('globe')
      : folderIcon(group, folderContainer(initial, group), { state: initial }),
    sourceText,
  );
  const field = el('div', 'picker-search-field');
  const label = el('label', '', 'Destination');
  label.htmlFor = 'move-search';
  const searchWrap = el('div', 'picker-search');
  const search = el('input');
  search.id = 'move-search';
  search.type = 'search';
  search.placeholder = 'Search folders';
  search.autocomplete = 'off';
  search.setAttribute('aria-controls', 'move-tree');
  const clear = el('button', 'picker-search-clear');
  clear.type = 'button';
  clear.setAttribute('aria-label', 'Clear folder search');
  clear.append(icon('closeSmall'));
  clear.hidden = true;
  searchWrap.append(icon('search'), search, clear);
  field.append(label, searchWrap);
  const tree = el('div', 'move-tree');
  tree.id = 'move-tree';
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Destination folders');
  const empty = el('p', 'move-empty', 'No folders found.');
  empty.hidden = true;
  empty.setAttribute('role', 'status');
  const status = el('span', 'sr-only');
  status.setAttribute('role', 'status');
  node.append(sourceRow, field, tree, empty, status);

  function intent() {
    return { kind: 'tree', groupId: selectedId, beforeId: null };
  }

  function resolve() {
    if (sourcePlacement(getState(), source) !== original)
      throw new Error('The source has moved. Close this dialog and try again.');
    return resolveMove(getState(), source, intent());
  }

  function refreshPlan() {
    try {
      previewPlan = resolve();
      planError = undefined;
    } catch (error) {
      previewPlan = null;
      planError = error.message;
    }
  }

  function valid() {
    return Boolean(
      previewPlan &&
      !previewPlan.noOp &&
      !searchPending &&
      rows.some((row) => row.id === selectedId),
    );
  }

  function notify() {
    node.dispatchEvent(new Event('destinationchange'));
  }

  function choose(id) {
    if (search.disabled) return;
    selectedId = id;
    searchPending = false;
    refreshPlan();
    for (const row of rows) {
      row.node.setAttribute('aria-selected', String(row.id === selectedId));
      row.check.toggleAttribute('hidden', row.id !== selectedId);
    }
    status.textContent = `${id === null ? 'Home' : groupById(getState(), id)?.name || 'Folder'} selected`;
    notify();
  }

  function focusRow(index) {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
    if (!row) return;
    for (const entry of rows) entry.node.tabIndex = entry === row ? 0 : -1;
    row.node.focus({ preventScroll: true });
    row.line.scrollIntoView({ block: 'nearest' });
  }

  function render(focusId) {
    const state = getState();
    const query = search.value.trim().toLocaleLowerCase();
    clear.hidden = !search.value;
    const allowed = state.groups.filter(
      (group) => kind !== 'group' || !isWithin(state, group.id, id),
    );
    const allowedIds = new Set(allowed.map((group) => group.id));
    const matches = new Set(
      allowed
        .filter((group) => group.name.toLocaleLowerCase().includes(query))
        .map((group) => group.id),
    );
    if ('home'.includes(query)) matches.add(null);
    const visible = new Set(matches);
    for (const match of matches) {
      visible.add(null);
      for (const ancestor of groupPath(state, match)) visible.add(ancestor.id);
    }
    rows = [];

    function branch(entry, depth, position, size) {
      const nested = children(state, entry.id).filter(
        (child) => allowedIds.has(child.id) && (!query || visible.has(child.id)),
      );
      const open = nested.length > 0 && (Boolean(query) || expanded.has(entry.id));
      const item = el('div', 'move-tree-item');
      item.setAttribute('role', 'treeitem');
      item.setAttribute('aria-label', entry.name);
      item.setAttribute('aria-level', String(depth + 1));
      item.setAttribute('aria-posinset', String(position));
      item.setAttribute('aria-setsize', String(size));
      item.setAttribute('aria-selected', String(entry.id === selectedId));
      item.tabIndex = -1;
      const line = el('div', 'move-tree-row');
      const disclosure = el(nested.length ? 'button' : 'span', 'move-tree-toggle');
      if (nested.length) {
        item.setAttribute('aria-expanded', String(open));
        disclosure.type = 'button';
        disclosure.tabIndex = -1;
        disclosure.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${entry.name}`);
        disclosure.append(icon('chevron'));
        // Search reveals matching descendants; clear it to resume manual folding.
        disclosure.disabled = Boolean(query);
        disclosure.addEventListener('click', (event) => {
          event.stopPropagation();
          if (search.disabled) return;
          if (open) expanded.delete(entry.id);
          else expanded.add(entry.id);
          render(entry.id);
        });
      }
      const name = el('span', 'move-folder-name', entry.name);
      name.title = entry.name;
      const check = icon('check', 'move-folder-check');
      check.toggleAttribute('hidden', entry.id !== selectedId);
      line.append(
        disclosure,
        entry.id === null
          ? icon('home')
          : folderIcon(entry, folderContainer(state, entry), { expanded: open, state }),
        name,
        check,
      );
      line.addEventListener('click', () => {
        if (search.disabled) return;
        choose(entry.id);
        focusRow(rows.findIndex((row) => row.id === entry.id));
      });
      item.append(line);
      rows.push({ ...entry, node: item, line, check, matches: matches.has(entry.id) });
      if (open) {
        const list = el('div', 'move-tree-group');
        list.setAttribute('role', 'group');
        list.style.setProperty('--move-indent', depth < 4 ? '16px' : '4px');
        nested.forEach((child, index) =>
          list.append(branch(child, depth + 1, index + 1, nested.length)),
        );
        item.append(list);
      }
      item.addEventListener('keydown', (event) => {
        if (search.disabled || event.target.closest('[role="treeitem"]') !== item) return;
        const index = rows.findIndex((row) => row.id === entry.id);
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
            if (open) focusRow(index + 1);
            else if (nested.length && !query) {
              expanded.add(entry.id);
              render(entry.id);
            }
            break;
          case 'ArrowLeft':
            if (open && !query) {
              expanded.delete(entry.id);
              render(entry.id);
            } else if (entry.id !== null)
              focusRow(rows.findIndex((row) => row.id === entry.parentId));
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
      return item;
    }

    tree.replaceChildren(
      ...(!query || visible.has(null) ? [branch({ id: null, name: 'Home' }, 0, 1, 1)] : []),
    );
    empty.hidden = rows.length > 0;
    tree.hidden = !rows.length;
    const active = rows.findIndex(
      (row) => row.id === (focusId === undefined ? selectedId : focusId),
    );
    if (rows.length) rows[Math.max(0, active)].node.tabIndex = 0;
    if (focusId !== undefined) focusRow(active);
    notify();
  }

  search.addEventListener('input', () => {
    searchPending = Boolean(search.value.trim());
    render();
  });
  search.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(event.key === 'ArrowDown' ? 0 : rows.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const first = rows.find((row) => row.matches);
      if (first) {
        choose(first.id);
        focusRow(rows.indexOf(first));
      }
    }
  });
  clear.addEventListener('click', () => {
    search.value = '';
    searchPending = false;
    render();
    search.focus();
  });
  refreshPlan();
  render();
  return {
    node,
    intent,
    valid,
    error: () => planError,
    focus: () => search.focus(),

    plan() {
      const current = resolve();
      if (!previewPlan || current.expected !== previewPlan.expected)
        throw new Error('The destination has changed. Select a folder again.');
      if (!valid()) throw new Error('Select a destination folder.');
      return current;
    },
  };
}
