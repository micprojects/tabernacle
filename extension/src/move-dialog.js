import {
  children,
  isWithin,
  sortTabs,
  tabAncestors,
  tabSubtree,
  unpinnedTabTree,
} from './model.js';
import { folderDestinationName, moveSource, resolveMove, sourcePlacement } from './move-plan.js';

function field(label, id) {
  const wrapper = document.createElement('div');
  wrapper.className = 'move-field';
  const text = document.createElement('label');
  text.htmlFor = id;
  text.textContent = label;
  const select = document.createElement('select');
  select.id = id;
  select.setAttribute('aria-label', label);
  wrapper.append(text, select);
  return { wrapper, select };
}

function option(select, value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  select.append(node);
}

export function createMovePicker(getState, kind, id) {
  const initial = getState();
  const source = moveSource(initial, kind, id);
  const original = sourcePlacement(initial, source);
  const tab = initial.tabs.find((tab) => tab.id === id && kind === 'tab');
  const excluded = new Set(tab ? tabSubtree(initial.tabs, id).map((tab) => tab.id) : []);
  const node = document.createElement('div');
  node.className = 'move-picker';
  const destination = field('Destination', 'move-destination');
  const position = field('Position', 'move-position');
  const summary = document.createElement('p');
  summary.className = 'move-summary';
  summary.setAttribute('role', 'status');
  node.append(destination.wrapper, position.wrapper, summary);
  if (kind !== 'pin-group') option(destination.select, '', 'Home');
  for (const group of initial.groups) {
    if (kind === 'pin-group') continue;
    if (kind === 'group' && isWithin(initial, group.id, id)) continue;
    option(destination.select, group.id, folderDestinationName(initial, group.id));
  }
  if (tab) {
    for (const parent of unpinnedTabTree(initial.tabs)) {
      if (excluded.has(parent.id)) continue;
      const path = [...tabAncestors(initial.tabs, parent.id).reverse(), parent]
        .map((tab) => tab.title || 'New tab')
        .join(' / ');
      option(
        destination.select,
        `tab:${parent.id}`,
        `${folderDestinationName(initial, parent.groupId)} / ${path}`,
      );
    }
  }
  if (tab || kind === 'pin-group') option(destination.select, 'pins', 'Pinned items');
  destination.select.value =
    kind === 'pin-group'
      ? 'pins'
      : tab
        ? tab.pinned
          ? 'pins'
          : tab.parentTabId == null
            ? tab.groupId || ''
            : `tab:${tab.parentTabId}`
        : initial.groups.find((group) => group.id === id).parentId || '';

  function baseIntent() {
    const value = destination.select.value;
    if (value === 'pins') return { kind: 'pins', before: null };
    if (value.startsWith('tab:')) {
      const parent = getState().tabs.find((tab) => tab.id === Number(value.slice(4)));
      if (!parent) throw new Error('The parent tab has closed.');
      return { kind: 'tree', groupId: parent.groupId, parentTabId: parent.id };
    }
    return { kind: 'tree', groupId: value || null };
  }

  function intent() {
    const result = baseIntent();
    const selected = position.select.selectedOptions[0]?.dataset.before;
    const before = selected ? JSON.parse(selected) : null;
    if (result.kind === 'pins') result.before = before;
    else result.beforeId = before;
    return result;
  }

  let previewPlan;

  function resolve() {
    if (sourcePlacement(getState(), source) !== original)
      throw new Error('The source has moved. Close this dialog and try again.');
    return resolveMove(getState(), source, intent());
  }

  function plan() {
    const current = resolve();
    if (!previewPlan || current.expected !== previewPlan.expected)
      throw new Error('The destination has changed. Choose its position again.');
    return current;
  }

  function describe() {
    try {
      previewPlan = resolve();
      summary.textContent = `${previewPlan.title}${kind === 'group' ? ` · ${previewPlan.count} ${previewPlan.count === 1 ? 'tab' : 'tabs'}` : ''}\n${previewPlan.noOp ? 'Already in this position.' : previewPlan.label}`;
    } catch (error) {
      previewPlan = null;
      summary.textContent = error.message;
    }
  }

  function positions() {
    const state = getState();
    const target = baseIntent();
    let siblings;
    if (target.kind === 'pins') {
      siblings = state.pins
        .filter(
          (item) =>
            !(tab
              ? item.kind === 'tab' && item.id === source.treeId
              : item.kind === 'group' && item.id === source.id),
        )
        .map((item) => ({
          key: item,
          label:
            item.kind === 'tab'
              ? state.tabs.find((tab) => tab.treeId === item.id)?.title || 'New tab'
              : state.groups.find((group) => group.id === item.id)?.name || 'Folder',
        }));
    } else if (kind === 'group')
      siblings = children(state, target.groupId)
        .filter((group) => group.id !== id)
        .map((group) => ({ key: group.id, label: group.name }));
    else
      siblings = sortTabs(
        unpinnedTabTree(state.tabs).filter(
          (tab) =>
            tab.groupId === target.groupId &&
            tab.parentTabId === (target.parentTabId ?? null) &&
            !excluded.has(tab.id),
        ),
      ).map((tab) => ({ key: tab.id, label: tab.title || 'New tab' }));
    position.select.replaceChildren();
    option(position.select, 'first', 'First');
    position.select.lastElementChild.dataset.before = JSON.stringify(siblings[0]?.key ?? null);
    option(position.select, 'last', 'Last');
    for (const [index, sibling] of siblings.entries()) {
      option(position.select, `before:${index}`, `Before ${sibling.label}`);
      position.select.lastElementChild.dataset.before = JSON.stringify(sibling.key);
    }
    position.select.value = 'last';
    describe();
  }

  destination.select.addEventListener('change', () => {
    try {
      positions();
    } catch (error) {
      previewPlan = null;
      position.select.replaceChildren();
      summary.textContent = error.message;
    }
  });
  position.select.addEventListener('change', describe);
  positions();
  return { node, plan, intent, focus: () => destination.select.focus() };
}
