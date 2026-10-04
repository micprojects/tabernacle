import { icon } from './icons.js';
import { createTreeIndex, scopeBranches } from './tree-index.js';
import { createRowCache, reconcileChildren, setAttribute } from './dom.js';
import { createDialogs } from './dialogs.js';
import { createTabPreviews } from './previews.js';
import { createRecentlyClosed } from './recently-closed.js';
import {
  groupById,
  groupPath,
  isWithin,
  children,
  sortTabs,
  tabChildren,
  tabSubtree,
} from './model.js';

const $ = (id) => document.getElementById(id);
const tree = $('tree');
let treeTabs = [];
let index;
const rowCache = createRowCache();
const wrappers = new Map();
const usedWrappers = new Set();
let breadcrumbKey;
let breadcrumbItems = [];
let folderMenuKey;
let searchOpen = false;
let changingTree = false;
let windowFocused = true;
let windowFocusedAt = -Infinity;

function canToggleTabChildren() {
  // Firefox can deliver window activation just before the press that caused it.
  // Treat that press as activation only; the next click can fold immediately.
  return windowFocused && performance.now() - windowFocusedAt > 200;
}

function wrapperFor(kind, id) {
  const key = `${kind}:${id}`;
  usedWrappers.add(key);
  if (!wrappers.has(key)) {
    const node = el('div', `${kind}-node`);
    node.setAttribute('role', 'none');
    const branch = el('div', kind === 'group' ? 'branch' : 'tab-branch');
    branch.setAttribute('role', 'group');
    wrappers.set(key, { node, branch });
  }
  return wrappers.get(key);
}

function markSelected(row) {
  row.classList.toggle('selected', selected === row.dataset.key);
  return row;
}

let audioInTabs = new Map(),
  audioInGroups = new Map();
let previews, recentlyClosed;
let state, request, windowId, selected, drag, refreshTimer, toastTimer, menuReturnFocus;
let confirmedState;
let actionQueue = Promise.resolve();
let activeActions = 0;
let notifiedRevision = -1;
const pendingViewActions = [];

function acceptState(next) {
  if (confirmedState?.generation !== next.generation) notifiedRevision = -1;
  confirmedState = next;
  const collapsed = new Set(next.view.collapsed);
  let scopeId = next.view.scopeId;
  // Replay local view changes in order so older replies cannot undo a newer
  // navigation, including the first click's toggle before a double-click.
  for (const { type, args } of pendingViewActions) {
    if (type === 'toggleGroup') {
      if (collapsed.has(args.id)) collapsed.delete(args.id);
      else collapsed.add(args.id);
    } else {
      scopeId = args.id;
      if (scopeId !== null && typeof args.collapsed === 'boolean') {
        collapsed.delete(scopeId);
        if (args.collapsed) collapsed.add(scopeId);
      }
    }
  }
  state = { ...next, view: { ...next.view, scopeId, collapsed: [...collapsed] } };
}

let refreshing = false,
  refreshAgain = false,
  pointerHeld = false,
  renderPending = false;
const demo = !globalThis.browser?.runtime?.id && new URLSearchParams(location.search).has('demo');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, iconName, handler, className = 'icon-button') {
  const node = el('button', className);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  if (iconName) node.append(icon(iconName));
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    handler(event);
  });
  return node;
}

function breadcrumbMenuButton(label, iconName, handler, className) {
  const node = button(label, iconName, handler, className);
  node.setAttribute('aria-haspopup', 'menu');
  node.setAttribute('aria-controls', 'menu');
  node.setAttribute('aria-expanded', 'false');
  node.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      handler(event);
    }
  });
  return node;
}

function folderChevron(parentId, parentName) {
  return breadcrumbMenuButton(
    `Show groups in ${parentName}`,
    'chevron',
    (event) => toggleFolderMenu(event.currentTarget, parentId),
    'crumb-children',
  );
}

const pathOverflow = breadcrumbMenuButton(
  'Show full group path',
  null,
  togglePathMenu,
  'crumb crumb-overflow',
);
pathOverflow.id = 'path-overflow';
pathOverflow.textContent = '…';
const pathOverflowSeparator = folderChevron(null, 'Home');

function announce(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(
    () => {
      $('toast').hidden = true;
    },
    error ? 7000 : 4000,
  );
}

const {
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
} = createDialogs({
  getState: () => state,
  request: (...args) => request(...args),
  closeMenu,

  onChange(next, key) {
    acceptState(next);
    if (key) selected = key;
    if (key?.startsWith('tab:')) $('search').value = '';
    render();
  },
});

function action(type, args = {}) {
  const viewAction = ['toggleGroup', 'enterGroup'].includes(type) ? { type, args } : null;
  if (viewAction) {
    pendingViewActions.push(viewAction);
    acceptState(confirmedState);
    render();
  }
  activeActions++;

  const finishViewAction = () => {
    if (viewAction) pendingViewActions.splice(pendingViewActions.indexOf(viewAction), 1);
  };

  const result = actionQueue.then(async () => {
    try {
      const next = await request(type, args);
      finishViewAction();
      acceptState(next);
      render();
      return state;
    } catch (error) {
      finishViewAction();
      acceptState(confirmedState);
      render();
      announce(error.message, true);
      return null;
    } finally {
      activeActions--;
      if (!activeActions && (refreshAgain || notifiedRevision > (state?.revision ?? -1)))
        scheduleRefresh();
    }
  });
  actionQueue = result.catch(() => {});
  return result;
}

const toggleGroup = (id) => action('toggleGroup', { id });
let lastGroupClick;
let pendingGroupClick;
let handledGroupDoubleClick = false;

function cancelGroupClick() {
  clearTimeout(pendingGroupClick?.timer);
  pendingGroupClick = null;
}

function finishGroupClick() {
  const click = pendingGroupClick;
  cancelGroupClick();
  if (click && state.view.scopeId === click.scopeId && groupById(state, click.id))
    toggleGroup(click.id);
}

function clickGroup(id, event) {
  finishGroupClick();
  // Keyboard and assistive activation do not need a double-click grace period.
  if (event.detail === 0) return toggleGroup(id);
  lastGroupClick = { id, collapsed: state.view.collapsed.includes(id) };
  pendingGroupClick = {
    ...lastGroupClick,
    scopeId: state.view.scopeId,
    timer: setTimeout(finishGroupClick, 120),
  };
}

// Cancel on the second press, before its release can outlast the grace period.
// Keep the native click count and original target even if scrolling moves it.
tree.addEventListener(
  'mousedown',
  (event) => {
    if (event.button === 0 && event.detail === 2 && lastGroupClick) cancelGroupClick();
  },
  true,
);
tree.addEventListener(
  'click',
  (event) => {
    if (event.detail < 2) {
      lastGroupClick = null;
      handledGroupDoubleClick = false;
    } else if (event.detail === 2 && lastGroupClick) {
      event.stopImmediatePropagation();
      handledGroupDoubleClick = true;
      enter(lastGroupClick.id, lastGroupClick.collapsed);
      lastGroupClick = null;
    }
  },
  true,
);
tree.addEventListener(
  'dblclick',
  (event) => {
    if (handledGroupDoubleClick) {
      event.stopImmediatePropagation();
      handledGroupDoubleClick = false;
    }
  },
  true,
);

