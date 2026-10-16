import { observeTheme } from './theme-observer.js';
import { resolveTheme, createPaletteRenderer } from './theme-palette.js';
import { icon } from './icons.js';
import { createTreeIndex, scopeBranches } from './tree-index.js';
import { createRowCache, reconcileChildren, setAttribute } from './dom.js';
import { createTreeMotion } from './tree-motion.js';
import { createDialogs } from './dialogs.js';
import { folderIcon, folderIconColor } from './folder-icons.js';
import { folderAppearance } from './folder-appearance.js';
import { pinActionLabels } from './pinned-items.js';
import { createPointerMove } from './pointer-move.js';
import { createRecentActivity } from './recently-closed.js';
import { createActivityLauncher } from './activity-launcher.js';
import { openDemoPage } from './internal-pages.js';
import { groupById, groupPath, isWithin, sortTabs, tabChildren, tabSubtree } from './model.js';

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
let recentlyClosed;
let themeObserver;
const paintPalette = createPaletteRenderer(document.documentElement);
const forcedColors = matchMedia('(forced-colors: active)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const treeMotion = createTreeMotion(
  tree,
  () => state?.look.animations !== false && !reducedMotion.matches,
);
let motionContext;

function themeResult(source = state?.look?.themeSource) {
  return resolveTheme(
    { themeSource: source },
    themeObserver?.snapshot || {},
    themeObserver?.dark || false,
  );
}

function renderAppearance() {
  if (!state) return;
  const result = themeResult();
  paintPalette(forcedColors.matches ? null : result.palette, state.look.colorScheme);
  const motionOff = state.look.animations === false || reducedMotion.matches;
  document.documentElement.classList.toggle('motion-off', motionOff);
  if (motionOff) treeMotion.finishAll();
}

forcedColors.addEventListener('change', renderAppearance);
reducedMotion.addEventListener('change', renderAppearance);
let state, request, windowId, selected, drag, refreshTimer, toastTimer, menuReturnFocus;
let confirmedState;
let pointerMoves;
let movingItem = false;
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
    `Show folders in ${parentName}`,
    'chevron',
    (event) => toggleFolderMenu(event.currentTarget, parentId),
    'crumb-children',
  );
}

const pathOverflow = breadcrumbMenuButton(
  'Show full folder path',
  'more',
  togglePathMenu,
  'crumb crumb-overflow',
);
pathOverflow.id = 'path-overflow';
const pathOverflowSeparator = folderChevron(null, 'Home');
const homeLabel = el('span', 'crumb-label', 'Home');

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
  appearanceDialog,
  pinFolderDialog,
  removeDialog,
  closeGroupTabsDialog,
  closeTabTreeDialog,
  moveDialog,
  containerDialog,
  newContainerDialog,
  groupContainerDialog,
} = createDialogs({
  getState: () => state,
  request: (...args) => (args[0] === 'moveItem' ? requestMove(args[1]) : request(...args)),
  closeMenu,
  onMove: moveFeedback,

  onChange(next, key) {
    acceptState(next);
    if (key) selected = key;
    if (key?.startsWith('tab:')) $('search').value = '';
    render();
  },
});

async function requestMove(args) {
  try {
    return await request('moveItem', args);
  } catch (error) {
    // A write may have committed before a response/snapshot failed. Only retry
    // a confirmed receipt, using the same operation identity.
    const receipt = await request('moveStatus').catch(() => null);
    if (receipt?.operationId === args.operationId) return request('moveItem', args);
    throw error;
  }
}