async function refresh() {
  refreshTimer = null;
  if (drag || pointerHeld || activeActions) {
    refreshAgain = true;
    return;
  }
  if (!renderPending && notifiedRevision >= 0 && notifiedRevision <= (state?.revision ?? -1)) {
    refreshAgain = false;
    return;
  }
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    const next = await request('snapshot');
    acceptState(next);
    render();
  } catch (error) {
    if (!state) tree.replaceChildren(el('p', 'loading', error.message));
    announce(error.message, true);
  } finally {
    refreshing = false;
    if (refreshAgain && !drag) {
      refreshAgain = false;
      scheduleRefresh();
    }
  }
}

function scheduleRefresh(change) {
  if (change?.windowIds && !change.windowIds.includes(windowId)) return;
  if (change?.windowId != null && change.windowId !== windowId) return;
  if (change?.generation && change.generation !== state?.generation) {
    // An MV3 event page can restart while the sidebar stays open. Its new
    // revision sequence must not be compared with the previous instance.
    notifiedRevision = -1;
  } else if (Number.isFinite(change?.revision)) {
    notifiedRevision = Math.max(notifiedRevision, change.revision);
    if (change.revision <= (state?.revision ?? -1)) return;
  } else if (change) notifiedRevision = -1;
  if (!refreshTimer) refreshTimer = setTimeout(refresh, 16);
}

function enter(id, collapsed) {
  cancelGroupClick();
  if (searchOpen) showSearch(false, { restoreFocus: false });
  $('search').value = '';
  return action('enterGroup', { id, ...(typeof collapsed === 'boolean' ? { collapsed } : {}) });
}

function parent() {
  if (state?.view.scopeId) enter(groupById(state, state.view.scopeId)?.parentId ?? null);
}

function count(id) {
  return id === null ? treeTabs.length : index.groupStats.get(id)?.count || 0;
}

function searchVisible(id) {
  return index.groupStats.get(id)?.match;
}

function selectRow(row) {
  selected = row.dataset.key;
  tree.querySelectorAll('.selected').forEach((node) => node.classList.remove('selected'));
  row.classList.toggle('selected', row.matches('.row'));
  row.focus({ preventScroll: true });
}

function rowBase(kind, id) {
  const row = el('div', `row ${kind}-row`);
  row.dataset.key = `${kind}:${id}`;
  row.dataset.kind = kind;
  row.dataset.id = id;
  row.tabIndex = 0;
  row.setAttribute('role', 'treeitem');
  row.draggable = true;
  row.classList.toggle('selected', selected === row.dataset.key);
  row.addEventListener('click', () => selectRow(row));
  row.addEventListener('contextmenu', (event) => {
    cancelGroupClick();
    event.preventDefault();
    selectRow(row);
    contextMenu(kind, id, event.clientX, event.clientY);
  });
  row.addEventListener('keydown', (event) => rowKey(event, row, kind, id));
  row.addEventListener('dragstart', (event) => {
    cancelGroupClick();
    drag = { kind, id, windowId };
    event.dataTransfer.setData('application/x-tabernacle', JSON.stringify(drag));
    event.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    drag = null;
    pointerHeld = false;
    clearDrops();
    row.classList.remove('dragging');
    if (refreshAgain) scheduleRefresh();
  });
  dropTarget(row, kind, id);
  return row;
}

function playsAudio(tab) {
  return Boolean(tab.audible && !tab.mutedInfo?.muted);
}

function childAudioCount(tab) {
  return (audioInTabs.get(tab.id) || 0) - Number(playsAudio(tab));
}

function playingLabel(count, location) {
  return `${count} ${count === 1 ? 'tab' : 'tabs'} playing audio ${location}`;
}

function audioDescription(tab) {
  const descriptions = [];
  if (tab.mutedInfo?.muted) descriptions.push('This tab is muted');
  else if (playsAudio(tab)) descriptions.push('This tab is playing audio');
  const children = childAudioCount(tab);
  if (children) descriptions.push(playingLabel(children, 'in this tab’s children'));
  return descriptions.join(' · ');
}

function audioIndicator(description, iconName = 'speaker') {
  const marker = el('span', 'audio-indicator');
  marker.title = description;
  marker.setAttribute('role', 'img');
  marker.setAttribute('aria-label', description);
  marker.append(icon(iconName));
  return marker;
}

function describeAudio(node, description) {
  if (!description) return;
  node.title += `\n${description}`;
  node.setAttribute('aria-label', `${node.getAttribute('aria-label')}, ${description}`);
}

function tabLabel(tab) {
  const label = el('span', 'label', tab.title || 'New tab');
  if (!state.look.domains) return label;
  const copy = el('span', 'row-copy');
  const secondary = el('span', 'row-detail', tabDomain(tab));
  secondary.setAttribute('aria-hidden', 'true');
  copy.append(label, secondary);
  return copy;
}

function tabDomain(tab) {
  try {
    return new URL(tab.url).hostname.replace(/^www\./, '') || 'New tab';
  } catch {
    return '';
  }
}

function createGroupRow(group, container) {
  const row = rowBase('group', group.id);
  row.setAttribute('aria-label', `${group.name}, ${count(group.id)} tabs`);
  row.title = `${group.name}\nClick to expand/collapse · Double-click to enter · Right-click for options`;
  describeContainer(row, { container }, 'Default container');
  const playing = audioInGroups.get(group.id) || 0;
  const audio = playingLabel(playing, 'in this group');
  if (playing) describeAudio(row, audio);
  const disclosure = button(
    `Expand ${group.name}`,
    null,
    (event) => {
      selectRow(event.currentTarget.closest('.row'));
      clickGroup(group.id, event);
    },
    'disclosure',
  );
  disclosure.tabIndex = -1;
  disclosure.append(groupIcon(container, 'group'));
  row.append(
    disclosure,
    el('span', 'label', group.name),
    ...(playing ? [audioIndicator(audio)] : []),
  );
  row.addEventListener('click', (event) => {
    if (!event.target.closest('button') && event.detail < 2) {
      clickGroup(group.id, event);
    }
  });
  return row;
}

function groupNode(group, query, ancestorMatch = false) {
  if (query && !ancestorMatch && !searchVisible(group.id)) return null;
  const { node, branch } = wrapperFor('group', group.id);
  const container = groupContainerDetails(group);
  const row = markSelected(
    rowCache.get(
      `group:${group.id}`,
      [
        group.name,
        count(group.id),
        audioInGroups.get(group.id) || 0,
        container?.name,
        container?.colorCode,
      ],
      () => createGroupRow(group, container),
    ),
  );
  const expanded = Boolean(query) || !state.view.collapsed.includes(group.id);
  setAttribute(row, 'aria-expanded', expanded);
  const disclosure = row.querySelector('.disclosure');
  const label = `${expanded ? 'Collapse' : 'Expand'} ${group.name}`;
  setAttribute(disclosure, 'aria-expanded', expanded);
  setAttribute(disclosure, 'aria-label', label);
  setAttribute(disclosure, 'title', label);
  if (expanded) {
    const matchAll = ancestorMatch || (Boolean(query) && group.name.toLowerCase().includes(query));
    fillChildren(branch, group.id, query, matchAll);
    if (!branch.childElementCount) {
      const empty = el('div', 'empty-child', 'Drop tabs here');
      empty.setAttribute('role', 'none');
      dropTarget(empty, 'inside', group.id);
      branch.append(empty);
    }
    reconcileChildren(node, [row, branch]);
  } else {
    branch.replaceChildren();
    reconcileChildren(node, [row]);
  }
  return node;
}