function action(type, args = {}) {
  const motionKey =
    type === 'toggleGroup'
      ? `group:${args.id}`
      : type === 'toggleTab' || (type === 'clickTab' && args.toggleChildren !== false)
        ? `tab:${args.id}`
        : null;
  if (!motionKey) treeMotion.finishAll();
  const viewAction = ['toggleGroup', 'enterGroup'].includes(type) ? { type, args } : null;
  if (viewAction) {
    pendingViewActions.push(viewAction);
    acceptState(confirmedState);
    render(motionKey);
  }
  activeActions++;

  const finishViewAction = () => {
    if (viewAction) pendingViewActions.splice(pendingViewActions.indexOf(viewAction), 1);
  };

  const result = actionQueue.then(async () => {
    try {
      const next = await (type === 'moveItem' ? requestMove(args) : request(type, args));
      finishViewAction();
      acceptState(next);
      render(viewAction ? null : motionKey);
      return state;
    } catch (error) {
      finishViewAction();
      try {
        acceptState(await request('snapshot'));
      } catch {
        acceptState(confirmedState);
      }
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
  if (pointerHeld || activeActions) {
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
    if (refreshAgain) {
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

async function revealFolder(id) {
  cancelGroupClick();
  if (searchOpen) showSearch(false, { restoreFocus: false });
  $('search').value = '';
  const next = await action('revealGroup', { id });
  if (!next) return;
  const row = tree.querySelector(`[data-key="group:${CSS.escape(id)}"]`);
  if (row) {
    selectRow(row);
    row.scrollIntoView({ block: 'nearest' });
  }
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
  row.draggable = false;
  row.classList.toggle('selected', selected === row.dataset.key);
  row.addEventListener('click', () => selectRow(row));
  row.addEventListener('contextmenu', (event) => {
    cancelGroupClick();
    event.preventDefault();
    selectRow(row);
    contextMenu(kind, id, event.clientX, event.clientY);
  });
  row.addEventListener('keydown', (event) => rowKey(event, row, kind, id));
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
  marker.append(icon(`${iconName}Small`));
  return marker;
}

function describeAudio(node, description) {
  if (!description) return;
  if (node.hasAttribute('title')) node.title += `\n${description}`;
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
  row.title = `${group.name}\nClick to expand/collapse · Double-click to open · Right-click for options`;
  describeContainer(row, { container }, 'Default container');
  const playing = audioInGroups.get(group.id) || 0;
  const audio = playingLabel(playing, 'in this folder');
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
  const total = el('span', 'group-count', String(count(group.id)));
  total.setAttribute('aria-hidden', 'true');
  row.append(
    disclosure,
    el('span', 'label', group.name),
    ...(playing ? [audioIndicator(audio)] : []),
    total,
    icon('chevron', 'group-chevron'),
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
  const appearance = folderAppearance(group, container, state);
  const color = folderIconColor(appearance.color) || 'var(--folder-icon)';
  node.style.setProperty('--item-colour', color);
  branch.style.setProperty('--parent-guide', color);
  const row = markSelected(
    rowCache.get(
      `group:${group.id}`,
      [
        group.name,
        group.appearance?.icon,
        group.defaultCookieStoreId,
        appearance.color,
        count(group.id),
        audioInGroups.get(group.id) || 0,
        container?.name,
        container?.colorCode,
        container?.icon,
        container?.iconUrl,
      ],
      () => createGroupRow(group, container),
    ),
  );
  const expanded = Boolean(query) || !state.view.collapsed.includes(group.id);
  setAttribute(row, 'aria-expanded', expanded);
  const disclosure = row.querySelector('.disclosure');
  const label = `${expanded ? 'Collapse' : 'Expand'} ${group.name}`;
  if (disclosure.getAttribute('aria-expanded') !== String(expanded))
    disclosure.replaceChildren(
      folderIcon(group, container, { className: 'group', expanded, state }),
    );
  setAttribute(disclosure, 'aria-expanded', expanded);
  setAttribute(disclosure, 'aria-label', label);
  setAttribute(disclosure, 'title', label);
  treeMotion.reconcile(node, row, branch, expanded, () => {
    const matchAll = ancestorMatch || (Boolean(query) && group.name.toLowerCase().includes(query));
    fillChildren(branch, group.id, query, matchAll);
    if (!branch.childElementCount) {
      const empty = el('div', 'empty-child', 'Drop tabs here');
      empty.setAttribute('role', 'none');
      dropTarget(empty, 'inside', group.id);
      branch.append(empty);
    }
  });
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
  return favicon;
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
    icon: identity?.icon,
    iconUrl: identity?.iconUrl,
  };
}

function describeContainer(node, { container }, label = 'Container') {
  if (!container) return;
  const name = container.name || 'Unnamed container';
  if (node.hasAttribute('title')) node.title += `\n${label}: ${name}`;
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

function pinnedDrag(node, item) {
  node.dataset.pinKind = item.kind;
  node.dataset.pinId = item.id;
  node.draggable = false;
}

function pinnedMenu(node, kind, id) {
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    node.focus();
    contextMenu(kind, id, event.clientX, event.clientY);
  });
  node.addEventListener('keydown', (event) => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      contextMenu(kind, id, rect.left, rect.bottom);
    }
  });
}

function createPinnedTab(tab) {
  const label = `${tab.title || 'New tab'}, pinned`;
  const node = button(label, null, () => action('activateTab', { id: tab.id }), 'pinned-tab');
  node.dataset.key = `tab:${tab.id}`;
  node.removeAttribute('title');
  node.setAttribute('aria-pressed', String(Boolean(tab.active)));
  node.classList.toggle('active', Boolean(tab.active));
  pinnedDrag(node, { kind: 'tab', id: tab.treeId });
  node.append(tabFavicon(tab));
  describeContainer(node, tab);
  const audio = audioDescription(tab);
  describeAudio(node, audio);
  if (audio) node.append(audioIndicator(audio, audioInTabs.get(tab.id) ? 'speaker' : 'muted'));
  pinnedMenu(node, 'tab', tab.id);
  closeOnMiddleClick(node, tab.id);
  return node;
}

function pinnedFolder(pin) {
  const group = groupById(state, pin.id);
  const container = groupContainerDetails(group);
  const appearance = folderAppearance(group, container, state);
  const path = groupPath(state, group.id)
    .map((item) => item.name)
    .join(' / ');
  const current = group.id === state.view.scopeId;
  return rowCache.get(
    `pin:group:${group.id}`,
    [
      path,
      pin.action,
      current,
      appearance.icon,
      appearance.color,
      group.defaultCookieStoreId,
      container?.iconUrl,
      container?.icon,
    ],
    () => {
      const node = button(
        `${path}, pinned folder, ${pinActionLabels[pin.action]}`,
        null,
        () => {
          const current = state.folderPins.find((item) => item.id === group.id);
          if (current) current.action === 'reveal' ? revealFolder(group.id) : enter(group.id);
        },
        'pinned-tab pinned-folder',
      );
      node.title = `${path}\n${pinActionLabels[pin.action]} · Right-click for options`;
      node.dataset.key = `pin:group:${group.id}`;
      node.classList.toggle('active', current);
      if (current) node.setAttribute('aria-current', 'location');
      node.append(folderIcon(group, container, { state }));
      pinnedDrag(node, { kind: 'group', id: group.id });
      pinnedMenu(node, 'group', group.id);
      return node;
    },
  );
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
  describeContainer(row, tab);
  describeAudio(row, audioDescription(tab));
  if (stats.descendants) {
    row.setAttribute('aria-expanded', String(expanded));
    const count = `${stats.descendants} nested ${stats.descendants === 1 ? 'tab' : 'tabs'}`;
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
    badge.append(icon(expanded ? 'subtractCircle' : 'addCircle'));
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
        tab.mutedInfo?.muted ? 'mutedSmall' : 'speakerSmall',
        () => action('muteTab', { id: tab.id }),
        'audio-button',
      ),
    );
  row.append(
    button(`Close ${tab.title || 'New tab'}`, 'closeSmall', () => closeTab(tab.id), 'close-tab'),
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
  // Nested tab guides show structure without repeating container identity.
  branch.style.setProperty('--parent-guide', 'var(--neutral-marker)');
  node.classList.toggle('tab-parent', stats.descendants > 0);
  const row = markSelected(
    rowCache.get(
      `tab:${tab.id}`,
      [...rowValues(tab), state.look.domains, expanded, stats.descendants, stats.active],
      () => createTabRow(tab, expanded, stats),
    ),
  );
  treeMotion.reconcile(node, row, branch, Boolean(stats.descendants && expanded), () => {
    const nodes = (index.children.get(tab.id) || [])
      .map((child) => tabNode(child, query, matchAll))
      .filter(Boolean);
    if (!query) nodes.push(newTabItem(tab.groupId, tab));
    reconcileChildren(branch, nodes);
  });
  return node;
}

function newTabItem(groupId, parentTab = null) {
  const group = groupById(state, groupId);
  const container = group && groupContainerDetails(group);
  const folderColor = group && folderAppearance(group, container, state).color;
  // Creation controls follow the folder, never an individual tab's container.
  const color = folderIconColor(folderColor) || 'var(--folder-icon)';
  const parentTabId = parentTab?.id ?? null;
  const label = parentTab
    ? `New child tab of ${parentTab.title || 'New tab'}`
    : group
      ? `New tab in ${group.name}`
      : 'New tab';
  const key = parentTab ? `new-child-tab:${parentTabId}` : `new-tab:${groupId}`;
  return rowCache.get(key, [label, color], () => {
    const item = el('div', 'new-tab-item');
    item.style.setProperty('--item-colour', color);
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-label', label);
    const add = button(
      label,
      null,
      (event) => {
        const result =
          parentTabId !== null
            ? blankAreaAction('newChildTab', { id: parentTabId })
            : blankAreaAction('newTab', { groupId });
        treeMotion.addFeedback(event.currentTarget);
        return result;
      },
      'new-tab-action',
    );
    add.dataset.key = key;
    const slot = el('span', 'icon-slot');
    slot.append(icon('plus'));
    add.append(slot);
    add.addEventListener('contextmenu', (event) => newTabMenu(event, groupId, parentTabId));
    add.addEventListener('keydown', (event) => {
      if (newTabMenu(event, groupId, parentTabId) || moveTreeFocus(event, add)) return;
      if (event.key === 'ArrowLeft' && !event.altKey) {
        event.preventDefault();
        const parentKey = parentTabId !== null ? `tab:${parentTabId}` : `group:${groupId}`;
        const parentRow = tree.querySelector(`[data-key="${parentKey}"]`);
        if (parentRow) selectRow(parentRow);
        else parent();
      }
    });
    item.append(add);
    dropTarget(item, parentTab ? 'tab' : 'inside', parentTabId ?? groupId);
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
    : 'Expand or collapse folders and tabs';
  toggle.disabled = changingTree || Boolean(query) || !hasBranches;
  setAttribute(toggle, 'aria-label', label);
  setAttribute(toggle, 'aria-busy', String(changingTree));
  toggle.title = query
    ? 'Clear search to expand or collapse folders and tabs'
    : hasBranches
      ? `${label} — folders and nested tabs`
      : 'Nothing to expand or collapse here';
  const iconName = branches.expanded ? 'collapse' : 'expand';
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
    label: `Folders in ${parentName}`,
    trigger,
  });
  trigger.setAttribute('aria-expanded', 'true');
  folderMenuKey = folderHierarchyKey();
}

function render(motionKey = null) {
  if (!state) return;
  renderAppearance();
  $('new-tab').disabled = false;
  $('new-group').disabled = false;
  $('recently-closed-toggle').disabled = false;
  // A refresh may finish after dragstart. Keep the source/targets in the DOM
  // until dragend so native HTML drag-and-drop is not cancelled mid-gesture.
  if (pointerHeld) {
    renderPending = true;
    refreshAgain = true;
    return;
  }
  renderPending = false;
  state = pointerMoves?.project(state) || state;
  recentlyClosed?.render();
  tree.classList.toggle('show-connecting-lines', state.look.connectingLines);
  tree.classList.toggle('show-domains', state.look.domains);
  tree.classList.toggle('show-folder-counts', state.look.folderCounts);
  const focusedKey = document.activeElement?.closest('[data-key]')?.dataset.key;
  const scroll = tree.scrollTop;
  const scope = groupById(state, state.view.scopeId);
  const query = $('search').value.trim().toLowerCase();
  const nextMotionContext = JSON.stringify([state.generation, state.view.scopeId, query]);
  if (nextMotionContext !== motionContext) treeMotion.finishAll();
  motionContext = nextMotionContext;
  treeMotion.prepare(!query && !drag && !changingTree ? motionKey : null);
  index = createTreeIndex(state, query);
  // Folder menus must not retain destinations renamed, moved or removed elsewhere.
  if (folderMenuKey && folderMenuKey !== folderHierarchyKey()) closeMenu(true);
  updateTreeToggle(query);
  treeTabs = index.tabs;
  audioInTabs = index.audio;
  audioInGroups = new Map([...index.groupStats].map(([id, stats]) => [id, stats.audio]));
  const pins = state.pins;
  const tabPins = new Map(state.tabs.filter((tab) => tab.pinned).map((tab) => [tab.treeId, tab]));
  const folderPins = new Map(state.folderPins.map((pin) => [pin.id, pin]));
  reconcileChildren(
    $('pinned-tabs'),
    pins.map((pin) =>
      pin.kind === 'tab' ? pinnedTab(tabPins.get(pin.id)) : pinnedFolder(folderPins.get(pin.id)),
    ),
  );
  $('pinned-tabs').hidden = !pins.length && !drag;
  $('pinned-tabs').classList.toggle('empty-pins', !pins.length && Boolean(drag));
  if (scope) {
    $('home').removeAttribute('aria-current');
    homeLabel.remove();
  } else {
    $('home').setAttribute('aria-current', 'location');
    if (!homeLabel.isConnected) $('home').append(homeLabel);
  }
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
        if (scopeAudio) crumb.append(audioIndicator(playingLabel(scopeAudio, 'in this folder')));
      } else crumb.append(el('span', 'crumb-label', group.name));
      dropTarget(crumb, 'inside', group.id);
      return [folderChevron(group.parentId, crumbs[index - 1]?.name || 'Home'), crumb];
    });
    layoutBreadcrumbs();
  }
  const active = state.tabs.find((tab) => tab.active);
  fillChildren(tree, state.view.scopeId, query);
  treeMotion.finish();
  $('reveal').hidden =
    Boolean(query) ||
    !active ||
    active.pinned ||
    Boolean(tree.querySelector(`[data-key="tab:${active.id}"]:not([inert] *)`));
  if (query && !tree.querySelector('.row')) {
    const empty = el('div', 'empty-state');
    empty.setAttribute('role', 'none');
    empty.append(
      icon('searchLarge'),
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
      .find((row) => row.dataset.key === focusedKey && !row.closest('[inert]'))
      ?.focus({ preventScroll: true });
  pointerMoves?.refresh();
}

function showSearch(show = true, { restoreFocus = true } = {}) {
  if (show || restoreFocus) cancelGroupClick();
  if (show) closeMenu();
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
  const rows = [...tree.querySelectorAll(':is(.row, .new-tab-action):not([inert] *)')];
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
  const rows = [...tree.querySelectorAll(':is(.row, .new-tab-action):not([inert] *)')];
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
  pathOverflow.setAttribute('aria-expanded', 'false');
  if (menuReturnFocus?.matches('.crumb-children'))
    menuReturnFocus.setAttribute('aria-expanded', 'false');
  if (restore && menuReturnFocus?.isConnected) menuReturnFocus.focus();
}

async function openSettings() {
  closeMenu();
  if (demo) {
    openDemoPage('settings');
    return;
  }
  try {
    await request('openPage', { page: 'settings' });
  } catch {
    announce('Could not open settings. Try Tabernacle’s Preferences in Add-ons and themes.', true);
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
    label = path ? 'Full folder path' : null,
    trigger = document.activeElement,
  } = {},
) {
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

function newTabMenu(event, groupId, parentTabId = null) {
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
    parentTabId !== null
      ? [
          {
            label: 'New child tab',
            icon: 'plus',
            run: () => blankAreaAction('newChildTab', { id: parentTabId }),
          },
        ]
      : [
          { label: 'New tab', icon: 'plus', run: () => blankAreaAction('newTab', { groupId }) },
          { label: 'New folder…', icon: 'groupPlus', run: () => createDialog(groupId) },
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
      { label: 'New folder…', icon: 'groupPlus', run: () => createDialog(groupId) },
      ...(groupId !== null
        ? [
            { label: 'Icon and colour…', icon: 'rename', run: () => appearanceDialog(groupId) },
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
        label: 'Expand all folders',
        icon: 'expand',
        disabled: !state.groups.length,
        run: () => action('collapseAll', { collapsed: false }),
      },
      {
        label: 'Collapse all folders',
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
    announce(kind === 'group' ? 'No URLs to copy in this folder.' : 'This tab has no URL to copy.');
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
  if (movingItem) return;
  if (kind === 'group')
    menu(
      [
        { label: 'Open folder', icon: 'enter', run: () => enter(id) },
        { label: 'Show in tree', icon: 'group', run: () => revealFolder(id) },
        ...(state.folderPins.some((item) => item.id === id)
          ? [
              { label: 'Change default action…', icon: 'pin', run: () => pinFolderDialog(id) },
              { label: 'Move shortcut…', icon: 'pin', run: () => moveDialog('pin-group', id) },
              {
                label: 'Unpin folder',
                icon: 'pin',
                run: () => action('setGroupPin', { id, action: null }),
              },
            ]
          : [{ label: 'Pin folder…', icon: 'pin', run: () => pinFolderDialog(id) }]),
        null,
        {
          label: 'New tab here',
          icon: 'plus',
          run: () => action('newTab', { groupId: id }),
        },
        {
          label: 'New subfolder',
          icon: 'groupPlus',
          run: () => createDialog(id),
        },
        null,
        { label: 'Copy URLs', icon: 'copy', run: () => copyUrls(kind, id) },
        { label: 'Rename folder', icon: 'rename', run: () => renameDialog(id) },
        { label: 'Icon and colour…', icon: 'rename', run: () => appearanceDialog(id) },
        { label: 'Default container…', icon: 'container', run: () => groupContainerDialog(id) },
        {
          label: 'Move folder…',
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
          label: 'Delete folder…',
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
                icon: tab.collapsed ? 'expand' : 'collapse',
                run: () => action('toggleTab', { id }),
              },
            ]
          : []),
        null,
        {
          label: 'Move tab…',
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

function dropTarget(node, kind, id) {
  node.dataset.dropKind = kind;
  node.dataset.dropId = id ?? '';
}

function showMovedItem(source) {
  if (!source) return false;
  const selector =
    source.kind === 'pin-group'
      ? `[data-pin-kind="group"][data-pin-id="${CSS.escape(source.id)}"]`
      : `[data-key="${source.kind}:${CSS.escape(String(source.id))}"]`;
  const node = document.querySelector(selector);
  if (!node) return false;
  node.scrollIntoView({ block: 'nearest' });
  node.focus({ preventScroll: true });
  node.classList.add('move-complete');
  setTimeout(() => node.classList.remove('move-complete'), 1600);
  return true;
}

function moveFeedback(next) {
  const result = next?.moveResult;
  if (!result) return;
  const shown = showMovedItem(result.source);
  const revealError = result.revealError || !shown;
  announce(result.label + (revealError ? ' Could not show the destination.' : ''));
  if (revealError) {
    const show = button(
      'Show',
      null,
      async () => {
        const revealed = await action('revealItem', { source: result.source });
        if (revealed) {
          moveFeedback({
            moveResult: { ...result, source: revealed.revealedItem, revealError: null },
          });
        }
      },
      'toast-action',
    );
    show.textContent = 'Show';
    $('toast').append(' ', show);
  }
}

async function commitMove(plan, destination) {
  if (movingItem) return;
  movingItem = true;
  document.querySelector('.sidebar').setAttribute('aria-busy', 'true');
  announce('Moving…');
  const args = {
    source: plan.source,
    destination,
    expected: plan.expected,
    operationId: crypto.randomUUID(),
  };
  try {
    const next = await action('moveItem', args);
    if (next) moveFeedback(next);
  } finally {
    movingItem = false;
    document.querySelector('.sidebar').removeAttribute('aria-busy');
  }
}

pointerMoves = createPointerMove({
  root: document.querySelector('.sidebar'),
  tree,
  shelf: $('pinned-tabs'),
  getState: () => confirmedState,
  canStart: () => Boolean(state) && !movingItem && !activeActions && !$('dialog').open,
  announce,
  commit: commitMove,

  onStart() {
    treeMotion.finishAll();
    cancelGroupClick();
    closeMenu();
    drag = true;
    pointerHeld = false;
    if (searchOpen) showSearch(false, { restoreFocus: false });
  },

  onViewChange() {
    acceptState(confirmedState);
    render();
  },

  onEnd() {
    drag = null;
    pointerHeld = false;
    if (refreshAgain) scheduleRefresh();
  },
});

$('home').append(icon('home'));
$('search-toggle').append(icon('search'));
$('settings').append(icon('settings'));
$('search-close').append(icon('close'));
$('reveal').querySelector('span').append(icon('enter'));
$('dialog-icon').append(icon('groupPlus'));
$('new-tab').append(icon('plus'));
$('new-group').append(icon('groupPlus'));
recentlyClosed = createRecentActivity({
  trigger: $('recently-closed-toggle'),
  getState: () => state,
  favicon: tabFavicon,
  restore: (sessionId) => blankAreaAction('restoreClosedTab', { sessionId }),
  activate: (id) => blankAreaAction('activateTab', { id, reveal: true }),
  enter: (id) => enter(id),
  openMore: createActivityLauncher({
    demo,
    request: (type, args) => request(type, args),
    onError: (message) => announce(message, true),
  }),

  beforeOpen() {
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
$('new-tab').addEventListener('click', (event) => {
  const result = action('newTab', { groupId: state.view.scopeId });
  treeMotion.addFeedback(event.currentTarget);
  return result;
});
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
$('settings').addEventListener('click', openSettings);
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
    const { connectDemo } = await import('../../preview/session.js');
    const controller = await connectDemo(scheduleRefresh);
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
  themeObserver = observeTheme({
    api: demo ? null : globalThis.browser,
    windowId,
    media: matchMedia('(prefers-color-scheme: dark)'),
    onChange: renderAppearance,
  });
  window.addEventListener('pagehide', () => themeObserver.dispose(), { once: true });
  await refresh();
}

start().catch((error) => {
  tree.replaceChildren(el('p', 'loading', error.message));
});