function tabFavicon(tab) {
  const favicon = el('span', 'tab-icon');
  // Never fetch a third-party favicon service. Use only Firefox's supplied icon.
  if (
    typeof tab.favIconUrl === 'string' &&
    /^(https?:|data:image\/|moz-extension:)/i.test(tab.favIconUrl)
  ) {
    const img = el('img');
    img.src = tab.favIconUrl;
    img.alt = '';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.replaceWith(icon('globe')), { once: true });
    favicon.append(img);
  } else if (demo && tab.title !== 'New tab') {
    favicon.classList.add('tab-fallback');
    favicon.textContent = (tab.title || 'T').charAt(0);
  } else favicon.append(icon('globe'));
  if (tab.container) {
    const marker = el('span', 'container-indicator');
    marker.setAttribute('aria-hidden', 'true');
    const color = containerColor(tab.container);
    if (color) marker.style.setProperty('--container-color', color);
    favicon.append(marker);
  }
  return favicon;
}

function containerColor(container) {
  const color = container?.colorCode;
  return color && CSS.supports('color', color) ? color : null;
}

function groupIcon(container, className = '') {
  const folder = icon('group', className);
  const color = containerColor(container);
  if (color) folder.style.setProperty('--folder-color', color);
  return folder;
}

function groupContainerDetails(group) {
  const source = groupPath(state, group.id)
    .reverse()
    .find((item) => item.defaultCookieStoreId != null);
  if (!source) return null;
  const identity = state.containers?.find(
    (item) => item.cookieStoreId === source.defaultCookieStoreId,
  );
  const name =
    source.defaultCookieStoreId === 'firefox-default'
      ? 'No container'
      : identity?.name || 'Unavailable container';
  return {
    name: `${name}${source.id === group.id ? '' : ' (inherited)'}`,
    colorCode: identity?.colorCode,
  };
}

function describeContainer(node, { container }, label = 'Container') {
  if (!container) return;
  const name = container.name || 'Unnamed container';
  node.title += `\n${label}: ${name}`;
  node.setAttribute(
    'aria-label',
    `${node.getAttribute('aria-label')}, ${label.toLowerCase()}: ${name}`,
  );
}

function closeTab(id) {
  if (tabSubtree(state.tabs, id).length > 1) closeTabTreeDialog(id);
  else action('closeTab', { id });
}

function closeOnMiddleClick(node, id) {
  node.addEventListener('mousedown', (event) => {
    // Stop native autoscroll before it can consume the middle click.
    if (event.button === 1) event.preventDefault();
  });
  node.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    closeTab(id);
  });
}

function createPinnedTab(tab) {
  const label = `${tab.title || 'New tab'}, pinned`;
  const node = button(label, null, () => action('activateTab', { id: tab.id }), 'pinned-tab');
  node.dataset.key = `tab:${tab.id}`;
  node.title = `${tab.title || 'New tab'}\n${tab.url || ''}`;
  node.setAttribute('aria-pressed', String(Boolean(tab.active)));
  node.classList.toggle('active', Boolean(tab.active));
  node.draggable = true;
  node.addEventListener('dragstart', (event) => {
    cancelGroupClick();
    drag = { kind: 'pin', id: tab.id, windowId };
    event.dataTransfer.setData('application/x-tabernacle-pin', JSON.stringify(drag));
    event.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => {
    drag = null;
    pointerHeld = false;
    node.classList.remove('dragging');
    clearDrops();
    if (renderPending || refreshAgain) scheduleRefresh();
  });
  node.append(tabFavicon(tab));
  describeContainer(node, tab);
  const audio = audioDescription(tab);
  describeAudio(node, audio);
  if (audio) node.append(audioIndicator(audio, audioInTabs.get(tab.id) ? 'speaker' : 'muted'));
  previews?.bind(node, tab);
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    node.focus();
    contextMenu('tab', tab.id, event.clientX, event.clientY);
  });
  node.addEventListener('keydown', (event) => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      contextMenu('tab', tab.id, rect.left, rect.bottom);
    }
  });
  closeOnMiddleClick(node, tab.id);
  return node;
}

function rowValues(tab) {
  return [
    tab.title,
    tab.url,
    tab.favIconUrl,
    tab.active,
    tab.discarded,
    tab.audible,
    tab.mutedInfo?.muted,
    tab.container?.name,
    tab.container?.colorCode,
    audioInTabs.get(tab.id) || 0,
  ];
}

function pinnedTab(tab) {
  return rowCache.get(`pin:${tab.id}`, rowValues(tab), () => createPinnedTab(tab));
}

function createTabRow(tab, expanded, stats) {
  const favicon = tabFavicon(tab);
  const row = rowBase('tab', tab.id);
  row.classList.toggle('active', Boolean(tab.active));
  row.classList.toggle('contains-active', !expanded && stats.active);
  row.classList.toggle('discarded', Boolean(tab.discarded));
  row.setAttribute('aria-selected', String(Boolean(tab.active)));
  row.setAttribute('aria-label', tab.title || 'New tab');
  row.title = `${tab.title || 'New tab'}\n${tab.url || ''}`;
  describeContainer(row, tab);
  describeAudio(row, audioDescription(tab));
  previews?.bind(row, tab);
  if (stats.descendants) {
    row.setAttribute('aria-expanded', String(expanded));
    const count = `${stats.descendants} nested ${stats.descendants === 1 ? 'tab' : 'tabs'}`;
    row.title += `\n${count}`;
    row.setAttribute('aria-label', `${row.getAttribute('aria-label')}, ${count}`);
    const disclosure = button(
      `${expanded ? 'Collapse' : 'Expand'} child tabs of ${tab.title || 'New tab'}`,
      null,
      (event) => {
        selectRow(event.currentTarget.closest('.row'));
        windowFocusedAt = -Infinity;
        action('toggleTab', { id: tab.id, activate: true });
      },
      'disclosure tab-disclosure',
    );
    disclosure.tabIndex = -1;
    disclosure.setAttribute('aria-expanded', String(expanded));
    const badge = el('span', 'tab-toggle-badge');
    badge.setAttribute('aria-hidden', 'true');
    disclosure.append(favicon, badge);
    row.append(disclosure);
  } else {
    const slot = el('span', 'icon-slot');
    slot.append(favicon);
    row.append(slot);
  }
  row.append(tabLabel(tab));
  if (childAudioCount(tab) && !playsAudio(tab))
    row.append(audioIndicator(playingLabel(childAudioCount(tab), 'in this tab’s children')));
  if (tab.audible || tab.mutedInfo?.muted)
    row.append(
      button(
        tab.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab',
        tab.mutedInfo?.muted ? 'muted' : 'speaker',
        () => action('muteTab', { id: tab.id }),
        'audio-button',
      ),
    );
  row.append(
    button(`Close ${tab.title || 'New tab'}`, 'close', () => closeTab(tab.id), 'close-tab'),
  );
  let toggleOnClick;
  row.addEventListener('pointerdown', (event) => {
    if (event.button === 0)
      toggleOnClick = event.target.closest('button') ? undefined : canToggleTabChildren();
  });
  row.addEventListener('pointercancel', () => {
    toggleOnClick = undefined;
  });
  row.addEventListener('click', (event) => {
    if (!event.target.closest('button')) {
      const toggleChildren = (toggleOnClick ?? true) && canToggleTabChildren();
      toggleOnClick = undefined;
      windowFocusedAt = -Infinity;
      action('clickTab', { id: tab.id, toggleChildren }).then((next) => {
        // A focus notification caused by this activation can arrive after click.
        if (next && !toggleChildren && windowFocused) windowFocusedAt = -Infinity;
      });
    }
  });
  closeOnMiddleClick(row, tab.id);
  return row;
}

function tabNode(tab, query, ancestorMatch = false) {
  const stats = index.tabStats.get(tab.id);
  const matchAll = ancestorMatch || stats.match;
  if (query && !matchAll && !stats.descendantMatch) return null;
  const expanded = Boolean(query) || !tab.collapsed;
  const { node, branch } = wrapperFor('tab', tab.id);
  node.classList.toggle('tab-parent', stats.descendants > 0);
  const row = markSelected(
    rowCache.get(
      `tab:${tab.id}`,
      [...rowValues(tab), state.look.domains, expanded, stats.descendants, stats.active],
      () => createTabRow(tab, expanded, stats),
    ),
  );
  if (stats.descendants && expanded) {
    const nodes = (index.children.get(tab.id) || [])
      .map((child) => tabNode(child, query, matchAll))
      .filter(Boolean);
    reconcileChildren(branch, nodes);
    reconcileChildren(node, [row, branch]);
  } else {
    branch.replaceChildren();
    reconcileChildren(node, [row]);
  }
  return node;
}

function newTabItem(groupId) {
  const group = groupById(state, groupId);
  const label = group ? `New tab in ${group.name}` : 'New tab';
  const key = `new-tab:${groupId}`;
  return rowCache.get(key, [label], () => {
    const item = el('div', 'new-tab-item');
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-label', label);
    const add = button(label, null, () => blankAreaAction('newTab', { groupId }), 'new-tab-action');
    add.dataset.key = key;
    const slot = el('span', 'icon-slot');
    slot.append(icon('plus'));
    add.append(slot);
    add.addEventListener('contextmenu', (event) => newTabMenu(event, groupId));
    add.addEventListener('keydown', (event) => {
      if (newTabMenu(event, groupId) || moveTreeFocus(event, add)) return;
      if (event.key === 'ArrowLeft' && !event.altKey) {
        event.preventDefault();
        const groupRow = tree.querySelector(`[data-key="group:${groupId}"]`);
        if (groupRow) selectRow(groupRow);
        else parent();
      }
    });
    item.append(add);
    dropTarget(item, 'inside', groupId);
    return item;
  });
}

function fillChildren(container, parentId, query, ancestorMatch = false) {
  const groups = (index.groupChildren.get(parentId) || [])
    .map((group) => groupNode(group, query, ancestorMatch))
    .filter(Boolean);
  const tabs = (index.roots.get(parentId) || [])
    .map((tab) => tabNode(tab, query, ancestorMatch))
    .filter(Boolean);
  reconcileChildren(container, [...groups, ...tabs, ...(!query ? [newTabItem(parentId)] : [])]);
}

function updateTreeToggle(query) {
  const toggle = $('tree-toggle');
  const branches = scopeBranches(index, state.view);
  const hasBranches = branches.groupIds.size > 0 || branches.tabs.length > 0;
  const scope = groupById(state, state.view.scopeId)?.name || 'Home';
  const label = hasBranches
    ? `${branches.expanded ? 'Collapse' : 'Expand'} all in ${scope}`
    : 'Expand or collapse groups and tabs';
  toggle.disabled = changingTree || Boolean(query) || !hasBranches;
  setAttribute(toggle, 'aria-label', label);
  setAttribute(toggle, 'aria-busy', String(changingTree));
  toggle.title = query
    ? 'Clear search to expand or collapse groups and tabs'
    : hasBranches
      ? `${label} — groups and nested tabs`
      : 'Nothing to expand or collapse here';
  const iconName = branches.expanded ? 'fold' : 'collapse';
  if (toggle.dataset.icon !== iconName) {
    toggle.dataset.icon = iconName;
    toggle.replaceChildren(icon(iconName));
  }
}

function layoutBreadcrumbs() {
  const path = $('group-path');
  const pathMenuOpen = !$('menu').hidden && $('menu').classList.contains('path-menu');
  const focused = pathMenuOpen ? menuReturnFocus : document.activeElement;
  const pathHadFocus = path.contains(focused);
  if (pathMenuOpen) closeMenu();

  // Measure the complete, untruncated path. Only resize/path changes do this;
  // ordinary tab updates keep the current breadcrumb nodes and focus intact.
  path.classList.add('measure-path');
  reconcileChildren(path, breadcrumbItems.flat());
  const collapsed = breadcrumbItems.length > 1 && path.scrollWidth > path.clientWidth;
  if (collapsed)
    reconcileChildren(path, [pathOverflowSeparator, pathOverflow, ...breadcrumbItems.at(-1)]);
  path.classList.remove('measure-path');
  path.scrollLeft = 0;

  if (!searchOpen && (pathHadFocus || pathMenuOpen)) {
    const target = path.contains(focused)
      ? focused
      : collapsed
        ? pathOverflow
        : $('scope-heading') || $('home');
    target.focus({ preventScroll: true });
  }
}

function folderMenuItem(group, depth) {
  return {
    label: group.name,
    depth,
    current: group.id === state.view.scopeId,

    run: async () => {
      if (group.id !== state.view.scopeId) await enter(group.id);
      ($('scope-heading') || $('home')).focus({ preventScroll: true });
    },
  };
}

function togglePathMenu() {
  if (!state) return;
  if (pathOverflow.getAttribute('aria-expanded') === 'true') {
    closeMenu(true);
    return;
  }
  const path = [{ id: null, name: 'Home' }, ...groupPath(state, state.view.scopeId)];
  const rect = pathOverflow.getBoundingClientRect();
  menu(path.map(folderMenuItem), rect.left, rect.bottom + 8, { path: true, trigger: pathOverflow });
  pathOverflow.setAttribute('aria-expanded', 'true');
}

function folderHierarchyKey() {
  return JSON.stringify(state.groups.map(({ id, parentId, name }) => [id, parentId, name]));
}

function toggleFolderMenu(trigger, parentId) {
  if (!state) return;
  if (trigger.getAttribute('aria-expanded') === 'true') {
    closeMenu(true);
    return;
  }
  const items = [];
  const pending = (index.groupChildren.get(parentId) || [])
    .map((group) => ({ group, depth: 0 }))
    .reverse();
  while (pending.length) {
    const { group, depth } = pending.pop();
    items.push(folderMenuItem(group, depth));
    const children = index.groupChildren.get(group.id) || [];
    for (let i = children.length - 1; i >= 0; i--)
      pending.push({ group: children[i], depth: depth + 1 });
  }
  const parentName = groupById(state, parentId)?.name || 'Home';
  const rect = trigger.getBoundingClientRect();
  menu(items, rect.left, rect.bottom + 8, {
    path: true,
    label: `Groups in ${parentName}`,
    trigger,
  });
  trigger.setAttribute('aria-expanded', 'true');
  folderMenuKey = folderHierarchyKey();
}

function render() {
  if (!state) return;
  document.documentElement.dataset.colorScheme = state.look.colorScheme;
  $('new-tab').disabled = false;
  $('new-group').disabled = false;
  $('recently-closed-toggle').disabled = false;
  // A refresh may finish after dragstart. Keep the source/targets in the DOM
  // until dragend so native HTML drag-and-drop is not cancelled mid-gesture.
  if (drag || pointerHeld) {
    renderPending = true;
    refreshAgain = true;
    return;
  }
  renderPending = false;
  recentlyClosed?.render();
  tree.classList.toggle('show-connecting-lines', state.look.connectingLines);
  tree.classList.toggle('show-domains', state.look.domains);
  previews?.hide();
  const focusedKey = document.activeElement?.closest('[data-key]')?.dataset.key;
  const scroll = tree.scrollTop;
  const scope = groupById(state, state.view.scopeId);
  const query = $('search').value.trim().toLowerCase();
  index = createTreeIndex(state, query);
  // Folder menus must not retain destinations renamed, moved or removed elsewhere.
  if (folderMenuKey && folderMenuKey !== folderHierarchyKey()) closeMenu(true);
  updateTreeToggle(query);
  treeTabs = index.tabs;
  audioInTabs = index.audio;
  audioInGroups = new Map([...index.groupStats].map(([id, stats]) => [id, stats.audio]));
  const pins = state.tabs.filter((tab) => tab.pinned).sort((a, b) => a.index - b.index);
  reconcileChildren($('pinned-tabs'), pins.map(pinnedTab));
  $('pinned-tabs').hidden = !pins.length;
  if (scope) $('home').removeAttribute('aria-current');
  else $('home').setAttribute('aria-current', 'location');
  const crumbs = groupPath(state, state.view.scopeId);
  const scopeContainer = scope && groupContainerDetails(scope);
  const scopeAudio = audioInGroups.get(scope?.id);
  const nextBreadcrumbKey = JSON.stringify([
    crumbs.map(({ id, name }) => [id, name]),
    scopeContainer,
    scopeAudio,
  ]);
  if (breadcrumbKey !== nextBreadcrumbKey) {
    breadcrumbKey = nextBreadcrumbKey;
    breadcrumbItems = crumbs.map((group, index) => {
      const crumb = button(group.name, null, () => enter(group.id), 'crumb');
      if (index === crumbs.length - 1) {
        // The current crumb also carries the former folder heading's metadata.
        crumb.id = 'scope-heading';
        crumb.setAttribute('aria-current', 'location');
        if (scopeContainer) crumb.title = `Default container: ${scopeContainer.name}`;
        crumb.append(el('span', 'crumb-label', group.name));
        if (scopeAudio) crumb.append(audioIndicator(playingLabel(scopeAudio, 'in this group')));
      } else crumb.append(el('span', 'crumb-label', group.name));
      dropTarget(crumb, 'inside', group.id);
      return [folderChevron(group.parentId, crumbs[index - 1]?.name || 'Home'), crumb];
    });
    layoutBreadcrumbs();
  }
  const active = state.tabs.find((tab) => tab.active);
  fillChildren(tree, state.view.scopeId, query);
  $('reveal').hidden =
    Boolean(query) ||
    !active ||
    active.pinned ||
    Boolean(tree.querySelector(`[data-key="tab:${active.id}"]`));
  if (query && !tree.querySelector('.row')) {
    const empty = el('div', 'empty-state');
    empty.setAttribute('role', 'none');
    empty.append(
      icon('search'),
      el('h2', '', 'Nothing found'),
      el('p', '', 'Try another name or website address.'),
    );
    tree.prepend(empty);
  }
  rowCache.finish();
  // Native closes or another sidebar can remove the row owning an open menu.
  if (!$('menu').hidden && menuReturnFocus && !menuReturnFocus.isConnected) closeMenu();
  for (const key of wrappers.keys()) if (!usedWrappers.has(key)) wrappers.delete(key);
  usedWrappers.clear();
  $('new-tab').title = scope ? `New tab in ${scope.name}` : 'New tab';
  tree.scrollTop = scroll;
  if (focusedKey)
    [...document.querySelectorAll('[data-key]')]
      .find((row) => row.dataset.key === focusedKey)
      ?.focus({ preventScroll: true });
}

function showSearch(show = true, { restoreFocus = true } = {}) {
  if (show || restoreFocus) cancelGroupClick();
  if (show) {
    closeMenu();
    previews?.hide();
  }
  searchOpen = show;
  $('navigation-capsule').classList.toggle('search-open', show);
  $('breadcrumbs').inert = show;
  $('breadcrumbs').setAttribute('aria-hidden', String(show));
  $('search-wrap').inert = !show;
  $('search-wrap').setAttribute('aria-hidden', String(!show));
  $('search-toggle').inert = show;
  $('search-toggle').setAttribute('aria-expanded', String(show));
  if (show) {
    $('search').focus();
    $('search').select();
  } else {
    $('search').value = '';
    render();
    if (restoreFocus) $('search-toggle').focus();
  }
}

function moveTreeFocus(event, row) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
  event.preventDefault();
  const rows = [...tree.querySelectorAll('.row, .new-tab-action')];
  const index = rows.indexOf(row);
  const next =
    event.key === 'Home'
      ? rows[0]
      : event.key === 'End'
        ? rows.at(-1)
        : rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) selectRow(next);
  return true;
}

function rowKey(event, row, kind, id) {
  cancelGroupClick();
  if (event.target !== row || moveTreeFocus(event, row)) return;
  const rows = [...tree.querySelectorAll('.row, .new-tab-action')];
  const index = rows.indexOf(row);
  const tab = kind === 'tab' ? treeTabs.find((tab) => tab.id === id) : null;
  const hasChildren = kind === 'group' || tabChildren(treeTabs, id).length > 0;
  const collapsed = kind === 'group' ? state.view.collapsed.includes(id) : tab?.collapsed;
  const toggle = () => action(kind === 'group' ? 'toggleGroup' : 'toggleTab', { id });
  if (event.key === 'Enter') {
    event.preventDefault();
    kind === 'group' ? enter(id) : action('activateTab', { id });
  } else if (event.key === ' ' && hasChildren) {
    event.preventDefault();
    toggle();
  } else if (event.key === 'ArrowRight' && hasChildren) {
    event.preventDefault();
    if (collapsed) toggle();
    else if (rows[index + 1]) selectRow(rows[index + 1]);
  } else if (event.key === 'ArrowLeft' && !event.altKey) {
    event.preventDefault();
    if (hasChildren && !collapsed) toggle();
    else {
      const parentKey =
        tab?.parentTabId != null
          ? `tab:${tab.parentTabId}`
          : `group:${kind === 'group' ? groupById(state, id)?.parentId : tab?.groupId}`;
      const parentRow = rows.find((item) => item.dataset.key === parentKey);
      if (parentRow) selectRow(parentRow);
      else parent();
    }
  } else if (event.key === 'F2' && kind === 'group') {
    event.preventDefault();
    renameDialog(id);
  } else if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    contextMenu(kind, id, rect.left + 30, rect.bottom);
  }
}

function closeMenu(restore = false) {
  recentlyClosed?.close(restore);
  $('menu').hidden = true;
  folderMenuKey = undefined;
  $('more').setAttribute('aria-expanded', 'false');
  pathOverflow.setAttribute('aria-expanded', 'false');
  if (menuReturnFocus?.matches('.crumb-children'))
    menuReturnFocus.setAttribute('aria-expanded', 'false');
  if (restore && menuReturnFocus?.isConnected) menuReturnFocus.focus();
}

async function openShortcutSettings() {
  if (demo) {
    announce('Install Tabernacle in Firefox to change its extension shortcuts.');
    return;
  }
  try {
    await browser.commands.openShortcutSettings();
  } catch {
    announce(
      'Could not open shortcut settings. Try Add-ons and themes → Manage Extension Shortcuts.',
      true,
    );
  }
}

async function openAbout() {
  try {
    // Only the browser preview fetches; installed extensions read their own manifest.
    const manifest = demo
      ? await fetch(new URL('../manifest.json', import.meta.url)).then((response) => {
          if (!response.ok) throw new Error('Could not load extension details.');
          return response.json();
        })
      : browser.runtime.getManifest();
    aboutDialog(manifest);
  } catch (error) {
    announce(error.message, true);
  }
}

function menu(
  items,
  x,
  y,
  {
    above = false,
    alignRight = false,
    path = false,
    label = path ? 'Full group path' : null,
    trigger = document.activeElement,
  } = {},
) {
  previews?.hide();
  closeMenu();
  menuReturnFocus = trigger;
  const container = $('menu');
  container.classList.toggle('path-menu', path);
  if (label) container.setAttribute('aria-label', label);
  else container.removeAttribute('aria-label');
  container.replaceChildren();
  container.hidden = false;
  items.forEach((item) => {
    if (!item) {
      container.append(el('hr'));
      return;
    }
    const node = button(
      item.label,
      item.icon,
      () => {
        closeMenu();
        item.run();
      },
      item.danger ? 'danger' : '',
    );
    node.setAttribute('role', 'menuitem');
    node.disabled = Boolean(item.disabled);
    if (path) {
      node.style.setProperty('--path-indent', `${Math.min(item.depth, 5) * 10}px`);
      node.classList.toggle('path-ancestor', item.depth > 0);
      node.append(el('span', 'path-label', item.label));
      if (item.current) {
        node.setAttribute('aria-current', 'location');
        node.append(icon('check'));
      }
    } else node.append(document.createTextNode(item.label));
    container.append(node);
  });
  container.style.maxHeight = above
    ? `${Math.max(0, y - 8)}px`
    : path
      ? `${Math.max(0, innerHeight - y - 8)}px`
      : '';
  const left = alignRight ? x - container.offsetWidth : x;
  const top = above ? y - container.offsetHeight : y;
  container.style.left = `${Math.max(8, Math.min(left, innerWidth - container.offsetWidth - 8))}px`;
  container.style.top = `${Math.max(8, Math.min(top, innerHeight - container.offsetHeight - 8))}px`;
  container.querySelector('button:enabled')?.focus();
}

async function blankAreaAction(type, args = {}) {
  $('search').value = '';
  const next = await action(type, args);
  const id = next?.createdTabId ?? next?.restoredTabId ?? next?.tabs.find((tab) => tab.active)?.id;
  if (id !== undefined)
    tree.querySelector(`[data-key="tab:${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

function newTabMenu(event, groupId) {
  const keyboard = event.type === 'keydown';
  if (
    !state ||
    (keyboard && !(event.shiftKey && event.key === 'F10') && event.key !== 'ContextMenu')
  )
    return false;
  event.preventDefault();
  event.stopPropagation();
  cancelGroupClick();
  event.currentTarget.focus({ preventScroll: true });
  const rect = event.currentTarget.getBoundingClientRect();
  menu(
    [
      { label: 'New tab', icon: 'plus', run: () => blankAreaAction('newTab', { groupId }) },
      { label: 'New group…', icon: 'groupPlus', run: () => createDialog(groupId) },
    ],
    keyboard ? rect.left : event.clientX,
    keyboard ? rect.bottom : event.clientY,
  );
  return true;
}

function blankAreaMenu(x, y) {
  const groupId = state.view.scopeId;
  menu(
    [
      { label: 'New tab', icon: 'plus', run: () => blankAreaAction('newTab', { groupId }) },
      {
        label: 'New tab in container…',
        icon: 'container',
        run: () => newContainerDialog(groupId),
      },
      { label: 'New group…', icon: 'groupPlus', run: () => createDialog(groupId) },
      ...(groupId !== null
        ? [
            {
              label: 'Default container…',
              icon: 'container',
              run: () => groupContainerDialog(groupId),
            },
          ]
        : []),
      null,
      {
        label: 'Undo last closed tab',
        icon: 'undo',
        disabled: !state.canUndoClose,
        run: () => blankAreaAction('undoCloseTab'),
      },
      {
        label: 'Show current tab',
        icon: 'enter',
        disabled: !state.tabs.some((tab) => tab.active),
        run: () => blankAreaAction('revealActive'),
      },
      null,
      {
        label: 'Expand all groups',
        icon: 'group',
        disabled: !state.groups.length,
        run: () => action('collapseAll', { collapsed: false }),
      },
      {
        label: 'Collapse all groups',
        icon: 'collapse',
        disabled: !state.groups.length,
        run: () => action('collapseAll', { collapsed: true }),
      },
    ],
    x,
    y,
  );
}

function isBlankArea(target) {
  return (
    state &&
    !drag &&
    (target === tree || (target.closest('.empty-state') && !target.closest('button, a, input')))
  );
}

tree.addEventListener('dblclick', (event) => {
  if (event.button !== 0 || !isBlankArea(event.target)) return;
  event.preventDefault();
  blankAreaAction('newTab', { groupId: state.view.scopeId });
});
tree.addEventListener('contextmenu', (event) => {
  if (!isBlankArea(event.target)) return;
  event.preventDefault();
  tree.focus({ preventScroll: true });
  blankAreaMenu(event.clientX, event.clientY);
});
tree.addEventListener('keydown', (event) => {
  if (event.target !== tree || !state) return;
  if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
    event.preventDefault();
    const rect = tree.getBoundingClientRect();
    blankAreaMenu(rect.left + 12, rect.top + 12);
  }
});

async function copyUrls(kind, id) {
  const tabs =
    kind === 'group'
      ? sortTabs(state.tabs.filter((tab) => isWithin(state, tab.groupId, id)))
      : state.tabs.filter((tab) => tab.id === id);
  const urls = tabs.map((tab) => tab.url).filter((url) => typeof url === 'string' && url.trim());
  if (!urls.length) {
    announce(kind === 'group' ? 'No URLs to copy in this group.' : 'This tab has no URL to copy.');
    return;
  }
  try {
    // Keep this call in the menu's user gesture; no clipboard permissions or reads are needed.
    await navigator.clipboard.writeText(urls.join('\n'));
    announce(urls.length === 1 ? 'URL copied.' : `${urls.length} URLs copied.`);
  } catch {
    announce('Could not copy to the clipboard. Please try again.', true);
  }
}

function contextMenu(kind, id, x, y) {
  if (kind === 'group')
    menu(
      [
        { label: 'Go into group', icon: 'enter', run: () => enter(id) },
        {
          label: 'New tab here',
          icon: 'plus',
          run: () => action('newTab', { groupId: id }),
        },
        {
          label: 'New subgroup',
          icon: 'groupPlus',
          run: () => createDialog(id),
        },
        null,
        { label: 'Copy URLs', icon: 'copy', run: () => copyUrls(kind, id) },
        { label: 'Rename group', icon: 'rename', run: () => renameDialog(id) },
        { label: 'Default container…', icon: 'container', run: () => groupContainerDialog(id) },
        {
          label: 'Move group…',
          icon: 'group',
          run: () => moveDialog(kind, id),
        },
        {
          label: 'Move contents…',
          icon: 'group',
          run: () => moveDialog('contents', id),
        },
        null,
        {
          label: 'Close all tabs…',
          icon: 'close',
          run: () => closeGroupTabsDialog(id),
          disabled: !state.tabs.some((tab) => isWithin(state, tab.groupId, id)),
          danger: true,
        },
        {
          label: 'Delete group…',
          icon: 'trash',
          run: () => removeDialog(id),
          danger: true,
        },
      ],
      x,
      y,
    );
  else {
    const tab = state.tabs.find((tab) => tab.id === id);
    if (!tab) return;
    menu(
      [
        { label: 'New child tab', icon: 'plus', run: () => action('newChildTab', { id }) },
        ...(tab.parentTabId !== null
          ? [{ label: 'Detach from parent', icon: 'back', run: () => action('detachTab', { id }) }]
          : []),
        ...(!tab.pinned && tabChildren(treeTabs, id).length
          ? [
              {
                label: tab.collapsed ? 'Expand child tabs' : 'Collapse child tabs',
                icon: 'collapse',
                run: () => action('toggleTab', { id }),
              },
            ]
          : []),
        null,
        {
          label: 'Move to group…',
          icon: 'group',
          run: () => moveDialog(kind, id),
        },
        {
          label: 'Reopen in container…',
          icon: 'container',
          run: () => containerDialog(id),
        },
        {
          label: tab.pinned ? 'Unpin tab' : 'Pin tab',
          icon: 'pin',
          run: () => action('pinTab', { id }),
        },
        {
          label: tab.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab',
          icon: 'speaker',
          run: () => action('muteTab', { id }),
        },
        { label: 'Copy URL', icon: 'copy', run: () => copyUrls(kind, id) },
        {
          label: 'Duplicate tab',
          icon: 'copy',
          run: () => action('duplicateTab', { id }),
        },
        null,
        {
          label: tabSubtree(state.tabs, id).length > 1 ? 'Close tab and nested tabs…' : 'Close tab',
          icon: 'close',
          run: () => closeTab(id),
        },
      ],
      x,
      y,
    );
  }
}

function clearDrops() {
  document
    .querySelectorAll('.drop-before,.drop-after,.drop-inside')
    .forEach((node) => node.classList.remove('drop-before', 'drop-after', 'drop-inside'));
}

function pinnedDropPosition(event) {
  const pins = [...$('pinned-tabs').querySelectorAll('.pinned-tab')];
  for (const [index, node] of pins.entries()) {
    const rect = node.getBoundingClientRect();
    if (event.clientY < rect.top || (event.clientY <= rect.bottom && event.clientX < rect.right)) {
      const after = event.clientY >= rect.top && event.clientX >= rect.left + rect.width / 2;
      const before = after ? pins[index + 1] : node;
      return {
        node: before || node,
        after: !before,
        beforeId: before ? Number(before.dataset.key.slice(4)) : null,
      };
    }
  }
  return { node: pins.at(-1), after: true, beforeId: null };
}

$('pinned-tabs').addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('application/x-tabernacle-pin')) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  clearDrops();
  const { node, after } = pinnedDropPosition(event);
  if (!node) return;
  const shelf = $('pinned-tabs');
  const bounds = shelf.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const previous = node.previousElementSibling?.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(shelf).columnGap);
  const x = after
    ? rect.right + gap / 2
    : previous?.top === rect.top
      ? (previous.right + rect.left) / 2
      : rect.left;
  // One marker per insertion slot, centered in its gap and visible at row edges.
  const markerX = Math.max(bounds.left + 1, Math.min(x, bounds.left + shelf.clientWidth - 1));
  node.style.setProperty('--pin-drop-x', `${markerX - rect.left - node.clientLeft}px`);
  node.classList.add(after ? 'drop-after' : 'drop-before');
});
$('pinned-tabs').addEventListener('dragleave', (event) => {
  if (!$('pinned-tabs').contains(event.relatedTarget)) clearDrops();
});
$('pinned-tabs').addEventListener('drop', async (event) => {
  if (!event.dataTransfer.types.includes('application/x-tabernacle-pin')) return;
  event.preventDefault();
  event.stopPropagation();
  clearDrops();
  let source;
  try {
    source = JSON.parse(event.dataTransfer.getData('application/x-tabernacle-pin'));
  } catch {
    return;
  }
  if (source?.kind !== 'pin' || !Number.isInteger(source.id)) return;
  if (source.windowId !== windowId) {
    announce('Move tabs between windows in Firefox first.', true);
    return;
  }
  const { beforeId } = pinnedDropPosition(event);
  drag = null;
  pointerHeld = false;
  await action('movePinnedTab', { id: source.id, beforeId });
});

function dropPosition(event, node, kind) {
  if (kind === 'inside') return 'inside';
  const rect = node.getBoundingClientRect(),
    fraction = (event.clientY - rect.top) / rect.height;
  return (kind === 'group' || kind === 'tab') && fraction > 0.25 && fraction < 0.75
    ? 'inside'
    : fraction < 0.5
      ? 'before'
      : 'after';
}

function dropTarget(node, kind, id) {
  node.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('application/x-tabernacle')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    clearDrops();
    node.classList.add(`drop-${dropPosition(event, node, kind)}`);
  });
  node.addEventListener('dragleave', (event) => {
    if (!node.contains(event.relatedTarget)) clearDrops();
  });
  node.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearDrops();
    let source;
    try {
      source = JSON.parse(event.dataTransfer.getData('application/x-tabernacle'));
    } catch {
      return;
    }
    drag = null;
    if (source.windowId !== windowId) {
      announce('Move tabs between windows in Firefox first.', true);
      return;
    }
    if (!['tab', 'group'].includes(source.kind)) return;
    const position = dropPosition(event, node, kind);
    if (source.kind === kind && source.id === id) return;
    if (kind === 'tab' && position === 'inside') {
      if (source.kind !== 'tab') {
        announce('Groups cannot be nested under tabs. Drop onto a group or Home instead.', true);
        return;
      }
      await action('nestTab', { id: source.id, parentTabId: id });
      return;
    }
    let parentId,
      parentTabId = null,
      beforeId = null;
    if (kind === 'inside' || position === 'inside') parentId = id;
    else if (kind === 'group') {
      const target = groupById(state, id);
      if (!target) return;
      parentId = target.parentId;
      if (source.kind === 'group') {
        const siblings = children(state, parentId);
        beforeId =
          position === 'before' ? id : (siblings[siblings.indexOf(target) + 1]?.id ?? null);
      }
    } else {
      const target = treeTabs.find((tab) => tab.id === id);
      if (!target) return;
      parentId = target.groupId;
      if (source.kind === 'tab') {
        parentTabId = target.parentTabId;
        const siblings = sortTabs(
          treeTabs.filter((tab) => tab.groupId === parentId && tab.parentTabId === parentTabId),
        );
        beforeId =
          position === 'before'
            ? id
            : (siblings[siblings.findIndex((tab) => tab.id === id) + 1]?.id ?? null);
      }
    }
    await action(
      source.kind === 'group' ? 'moveGroup' : 'moveTab',
      source.kind === 'group'
        ? { id: source.id, parentId, beforeId }
        : { id: source.id, groupId: parentId, parentTabId, beforeId },
    );
  });
}

$('home').append(icon('home'));
$('search-toggle').append(icon('search'));
$('more').append(icon('more'));
$('search-close').append(icon('close'));
$('dialog-icon').append(icon('groupPlus'));
$('new-tab').append(icon('plus'));
$('new-group').append(icon('groupPlus'));
recentlyClosed = createRecentlyClosed({
  trigger: $('recently-closed-toggle'),
  getState: () => state,
  favicon: tabFavicon,
  restore: (sessionId) => blankAreaAction('restoreClosedTab', { sessionId }),

  beforeOpen() {
    previews?.hide();
    closeMenu();
    renderPending = true;
    scheduleRefresh();
  },
});
$('home').addEventListener('click', () => enter(null));
$('search-toggle').addEventListener('click', () => showSearch());
$('search-close').addEventListener('click', () => showSearch(false));
$('navigation-capsule').addEventListener('click', (event) => {
  if (searchOpen || event.defaultPrevented || event.target.closest('button, input, svg')) return;
  showSearch();
});
new ResizeObserver(layoutBreadcrumbs).observe($('group-path'));
document.fonts.ready.then(layoutBreadcrumbs);
window.addEventListener('resize', () => {
  if (!$('menu').hidden && $('menu').classList.contains('path-menu')) closeMenu(true);
});
let searchFrame;
$('search').addEventListener('input', () => {
  if (searchFrame) return;
  searchFrame = requestAnimationFrame(() => {
    searchFrame = null;
    render();
  });
});
$('reveal').addEventListener('click', () => action('revealActive'));
$('new-tab').addEventListener('click', () => action('newTab', { groupId: state.view.scopeId }));
$('new-tab').addEventListener('contextmenu', (event) => newTabMenu(event, state?.view.scopeId));
$('new-tab').addEventListener('keydown', (event) => newTabMenu(event, state?.view.scopeId));
$('new-group').addEventListener('click', () => createDialog());
$('tree-toggle').addEventListener('click', async () => {
  if (!state || changingTree || $('search').value.trim()) return;
  const branches = scopeBranches(index, state.view);
  if (!branches.groupIds.size && !branches.tabs.length) return;
  const restoreFocus = document.activeElement === $('tree-toggle');
  changingTree = true;
  updateTreeToggle('');
  const next = await action('collapseTree', {
    scopeId: state.view.scopeId,
    collapsed: branches.expanded,
  });
  // Session APIs can fail partway through a bulk save. Re-read actual state so
  // the next click can retry instead of displaying an outdated tree.
  if (!next) {
    renderPending = true;
    await refresh();
  }
  changingTree = false;
  render();
  if (restoreFocus && document.activeElement === document.body)
    $('tree-toggle').focus({ preventScroll: true });
});
$('more').addEventListener('click', () => {
  if (!state) return;
  if ($('more').getAttribute('aria-expanded') === 'true') {
    closeMenu(true);
    return;
  }
  const rect = $('more').getBoundingClientRect();
  menu(
    [
      {
        label: 'Expand all groups',
        icon: 'group',
        run: () => action('collapseAll', { collapsed: false }),
      },
      {
        label: 'Collapse all groups',
        icon: 'collapse',
        run: () => action('collapseAll', { collapsed: true }),
      },
      null,
      { label: 'Recently closed', icon: 'history', run: () => recentlyClosed.open() },
      null,
      { label: 'Appearance', icon: 'list', run: () => lookDialog() },
      null,
      { label: 'New container…', icon: 'plus', run: () => createContainerDialog() },
      { label: 'Manage containers…', icon: 'container', run: () => manageContainersDialog() },
      null,
      { label: 'Extension shortcuts…', icon: 'keyboard', run: openShortcutSettings },
      { label: 'About', icon: 'info', run: openAbout },
    ],
    rect.right,
    rect.top - 8,
    { above: true, alignRight: true },
  );
  $('more').setAttribute('aria-expanded', 'true');
});
document.addEventListener('pointerdown', (event) => {
  const dismissSearch = searchOpen && !$('navigation-capsule').contains(event.target);
  // Clearing the filter must not move or replace a target before its click.
  if (event.target.closest('.row, .pinned-tab, .recently-closed-row') || dismissSearch)
    pointerHeld = true;
  if (dismissSearch) {
    showSearch(false, { restoreFocus: false });
    if (state) updateTreeToggle('');
  }
  if (
    !$('menu').contains(event.target) &&
    !$('more').contains(event.target) &&
    !$('recently-closed-toggle').contains(event.target) &&
    !$('recently-closed').contains(event.target) &&
    !pathOverflow.contains(event.target) &&
    !event.target.closest('.crumb-children')
  )
    closeMenu();
});
document.addEventListener(
  'click',
  (event) => {
    if (!searchOpen || $('navigation-capsule').contains(event.target)) return;
    // Keyboard and assistive clicks have no pointerdown. Let the control act
    // before rendering the unfiltered tree, including buttons that stop bubbling.
    setTimeout(() => {
      if (searchOpen) showSearch(false, { restoreFocus: false });
    }, 0);
  },
  true,
);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    pointerHeld = false;
    if ((renderPending || refreshAgain) && !drag) scheduleRefresh();
  });
}
document.addEventListener('keydown', (event) => {
  if ($('dialog').open) return;
  if (!$('menu').hidden) {
    const buttons = [...$('menu').querySelectorAll('button:enabled')],
      index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      ]?.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? buttons[0] : buttons.at(-1))?.focus();
      return;
    }
    if (event.key === 'Tab') closeMenu($('menu').classList.contains('path-menu'));
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    showSearch();
  }
  if (event.key === 'Escape' && searchOpen) {
    event.preventDefault();
    showSearch(false);
  }
  if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    parent();
  }
});
dropTarget($('home'), 'inside', null);

async function start() {
  if (demo) {
    const { createDemo } = await import('../../preview/demo.js');
    const controller = await createDemo(scheduleRefresh);
    windowId = 1;
    request = (type, args = {}) => controller.request({ type, windowId, ...args });
  } else if (globalThis.browser?.runtime?.id) {
    const currentWindow = await browser.windows.getCurrent();
    windowId = currentWindow.id;
    windowFocused = Boolean(currentWindow.focused);
    browser.windows.onFocusChanged?.addListener((id) => {
      const focused = id === windowId;
      if (focused && !windowFocused) windowFocusedAt = performance.now();
      windowFocused = focused;
    });
    request = async (type, args = {}) => {
      const result = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!result?.ok)
        throw new Error(
          result?.error || 'Tabernacle could not connect. Try reopening the sidebar.',
        );
      return result.data;
    };
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === 'tabernacle:changed') scheduleRefresh(message);
    });
  } else
    throw new Error('Load Tabernacle as a Firefox extension, or open the interactive preview.');
  previews = createTabPreviews({
    getBottom: () => tree.getBoundingClientRect().bottom,

    getTab: (id) => {
      const tab = state?.tabs.find((tab) => tab.id === id);
      return tab && { ...tab, audioDescription: audioDescription(tab) };
    },

    canShow: () =>
      !drag && !pointerHeld && $('menu').hidden && !recentlyClosed.isOpen() && !$('dialog').open,
  });
  await refresh();
}

start().catch((error) => {
  tree.replaceChildren(el('p', 'loading', error.message));
});
