import { batchSummary } from './collection-dialogs.js';
import { folderCollection, sourceUrl, viewedAge, captureTarget } from './tab-collection.js';
import { createRefreshScheduler } from './refresh-scheduler.js';
import { createSnapshotReader } from './snapshot-transfer.js';
import { icon } from './icons.js';
import { createTreeIndex, scopeBranches, updateTreeAudio } from './tree-index.js';
import { domainForTab } from './domain-filter.js';
import { projectTree, createFullTreeRenderer } from './tree-projection.js';
import { captureScroll, restoreScroll } from './view-state.js';
import { createDomainHeader } from './domain-header.js';
import { createDomainsView } from './domains-view.js';
import { createLaterView } from './later-view.js';
import { createRowCache, reconcileChildren, setAttribute } from './dom.js';
import { createTreeMotion } from './tree-motion.js';
import { createFaviconTints } from './favicon-tint.js';
import { createLabelColors } from './label-colors.js';
import { guideColors } from './appearance-colors.js';
import { createDialogs } from './dialogs.js';
import { folderIcon, folderIconColor } from './folder-icons.js';
import { pinActionLabels } from './pinned-items.js';
import { createPointerMove } from './pointer-move.js';
import { createRecentActivity } from './recently-closed.js';
import { createActivityLauncher } from './activity-launcher.js';
import { openDemoPage } from './internal-pages.js';
import {
  groupById,
  groupPath,
  isWithin,
  isSavedForLater,
  sortTabs,
  tabChildren,
  tabSubtree,
} from './model.js';

const $ = (id) => document.getElementById(id);
const tree = $('tree');
let treeTabs = [];
let index;
let projection;
const rowCache = createRowCache({ retain: 2048 });
const faviconTint = createFaviconTints();
const renderDomainHeader = createDomainHeader($('domain-header'));
const labelColors = createLabelColors(document.documentElement, document.querySelector('.sidebar'));
const wrappers = new Map();
const usedWrappers = new Set();
const guideColorsApplied = new WeakMap();
let breadcrumbKey;
let breadcrumbItems = [];
let folderMenuKey;
let searchOpen = false;
let domainFilter = null;
let domainSort = 'newest';
let domainOrigin;
let domainSourceId;
let domainFromDirectory = false;
let domainVisibleTabs = [];
let searchVisibleIds = [];
let searchOrigin;
let searchScroll;
let changingTree = false;
let windowFocused = true;
let windowFocusedAt = -Infinity;

function canToggleTabChildren() {
  // Firefox can deliver window activation just before the press that caused it.
  // Treat that press as activation only; the next click can fold immediately.
  return windowFocused && performance.now() - windowFocusedAt > 200;
}

function wrapperFor(kind, id, needsBranch = true) {
  const key = `${kind}:${id}`;
  usedWrappers.add(key);
  if (!wrappers.has(key)) {
    const node = el('div', `${kind}-node`);
    node.setAttribute('role', 'none');
    wrappers.set(key, { node });
  }
  const wrapper = wrappers.get(key);
  if (needsBranch && !wrapper.branch) {
    wrapper.branch = el('div', kind === 'group' ? 'branch' : 'tab-branch');
    wrapper.branch.setAttribute('role', 'group');
  }
  return wrapper;
}

function markSelected(row) {
  row.classList.toggle('selected', selected === row.dataset.key);
  return row;
}

let audioInTabs = new Map(),
  audioInGroups = new Map();
let recentlyClosed;
const darkMode = matchMedia('(prefers-color-scheme: dark)');
const forcedColors = matchMedia('(forced-colors: active)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const treeMotion = createTreeMotion(
  tree,
  () => state?.look.animations !== false && !reducedMotion.matches,
  () => rowCache.detach(),
);
let motionContext;

function renderAppearance() {
  if (!state) return;
  if (document.documentElement.dataset.colorScheme !== state.look.colorScheme)
    document.documentElement.dataset.colorScheme = state.look.colorScheme;
  labelColors.configure(darkMode.matches, forcedColors.matches);
  const motionOff = state.look.animations === false || reducedMotion.matches;
  document.documentElement.classList.toggle('motion-off', motionOff);
  document.documentElement.classList.toggle('tint-favicons', state.look.tintFavicons);
  if (motionOff) treeMotion.finishAll();
}

darkMode.addEventListener('change', renderAppearance);
forcedColors.addEventListener('change', renderAppearance);
reducedMotion.addEventListener('change', renderAppearance);
let state, request, windowId, selected, drag, toastTimer, menuReturnFocus;
let confirmedState;
let readSnapshot;
let disposed = false;
let suspendedTree;
let visibilityGeneration = 0;
let awaitingVisibleSnapshot = document.hidden;
let pointerMoves;
let movingItem = false;
let actionQueue = Promise.resolve();
let activeActions = 0;
const pendingViewActions = [];
const domainsView = createDomainsView({
  root: document.querySelector('.sidebar'),
  getState: () => state,

  onOpen() {
    laterView.close({ restoreFocus: false });
    cancelGroupClick();
    closeMenu();
    recentlyClosed?.close();
    treeMotion.finishAll();
    if (domainFilter) leaveDomain({ restoreFocus: false });
    if (searchOpen) showSearch(false, { restoreFocus: false });
    suspendTree();
  },

  onClose: () => render(),
  onSelect: (domain, sourceId) => filterByDomain(domain, sourceId, true),
  onMenu: (event) => collectionMenu(event, { kind: 'window' }, state.tabs, false),
  onPin: (domain, pinned) => action('setDomainPin', { domain, pinned }),
});

const laterView = createLaterView({
  root: document.querySelector('.sidebar'),
  getState: () => state,

  onOpen() {
    cancelGroupClick();
    closeMenu();
    recentlyClosed?.close();
    treeMotion.finishAll();
    domainsView.close({ restoreFocus: false });
    if (domainFilter) leaveDomain({ restoreFocus: false });
    if (searchOpen) showSearch(false, { restoreFocus: false });
    suspendTree();
  },

  onClose: () => render(),
  onActivate: (id) => action('activateTab', { id, expandAncestors: false }),
  onReturn: returnSavedTab,
  onCloseTab: (id) => action('closeTab', { id }),
  onError: (message) => announce(message, true),
  onMenu: (id, x, y) => contextMenu('tab', id, x, y),
  onActions: (event, tabs, scope) => collectionMenu(event, scope, tabs, false),
});

async function saveTabForLater(id) {
  const next = await action('saveForLater', { id });
  if (!next) return;
  announce('Saved for later.');
  const undo = button(
    'Undo',
    null,
    async () => {
      if (await action('returnFromLater', { id })) announce('Returned to the tree.');
    },
    'toast-action',
  );
  undo.textContent = 'Undo';
  $('toast').append(' ', undo);
}

async function returnSavedTab(id) {
  if (!(await action('returnFromLater', { id }))) return;
  announce('Returned to the original folder.');
  const show = button('Show in folder', null, () => showTabInFolder(id), 'toast-action');
  show.textContent = 'Show in folder';
  $('toast').append(' ', show);
}

function acceptState(next) {
  if (disposed) return;
  confirmedState = next;
  const collapsed = new Set(next.view.collapsed);
  let scopeId = next.view.scopeId;
  let tabs = next.tabs;
  // Replay local view changes in order so older replies cannot undo a newer
  // navigation, including the first click's toggle before a double-click.
  for (const { type, args } of pendingViewActions) {
    if (type === 'toggleGroup') {
      if (collapsed.has(args.id)) collapsed.delete(args.id);
      else collapsed.add(args.id);
    } else if (type === 'toggleTab') {
      if (tabs.some((tab) => tab.id === args.id))
        tabs = tabs.map((tab) =>
          tab.id === args.id
            ? { ...tab, collapsed: !tab.collapsed, ...(args.activate ? { active: true } : {}) }
            : args.activate && tab.active
              ? { ...tab, active: false }
              : tab,
        );
    } else {
      scopeId = args.id;
      if (scopeId !== null && typeof args.collapsed === 'boolean') {
        collapsed.delete(scopeId);
        if (args.collapsed) collapsed.add(scopeId);
      }
    }
  }
  state = { ...next, tabs, view: { ...next.view, scopeId, collapsed: [...collapsed] } };
}

let pointerHeld = false,
  renderPending = false;
const demo = !globalThis.browser?.runtime?.id && new URLSearchParams(location.search).has('demo');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const buttonTemplates = new Map();

function button(label, iconName, handler, className = 'icon-button') {
  const key = JSON.stringify([iconName, className]);
  if (!buttonTemplates.has(key)) {
    const template = el('button', className);
    template.type = 'button';
    if (iconName) template.append(icon(iconName));
    buttonTemplates.set(key, template);
  }
  const node = buttonTemplates.get(key).cloneNode(true);
  node.title = label;
  node.setAttribute('aria-label', label);
  if (handler)
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
  if (disposed) return;
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
  closeCollection,
  reviewDuplicates,
  refresh: refreshCollectionDialog,
  moveDialog,
  containerDialog,
  newContainerDialog,
  groupContainerDialog,
} = createDialogs({
  getState: () => state,
  request: (...args) => (args[0] === 'moveItem' ? requestMove(args[1]) : request(...args)),
  closeMenu,
  onMove: moveFeedback,
  onNotice: announce,
  favicon: tabFavicon,

  onChange(next, key) {
    acceptState(next);
    if (key) selected = key;
    if (key?.startsWith('tab:') && !domainFilter) $('search').value = '';
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
  const tab = type === 'clickTab' && state.tabs.find((tab) => tab.id === args.id);
  const clickToggles =
    tab?.active &&
    !tab.pinned &&
    windowFocused &&
    !activeActions &&
    args.toggleChildren !== false &&
    index.children.get(tab.id)?.length;
  const viewAction = ['toggleGroup', 'enterGroup', 'toggleTab'].includes(type)
    ? { type, args }
    : clickToggles
      ? { type: 'toggleTab', args: { id: args.id } }
      : null;
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
      if (!activeActions) refreshScheduler.resume();
    }
  });
  // The queue keeps ordering only; callers retain their own action result.
  actionQueue = result.then(
    () => {},
    () => {},
  );
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

const refreshScheduler = createRefreshScheduler({
  getState: () => confirmedState,
  getWindowId: () => windowId,
  canRefresh: () => Boolean(request) && !document.hidden && !pointerHeld && !activeActions,

  async refresh() {
    const version = visibilityGeneration;
    try {
      const next = await request('snapshot');
      if (disposed || document.hidden || version !== visibilityGeneration) return;
      acceptState(next);
      awaitingVisibleSnapshot = false;
      render();
    } catch (error) {
      if (disposed || document.hidden || version !== visibilityGeneration) return;
      if (!state) tree.replaceChildren(el('p', 'loading', error.message));
      announce(error.message, true);
    }
  },
});
const scheduleRefresh = refreshScheduler.schedule;
const refresh = refreshScheduler.now;
window.addEventListener('pagehide', refreshScheduler.dispose, { once: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    visibilityGeneration++;
    awaitingVisibleSnapshot = true;
  } else refresh();
});

function enter(id, collapsed) {
  laterView.close({ restoreFocus: false });
  domainsView.close({ restoreFocus: false });
  cancelGroupClick();
  if (domainFilter) leaveDomain({ restoreFocus: false });
  if (searchOpen) showSearch(false, { restoreFocus: false });
  $('search').value = '';
  return action('enterGroup', { id, ...(typeof collapsed === 'boolean' ? { collapsed } : {}) });
}

async function revealFolder(id) {
  laterView.close({ restoreFocus: false });
  domainsView.close({ restoreFocus: false });
  cancelGroupClick();
  if (domainFilter) leaveDomain({ restoreFocus: false });
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

function selectRow(row) {
  selected = row.dataset.key;
  tree.querySelectorAll('.selected').forEach((node) => node.classList.remove('selected'));
  row.classList.toggle('selected', row.matches('.row'));
  row.focus({ preventScroll: true });
}

const rowTemplates = new Map();

function rowBase(kind, id) {
  if (!rowTemplates.has(kind)) {
    const template = el('div', `row ${kind}-row`);
    template.dataset.kind = kind;
    template.tabIndex = 0;
    template.setAttribute('role', 'treeitem');
    template.draggable = false;
    rowTemplates.set(kind, template);
  }
  const row = rowTemplates.get(kind).cloneNode(true);
  row.dataset.key = `${kind}:${id}`;
  row.dataset.id = id;
  row.classList.toggle('selected', selected === row.dataset.key);
  dropTarget(row, kind, id);
  return row;
}

function rowButton(label, iconName, action, className = 'icon-button') {
  const node = button(label, iconName, null, className);
  node.dataset.rowAction = action;
  return node;
}

// Transient press state belongs to the row without retaining a detached subtree.
const rowPress = new WeakMap();

function rowTarget(event) {
  const row = event.target.closest('.row');
  if (!row || !tree.contains(row) || row.closest('[inert]') || !state) return null;
  const kind = row.dataset.kind;
  const id = kind === 'tab' ? Number(row.dataset.id) : row.dataset.id;
  if (kind !== 'group' && kind !== 'tab') return null;
  return { row, kind, id };
}

function currentRow(target) {
  return (
    target &&
    (target.kind === 'tab'
      ? state.tabs.some((tab) => tab.id === target.id)
      : state.groups.some((group) => group.id === target.id))
  );
}

tree.addEventListener('pointerdown', (event) => {
  const target = rowTarget(event);
  if (!target || target.kind !== 'tab' || event.button !== 0) return;
  if (event.target.closest('button')) rowPress.delete(target.row);
  else rowPress.set(target.row, canToggleTabChildren());
});
tree.addEventListener('pointercancel', (event) => {
  const target = rowTarget(event);
  if (target) rowPress.delete(target.row);
});
tree.addEventListener('mousedown', (event) => {
  if (event.button === 1 && rowTarget(event)?.kind === 'tab') event.preventDefault();
});
tree.addEventListener('auxclick', (event) => {
  const target = rowTarget(event);
  if (event.button !== 1 || target?.kind !== 'tab' || !currentRow(target)) return;
  event.preventDefault();
  event.stopPropagation();
  closeTab(target.id);
});
tree.addEventListener('click', (event) => {
  const target = rowTarget(event);
  if (!currentRow(target)) return;
  const { row, kind, id } = target;
  const control = event.target.closest('button');
  if (control) {
    const actionName = control.dataset.rowAction;
    if (!actionName) return;
    event.stopPropagation();
    if (actionName === 'toggle-group' && kind === 'group') {
      selectRow(row);
      clickGroup(id, event);
    } else if (actionName === 'toggle-tab' && kind === 'tab') {
      selectRow(row);
      windowFocusedAt = -Infinity;
      action('toggleTab', { id, activate: true });
    } else if (kind === 'tab') {
      if (actionName === 'return-tab') returnSavedTab(id);
      else if (actionName === 'mute-tab') action('muteTab', { id });
      else if (actionName === 'close-tab') closeTab(id);
    }
    return;
  }
  selectRow(row);
  if (kind === 'group') {
    if (event.detail < 2) clickGroup(id, event);
    return;
  }
  if (domainFilter || isSavedForLater(state.tabs.find((tab) => tab.id === id))) {
    rowPress.delete(row);
    activateTab(id);
    return;
  }
  const toggleChildren = (rowPress.get(row) ?? true) && canToggleTabChildren();
  rowPress.delete(row);
  windowFocusedAt = -Infinity;
  action('clickTab', { id, toggleChildren }).then((next) => {
    // A focus notification caused by this activation can arrive after click.
    if (next && !toggleChildren && windowFocused) windowFocusedAt = -Infinity;
  });
});
tree.addEventListener('contextmenu', (event) => {
  const target = rowTarget(event);
  if (!currentRow(target)) return;
  cancelGroupClick();
  event.preventDefault();
  selectRow(target.row);
  contextMenu(target.kind, target.id, event.clientX, event.clientY);
});
tree.addEventListener('keydown', (event) => {
  const target = rowTarget(event);
  if (currentRow(target)) rowKey(event, target.row, target.kind, target.id);
});

function playsAudio(tab) {
  return Boolean(tab.audible && !tab.mutedInfo?.muted);
}

function childAudioCount(tab) {
  if (domainFilter) return 0;
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
  const disclosure = rowButton(`Expand ${group.name}`, null, 'toggle-group', 'disclosure');
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
  return row;
}

function paintGuide(branch, color) {
  const key = color || '';
  if (guideColorsApplied.get(branch) === key) return;
  for (const [i, shade] of guideColors(color).entries()) {
    const property = `--guide-${i + 1}`;
    if (branch.style.getPropertyValue(property) !== shade)
      branch.style.setProperty(property, shade);
  }
  guideColorsApplied.set(branch, key);
}

function groupRow(group, expanded) {
  const container = groupContainerDetails(group);
  const { appearance } = index.folders.details.get(group.id);
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
  labelColors.apply(row, appearance.color);
  setAttribute(row, 'aria-expanded', expanded);
  const disclosure = row.querySelector('.disclosure');
  const label = `${expanded ? 'Collapse' : 'Expand'} ${group.name}`;
  if (disclosure.getAttribute('aria-expanded') !== String(expanded))
    disclosure.replaceChildren(
      folderIcon(group, container, { className: 'group', expanded, appearance }),
    );
  setAttribute(disclosure, 'aria-expanded', expanded);
  setAttribute(disclosure, 'aria-label', label);
  setAttribute(disclosure, 'title', label);
  return row;
}

function groupNode({ group, expanded }, children) {
  const { node, branch } = wrapperFor('group', group.id);
  const { appearance } = index.folders.details.get(group.id);
  const color = folderIconColor(appearance.color) || 'var(--folder-icon)';
  node.style.setProperty('--item-colour', color);
  paintGuide(branch, appearance.color);
  const row = groupRow(group, expanded);
  treeMotion.reconcile(node, row, branch, expanded, () => {
    reconcileChildren(branch, children);
    if (!branch.childElementCount) {
      const empty = el('div', 'empty-child', 'Drop tabs here');
      empty.setAttribute('role', 'none');
      dropTarget(empty, 'inside', group.id);
      branch.append(empty);
    }
  });
  return node;
}

function fallbackFavicon(node) {
  node.classList.add('tab-globe');
  node.setAttribute('aria-hidden', 'true');
}

function tabFavicon(tab) {
  const favicon = el('span', 'tab-icon');
  const tint = state.look.tintFavicons && faviconTint(tab.container?.colorCode);
  if (tint) {
    favicon.style.setProperty('--favicon-filter', tint.filter);
    favicon.style.setProperty('--favicon-colour', tint.color);
  }
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
    img.addEventListener(
      'error',
      () => {
        img.remove();
        fallbackFavicon(favicon);
      },
      { once: true },
    );
    favicon.append(img);
  } else if (demo && tab.title !== 'New tab') {
    favicon.classList.add('tab-fallback');
    favicon.textContent = (tab.title || 'T').charAt(0);
  } else fallbackFavicon(favicon);
  return favicon;
}

function groupContainerDetails(group) {
  const { source, container: identity } = index.folders.details.get(group.id);
  if (!source) return null;
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
  const args = { id, promoteFirstChild: true };
  if (domainFilter) {
    const domain = domainFilter;
    const rows = [...tree.querySelectorAll('.tab-row')];
    const position = rows.findIndex((row) => row.dataset.id === String(id));
    const focused = document.activeElement;
    const hadFocus = rows[position]?.contains(focused) || $('menu').contains(focused);
    action('closeTab', args).then((next) => {
      if (!next || domainFilter !== domain || !hadFocus) return;
      // Do not steal focus if the user has already moved elsewhere while closing.
      if (document.activeElement !== focused && document.activeElement !== document.body) return;
      const remaining = [...tree.querySelectorAll('.tab-row')];
      const activeId = next.tabs.find((tab) => tab.active)?.id;
      const target =
        remaining.find((row) => Number(row.dataset.id) === activeId) ||
        remaining[Math.max(0, position - 1)];
      if (target) selectRow(target);
      else $('domain-close').focus();
    });
  } else action('closeTab', args);
}

function activateTab(id) {
  return action('activateTab', {
    id,
    ...(domainFilter || isSavedForLater(state.tabs.find((tab) => tab.id === id))
      ? { expandAncestors: false }
      : {}),
  });
}

function closeFilter() {
  let filter;
  if (laterView.isOpen) filter = laterView.closeFilter();
  else if (domainFilter)
    filter = {
      domain: domainFilter,
      query: $('domain-search').value,
      sort: domainSort,
      tabIds: domainVisibleTabs.map((tab) => tab.id),
    };
  else if (searchOpen && $('search').value.trim())
    filter = {
      search: true,
      query: $('search').value,
      scopeId: state.view.scopeId,
      tabIds: searchVisibleIds,
    };
  // The controller asks while settling a native close. It already owns fresh
  // state and can recompute these criteria; requesting a snapshot here would
  // deadlock its serial queue. A hidden view's displayed IDs can be stale.
  if (filter && (document.hidden || awaitingVisibleSnapshot || renderPending)) delete filter.tabIds;
  return filter || null;
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
  const node = button(label, null, () => activateTab(tab.id), 'pinned-tab');
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
  const group = index.groups.get(pin.id);
  const container = groupContainerDetails(group);
  const { appearance } = index.folders.details.get(group.id);
  const path = index.folders
    .path(group.id)
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
      node.append(folderIcon(group, container, { appearance }));
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
    state.look.tintFavicons,
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
  if (domainFilter || isSavedForLater(tab)) {
    const location = tabFolderLabel(tab);
    row.title = `${tab.title || 'New tab'}\n${tab.url}\n${location}`;
    row.setAttribute('aria-description', location);
  }
  describeContainer(row, tab);
  describeAudio(row, audioDescription(tab));
  if (stats.descendants) {
    row.setAttribute('aria-expanded', String(expanded));
    const count = `${stats.descendants} nested ${stats.descendants === 1 ? 'tab' : 'tabs'}`;
    row.setAttribute('aria-label', `${row.getAttribute('aria-label')}, ${count}`);
    const disclosure = rowButton(
      `${expanded ? 'Collapse' : 'Expand'} child tabs of ${tab.title || 'New tab'}`,
      null,
      'toggle-tab',
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
  if (domainFilter && domainSort === 'least-viewed' && viewedAge(tab.lastAccessed)) {
    const age = el('span', 'viewed-age', viewedAge(tab.lastAccessed));
    age.title = `Last viewed ${new Date(tab.lastAccessed).toLocaleString()}`;
    row.append(age);
  }
  if (isSavedForLater(tab)) {
    row.classList.add('saved-search-row');
    row.append(el('span', 'saved-search-folder', tabFolderLabel(tab)));
    row.append(rowButton('Return to original folder', 'group', 'return-tab'));
  }
  if (childAudioCount(tab) && !playsAudio(tab))
    row.append(audioIndicator(playingLabel(childAudioCount(tab), 'in this tab’s children')));
  if (tab.audible || tab.mutedInfo?.muted)
    row.append(
      rowButton(
        tab.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab',
        tab.mutedInfo?.muted ? 'mutedSmall' : 'speakerSmall',
        'mute-tab',
        'audio-button',
      ),
    );
  row.append(rowButton(`Close ${tab.title || 'New tab'}`, null, 'close-tab', 'close-tab'));
  return row;
}

function tabRow(tab, expanded, stats) {
  const row = markSelected(
    rowCache.get(
      `tab:${tab.id}`,
      [
        ...rowValues(tab),
        state.look.domains,
        expanded,
        stats.descendants,
        stats.active,
        domainFilter || isSavedForLater(tab) ? tabFolderLabel(tab) : null,
        isSavedForLater(tab),
        domainSort === 'least-viewed' ? viewedAge(tab.lastAccessed) : null,
        domainSort === 'least-viewed' ? tab.lastAccessed : null,
      ],
      () => createTabRow(tab, expanded, stats),
    ),
  );
  labelColors.apply(row, tab.container?.colorCode);
  return row;
}

function tabFolderLabel(tab) {
  const path = ['Home', ...index.folders.path(tab.groupId).map((group) => group.name)].join(' / ');
  return `${tab.pinned ? 'Pinned · ' : ''}Folder: ${path}`;
}

function tabNode({ tab, stats, expanded }, children) {
  const { node, branch } = wrapperFor('tab', tab.id, stats.descendants > 0);
  // A tab owns its child rail, even when a child uses a different container.
  if (stats.descendants) paintGuide(branch, tab.container?.colorCode);
  node.classList.toggle('tab-parent', stats.descendants > 0);
  const row = tabRow(tab, expanded, stats);
  if (!branch) {
    reconcileChildren(node, [row]);
    return node;
  }
  treeMotion.reconcile(node, row, branch, Boolean(stats.descendants && expanded), () => {
    reconcileChildren(branch, children);
  });
  return node;
}

function newTabItem(groupId, parentTab = null) {
  const group = index.groups.get(groupId);
  const folderColor = index.folders.details.get(groupId)?.appearance.color;
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
        const parentRow = treeRenderer.target(parentKey);
        if (parentRow) selectRow(parentRow);
        else parent();
      }
    });
    item.append(add);
    dropTarget(item, parentTab ? 'tab' : 'inside', parentTabId ?? groupId);
    return item;
  });
}

const treeRenderer = createFullTreeRenderer({
  tree,
  pins: $('pinned-tabs'),
  reconcile: reconcileChildren,
  // Pane callers own focus, including close({ restoreFocus: false }).
  captureView: () => ({ scroll: captureScroll(tree, '.row, .new-tab-action') }),
  restoreView: (saved) => restoreScroll(tree, saved.scroll),

  renderRow(row, children) {
    let node;
    let target;
    if (row.kind === 'group') node = groupNode(row, children);
    else if (row.kind === 'new-tab') node = newTabItem(row.groupId, row.parentTab);
    else if (row.kind === 'pin-tab') node = target = pinnedTab(row.tab);
    else if (row.kind === 'pin-group') node = target = pinnedFolder(row.group);
    else if (row.mode === 'tree') node = tabNode(row, children);
    else node = target = tabRow(row.tab, true, row.stats);
    target ||= node.querySelector('.row, .new-tab-action');
    return { node, target };
  },

  renderSaved(nodes) {
    const section = el('div', 'saved-search-results');
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', 'Saved for Later');
    const heading = el('h2', '', 'Saved for Later');
    heading.setAttribute('role', 'presentation');
    section.append(heading, ...nodes);
    return section;
  },
});

function updateTreeToggle(query) {
  const toggle = $('tree-toggle');
  const branches = scopeBranches(index, state.view);
  const hasBranches = branches.groupIds.size > 0 || branches.tabs.length > 0;
  const scope = groupById(state, state.view.scopeId)?.name || 'Home';
  const label = hasBranches
    ? `${branches.expanded ? 'Collapse' : 'Expand'} all in ${scope}`
    : 'Expand or collapse folders and tabs';
  toggle.disabled = changingTree || Boolean(query || domainFilter) || !hasBranches;
  setAttribute(toggle, 'aria-label', label);
  setAttribute(toggle, 'aria-busy', String(changingTree));
  toggle.title = domainFilter
    ? 'Return to folders to expand or collapse tabs'
    : query
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

  if (!searchOpen && !domainFilter && (pathHadFocus || pathMenuOpen)) {
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

let previousRender;

const layoutValues = (tab) => [
  tab.id,
  tab.index,
  tab.order,
  tab.treeId,
  tab.groupId,
  tab.parentTabId,
  tab.savedForLaterAt,
  Boolean(tab.pinned),
  Boolean(tab.collapsed),
  Boolean(tab.active),
  Boolean(tab.audible),
  Boolean(tab.mutedInfo?.muted),
];
// Compare against the saved values without allocating arrays for unchanged tabs.
const sameLayout = (saved, tab) =>
  saved[0] === tab.id &&
  saved[1] === tab.index &&
  saved[2] === tab.order &&
  saved[3] === tab.treeId &&
  saved[4] === tab.groupId &&
  saved[5] === tab.parentTabId &&
  saved[6] === tab.savedForLaterAt &&
  saved[7] === Boolean(tab.pinned) &&
  saved[8] === Boolean(tab.collapsed) &&
  saved[9] === Boolean(tab.active);

const metadataValues = (tab) => [
  tab.title,
  tab.url,
  tab.favIconUrl,
  tab.discarded,
  tab.cookieStoreId,
  tab.container?.name,
  tab.container?.colorCode,
];
const sameMetadata = (saved, tab) =>
  saved[0] === tab.title &&
  saved[1] === tab.url &&
  saved[2] === tab.favIconUrl &&
  saved[3] === tab.discarded &&
  saved[4] === tab.cookieStoreId &&
  saved[5] === tab.container?.name &&
  saved[6] === tab.container?.colorCode;

function renderContext() {
  return JSON.stringify([
    state.generation,
    state.groups,
    state.containers,
    state.folderPins,
    state.pins,
    state.look,
    state.view.scopeId,
    state.view.collapsed,
    selected,
    changingTree,
  ]);
}

function rememberRender(query, context) {
  previousRender = query
    ? null
    : {
        context,
        tabs: state.tabs.map((tab) => ({
          layout: layoutValues(tab),
          metadata: metadataValues(tab),
        })),
        visible: new Map(index.tabs.map((tab) => [tab.id, tab])),
      };
}

function patchMetadata(context) {
  if (
    !previousRender ||
    previousRender.context !== context ||
    previousRender.tabs.length !== state.tabs.length
  )
    return false;
  const changed = [];
  const audioChanges = [];
  for (const [i, tab] of state.tabs.entries()) {
    const saved = previousRender.tabs[i];
    if (!sameLayout(saved.layout, tab)) return false;
    const audioChanged =
      saved.layout[10] !== Boolean(tab.audible) ||
      saved.layout[11] !== Boolean(tab.mutedInfo?.muted);
    if (audioChanged) audioChanges.push({ tab, wasPlaying: saved.layout[10] && !saved.layout[11] });
    if (audioChanged || !sameMetadata(saved.metadata, tab))
      changed.push({ tab, saved, metadata: metadataValues(tab) });
  }
  const audio = audioChanges.length
    ? updateTreeAudio(index, audioChanges)
    : { tabs: new Set(), groups: new Set() };
  if (!audio) return false;
  // Topology and activation remain unchanged. Audio changes affect only their
  // logical ancestors; metadata still refreshes only the affected tab rows.
  for (const tab of state.tabs) index.byId.set(tab.id, tab);
  if (projection) projection.source = state;
  for (const { tab, saved, metadata } of changed) {
    saved.metadata = metadata;
    saved.layout[10] = Boolean(tab.audible);
    saved.layout[11] = Boolean(tab.mutedInfo?.muted);
    audio.tabs.add(tab.id);
  }
  for (const id of audio.tabs) {
    const tab = index.byId.get(id);
    const visible = previousRender.visible.get(tab.id);
    if (visible) Object.assign(visible, tab, { parentTabId: visible.parentTabId });
    if (tab.pinned) {
      treeRenderer.replaceTarget(`tab:${tab.id}`, pinnedTab(tab));
      const row = projection?.materializedByKey.get(`tab:${tab.id}`);
      if (row) row.tab = tab;
    } else {
      const wrapper = wrappers.get(`tab:${tab.id}`);
      if (!wrapper?.node.isConnected) continue;
      const stats = index.tabStats.get(tab.id);
      treeRenderer.replaceTarget(`tab:${tab.id}`, tabRow(tab, !tab.collapsed, stats));
      if (wrapper.branch) paintGuide(wrapper.branch, tab.container?.colorCode);
      if (stats.descendants && !tab.collapsed)
        treeRenderer.replaceTarget(
          `new-child-tab:${tab.id}`,
          newTabItem(tab.groupId, tab).querySelector('.new-tab-action'),
        );
    }
  }
  for (const id of audio.groups) {
    audioInGroups.set(id, index.groupStats.get(id).audio);
    const row = projection?.materializedByKey.get(`group:${id}`);
    if (row && treeRenderer.target(row.key)?.isConnected)
      treeRenderer.replaceTarget(row.key, groupRow(row.group, row.expanded));
  }
  if (audio.groups.has(state.view.scopeId)) renderBreadcrumbs(index.groups.get(state.view.scopeId));
  return true;
}

function renderBreadcrumbs(scope) {
  const crumbs = index.folders.path(state.view.scopeId);
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
}

function restoreRowFocus(key) {
  treeRenderer.target(key)?.focus({ preventScroll: true });
}

function releaseTree() {
  treeMotion.finishAll();
  treeRenderer.suspend();
  projection = null;
  rowCache.clear();
  wrappers.clear();
  usedWrappers.clear();
  treeTabs = [];
  index = undefined;
  audioInTabs.clear();
  audioInGroups.clear();
  previousRender = null;
  domainVisibleTabs = [];
  searchVisibleIds = [];
  for (const pair of breadcrumbItems) for (const node of pair) node.remove();
  breadcrumbItems = [];
  breadcrumbKey = undefined;
  $('menu').replaceChildren();
  menuReturnFocus = undefined;
}

function suspendTree() {
  if (suspendedTree) return;
  suspendedTree = treeRenderer.capture();
  releaseTree();
}

window.addEventListener(
  'pagehide',
  () => {
    disposed = true;
    cancelGroupClick();
    pointerMoves?.dispose();
    readSnapshot?.clear();
    releaseTree();
    treeRenderer.dispose();
    laterView.dispose();
    domainsView.dispose();
    state = confirmedState = suspendedTree = undefined;
  },
  { once: true },
);

function render(motionKey = null) {
  if (!state || disposed) return;
  if (document.hidden) {
    renderPending = true;
    return;
  }
  renderAppearance();
  refreshCollectionDialog();
  $('new-tab').disabled = false;
  $('new-group').disabled = false;
  $('recently-closed-toggle').disabled = false;
  // A refresh may finish after dragstart. Keep the source/targets in the DOM
  // until dragend so native HTML drag-and-drop is not cancelled mid-gesture.
  if (pointerHeld) {
    renderPending = true;
    scheduleRefresh();
    return;
  }
  renderPending = false;
  state = pointerMoves?.project(state) || state;
  recentlyClosed?.render();
  const laterOpen = laterView.update(state);
  const domainsOpen = domainsView.update(state);
  if (laterOpen || domainsOpen) {
    previousRender = null;
    return;
  }
  tree.classList.toggle('show-connecting-lines', state.look.connectingLines);
  tree.classList.toggle('show-domains', state.look.domains);
  tree.classList.toggle('show-folder-counts', state.look.folderCounts);
  tree.classList.toggle('domain-results', Boolean(domainFilter));
  const focusedKey = document.activeElement?.closest('[data-key]')?.dataset.key;
  const scroll = suspendedTree?.scroll.top ?? tree.scrollTop;
  const scope = groupById(state, state.view.scopeId);
  const query = (domainFilter ? $('domain-search').value : $('search').value).trim().toLowerCase();
  const filtering = Boolean(query || domainFilter);
  const context = renderContext();
  rowCache.begin();
  if (
    !filtering &&
    !motionKey &&
    !drag &&
    !changingTree &&
    !treeMotion.active &&
    patchMetadata(context)
  ) {
    restoreRowFocus(focusedKey);
    return;
  }
  tree.classList.toggle('searching', filtering);
  tree.setAttribute('aria-label', domainFilter ? `Tabs from ${domainFilter}` : 'Tabs and folders');
  const nextMotionContext = JSON.stringify([
    state.generation,
    state.view.scopeId,
    query,
    domainFilter,
  ]);
  if (nextMotionContext !== motionContext) treeMotion.finishAll();
  motionContext = nextMotionContext;
  treeMotion.prepare(!filtering && !drag && !changingTree ? motionKey : null);
  index = createTreeIndex(state, query);
  projection = projectTree(state, index, { query, domain: domainFilter, sort: domainSort });
  // Folder menus must not retain destinations renamed, moved or removed elsewhere.
  if (folderMenuKey && folderMenuKey !== folderHierarchyKey()) closeMenu(true);
  updateTreeToggle(query);
  treeTabs = index.tabs;
  audioInTabs = index.audio;
  audioInGroups = new Map([...index.groupStats].map(([id, stats]) => [id, stats.audio]));
  const pins = state.pins;
  $('pinned-tabs').hidden = Boolean(domainFilter) || (!pins.length && !drag);
  $('pinned-tabs').classList.toggle('empty-pins', !pins.length && Boolean(drag));
  if (scope) {
    $('home').removeAttribute('aria-current');
    homeLabel.remove();
  } else {
    $('home').setAttribute('aria-current', 'location');
    if (!homeLabel.isConnected) $('home').append(homeLabel);
  }
  renderBreadcrumbs(scope);
  const active = state.tabs.find((tab) => tab.active);
  $('navigation-capsule').hidden = Boolean(domainFilter);
  $('sidebar-header').classList.toggle('domain-mode', Boolean(domainFilter));
  $('domain-tools').hidden = !domainFilter;
  $('domain-search-tools').hidden = !domainFilter;
  $('domain-back').hidden = !domainFromDirectory;
  domainsView.detail(domainFromDirectory && Boolean(domainFilter));
  if (domainFilter) {
    const results = projection.domainTabs;
    const visibleResults = projection.matchingRows
      .filter((row) => row.kind === 'tab')
      .map((row) => row.tab);
    domainVisibleTabs = visibleResults;
    renderDomainHeader(domainFilter, results, domainSourceId);
    const count = `${results.length} ${results.length === 1 ? 'tab' : 'tabs'}`;
    $('domain-count').textContent = query ? `${visibleResults.length} of ${count}` : count;
    const status = `${query ? `${visibleResults.length} of ` : ''}${count} from ${domainFilter} in this window`;
    if ($('domain-status').textContent !== status) $('domain-status').textContent = status;
    $('domain-sort').title =
      ['newest', 'oldest'].includes(domainSort) &&
      results.some((tab) => !(Number.isFinite(tab.openedAt) && tab.openedAt > 0))
        ? 'Tabs without a recorded opening time follow dated tabs in tree order.'
        : 'Sort filtered tabs';
  } else {
    renderDomainHeader(null);
    searchVisibleIds = query ? projection.filterTabIds : [];
    $('domain-status').textContent = '';
  }
  treeRenderer.update(projection);
  treeMotion.finish();
  $('reveal').hidden =
    filtering || !active || active.pinned || projection.visibleKeys.has(`tab:${active.id}`);
  if (filtering && !projection.visibleRows.some((row) => row.kind !== 'new-tab')) {
    const empty = el('div', 'empty-state');
    empty.setAttribute('role', 'none');
    empty.append(
      icon('searchLarge'),
      el('h2', '', domainFilter ? `No tabs from ${domainFilter}` : 'Nothing found'),
      el(
        'p',
        '',
        domainFilter
          ? 'Close this view to return to your folders.'
          : 'Try another name or website address.',
      ),
    );
    tree.prepend(empty);
  }
  const savedTabIds = new Set();
  for (const tab of state.tabs) if (isSavedForLater(tab)) savedTabIds.add(tab.id);
  rowCache.finish((key) => {
    if (key.startsWith('pin:group:')) return index.groups.has(key.slice('pin:group:'.length));
    const separator = key.indexOf(':');
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (kind === 'tab' || kind === 'pin' || kind === 'new-child-tab')
      return index.byId.has(Number(id)) || (kind === 'tab' && savedTabIds.has(Number(id)));
    return (kind === 'new-tab' && id === 'null') || index.groups.has(id);
  });
  // Native closes or another sidebar can remove the row owning an open menu.
  if (!$('menu').hidden && menuReturnFocus && !menuReturnFocus.isConnected) closeMenu();
  for (const key of wrappers.keys()) if (!usedWrappers.has(key)) wrappers.delete(key);
  usedWrappers.clear();
  $('new-tab').title = scope ? `New tab in ${scope.name}` : 'New tab';
  tree.scrollTop = searchScroll ?? scroll;
  if (suspendedTree && searchScroll === undefined) treeRenderer.restore(suspendedTree);
  suspendedTree = undefined;
  searchScroll = undefined;
  restoreRowFocus(focusedKey);
  rememberRender(filtering, context);
  pointerMoves?.refresh();
}

function showSearch(show = true, { restoreFocus = true } = {}) {
  if (show) laterView.close({ restoreFocus: false });
  if (show) domainsView.close({ restoreFocus: false });
  if (show && domainFilter) leaveDomain({ restoreFocus: false });
  if (show || restoreFocus) cancelGroupClick();
  if (show) closeMenu();
  if (show && !searchOpen) searchOrigin = { scroll: tree.scrollTop, selected };
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

function filterByDomain(domain, sourceId, fromDirectory = false) {
  if (!domain) return;
  cancelGroupClick();
  closeMenu();
  if (!domainFilter) {
    domainOrigin = searchOpen ? searchOrigin : { scroll: tree.scrollTop, selected };
    if (searchOpen) showSearch(false, { restoreFocus: false });
  }
  domainFromDirectory = fromDirectory;
  $('domain-search').value = '';
  domainFilter = domain;
  domainSourceId = sourceId;
  searchScroll = 0;
  render();
  $('domain-close').focus({ preventScroll: true });
}

function leaveDomain({ restoreFocus = true } = {}) {
  if (!domainFilter) return;
  cancelGroupClick();
  closeMenu();
  domainFilter = null;
  domainFromDirectory = false;
  domainVisibleTabs = [];
  $('domain-search').value = '';
  domainsView.detail(false);
  domainSourceId = null;
  selected = domainOrigin?.selected;
  searchScroll = domainOrigin?.scroll ?? 0;
  domainOrigin = null;
  render();
  layoutBreadcrumbs();
  if (restoreFocus) {
    const row = selected && treeRenderer.target(selected);
    (row || $('scope-heading') || $('home')).focus({ preventScroll: true });
  }
}

async function showTabInFolder(id) {
  const tab = state.tabs.find((tab) => tab.id === id);
  if (!tab) return;
  await enter(tab.groupId);
  const next = await action('activateTab', { id, reveal: true });
  if (!next) return;
  const row = treeRenderer.target(`tab:${id}`);
  if (row) {
    selectRow(row);
    treeRenderer.ensureVisible(`tab:${id}`);
  }
}

function moveTreeFocus(event, row) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
  event.preventDefault();
  const rows = (projection?.visibleRows || [])
    .map((row) => treeRenderer.target(row.key))
    .filter(Boolean);
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
  const rows = (projection?.visibleRows || [])
    .map((row) => treeRenderer.target(row.key))
    .filter(Boolean);
  const index = rows.indexOf(row);
  const tab = kind === 'tab' ? state.tabs.find((tab) => tab.id === id) : null;
  const hasChildren =
    !domainFilter &&
    !isSavedForLater(tab) &&
    (kind === 'group' || tabChildren(treeTabs, id).length > 0);
  const collapsed = kind === 'group' ? state.view.collapsed.includes(id) : tab?.collapsed;
  const toggle = () => action(kind === 'group' ? 'toggleGroup' : 'toggleTab', { id });
  if (event.key === 'Enter') {
    event.preventDefault();
    kind === 'group' ? enter(id) : activateTab(id);
  } else if (event.key === ' ' && hasChildren) {
    event.preventDefault();
    toggle();
  } else if (event.key === 'ArrowRight' && hasChildren) {
    event.preventDefault();
    if (collapsed) toggle();
    else if (rows[index + 1]) selectRow(rows[index + 1]);
  } else if (event.key === 'ArrowLeft' && !event.altKey) {
    event.preventDefault();
    if (domainFilter) return;
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
  if (searchOpen) showSearch(false, { restoreFocus: false });
  $('search').value = '';
  const next = await action(type, args);
  const id = next?.createdTabId ?? next?.restoredTabId ?? next?.tabs.find((tab) => tab.active)?.id;
  if (isSavedForLater(next?.tabs.find((tab) => tab.id === id))) {
    laterView.focusTab(id);
    return;
  }
  if (id !== undefined) treeRenderer.ensureVisible(`tab:${id}`);
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

function collectionMenu(event, scope, tabs, bulk) {
  const count = `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`;
  const rect = event.currentTarget.getBoundingClientRect();
  menu(
    [
      ...(bulk
        ? [
            {
              label: `Save ${count} for later`,
              icon: 'later',
              disabled: !tabs.length,
              run: () => saveCollection(scope, tabs),
            },
            {
              label: `Copy ${tabs.length} ${tabs.length === 1 ? 'URL' : 'URLs'}`,
              icon: 'copy',
              disabled: !tabs.length,
              run: () => copyTabUrls(tabs),
            },
            {
              label: `Close ${count}…`,
              icon: 'close',
              disabled: !tabs.length,
              run: () => closeCollection(scope, tabs),
              danger: true,
            },
            null,
          ]
        : []),
      { label: 'Review duplicates…', icon: 'copy', run: () => reviewDuplicates(scope, tabs) },
    ],
    rect.left,
    rect.bottom,
  );
}

async function saveCollection(scope, tabs) {
  const next = await action('saveTabsForLater', { scope, targets: tabs.map(captureTarget) });
  if (!next) return;
  const result = next.batchResult;
  announce(batchSummary(result, 'Saved'), Boolean(result.failed.length));
  if (result.undo.length) {
    const undo = button(
      'Undo',
      null,
      async () => {
        const undone = await action('undoSaveTabsForLater', { targets: result.undo });
        if (undone)
          announce(
            batchSummary(undone.batchResult, 'Returned'),
            Boolean(undone.batchResult.failed.length),
          );
      },
      'toast-action',
    );
    undo.textContent = 'Undo';
    $('toast').append(' ', undo);
  }
}

async function copyTabUrls(tabs, emptyMessage = 'No URLs to copy.') {
  const urls = tabs.map(sourceUrl).filter((url) => typeof url === 'string' && url.trim());
  if (!urls.length) {
    announce(emptyMessage);
    return;
  }
  try {
    await navigator.clipboard.writeText(urls.join('\n'));
    announce(urls.length === 1 ? 'URL copied.' : `${urls.length} URLs copied.`);
  } catch {
    announce('Could not copy to the clipboard. Please try again.', true);
  }
}

async function copyUrls(kind, id) {
  const tabs =
    kind === 'group'
      ? sortTabs(
          state.tabs.filter((tab) => !isSavedForLater(tab) && isWithin(state, tab.groupId, id)),
        )
      : state.tabs.filter((tab) => tab.id === id);
  return copyTabUrls(tabs, kind === 'group' ? 'No URLs to copy in this folder.' : undefined);
}

function contextMenu(kind, id, x, y) {
  if (movingItem) return;
  const folderTabs = kind === 'group' ? folderCollection(state, id) : [];
  const unsavedFolderTabs = folderTabs.filter((tab) => !isSavedForLater(tab));
  if (kind === 'group')
    menu(
      [
        { label: 'Open folder', icon: 'enter', run: () => enter(id) },
        { label: 'Show in tree', icon: 'group', run: () => revealFolder(id) },
        ...(state.folderPins.some((item) => item.id === id)
          ? [
              { label: 'Change default action…', icon: 'pin', run: () => pinFolderDialog(id) },
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
        {
          label: `Save tabs for later (${unsavedFolderTabs.length})`,
          icon: 'later',
          disabled: !unsavedFolderTabs.length,
          run: () => saveCollection({ kind: 'folder', id }, unsavedFolderTabs),
        },
        {
          label: 'Review duplicates…',
          icon: 'copy',
          run: () => reviewDuplicates({ kind: 'folder', id }, folderTabs),
        },
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
          disabled: !state.tabs.some(
            (tab) => !isSavedForLater(tab) && isWithin(state, tab.groupId, id),
          ),
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
    if (isSavedForLater(tab)) {
      menu(
        [
          { label: 'Return to original folder', icon: 'group', run: () => returnSavedTab(id) },
          {
            label: tab.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab',
            icon: 'speaker',
            run: () => action('muteTab', { id }),
          },
          { label: 'Copy URL', icon: 'copy', run: () => copyUrls(kind, id) },
          null,
          { label: 'Close tab', icon: 'close', run: () => action('closeTab', { id }) },
        ],
        x,
        y,
      );
      return;
    }
    const domain = domainForTab(tab);
    menu(
      [
        { label: 'Save for later', icon: 'later', run: () => saveTabForLater(id) },
        {
          label: 'Filter by domain',
          icon: 'search',
          run: () => filterByDomain(domain, id),
          disabled: !domain,
        },
        ...(domainFilter
          ? [{ label: 'Show in folder', icon: 'group', run: () => showTabInFolder(id) }]
          : []),
        null,
        { label: 'New child tab', icon: 'plus', run: () => action('newChildTab', { id }) },
        ...(tab.parentTabId !== null
          ? [{ label: 'Detach from parent', icon: 'back', run: () => action('detachTab', { id }) }]
          : []),
        ...(!domainFilter && !tab.pinned && tabChildren(treeTabs, id).length
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
        { label: 'Close tab', icon: 'close', run: () => closeTab(id) },
        ...(!domainFilter && tabSubtree(state.tabs, id).length > 1
          ? [
              {
                label: 'Close tab and nested tabs…',
                icon: 'close',
                run: () => closeTabTreeDialog(id),
              },
            ]
          : []),
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
  canStart: () =>
    Boolean(state) && !domainFilter && !movingItem && !activeActions && !$('dialog').open,
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
    refreshScheduler.resume();
  },
});

$('home').append(icon('home'));
$('search-toggle').append(icon('search'));
$('settings').append(icon('settings'));
$('search-close').append(icon('close'));
$('domain-close').append(icon('close'));
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
$('domain-close').addEventListener('click', () => leaveDomain());
$('domain-search').addEventListener('input', () => {
  searchScroll = 0;
  render();
});
$('domain-back').prepend(icon('back'));
$('domain-back').addEventListener('click', () => {
  leaveDomain({ restoreFocus: false });
  domainsView.open({ restore: true });
});
$('domain-actions').append(icon('more'));
$('domain-actions').addEventListener('click', (event) =>
  collectionMenu(
    event,
    {
      kind: 'domain',
      domain: domainFilter,
      query: $('domain-search').value,
    },
    domainVisibleTabs,
    true,
  ),
);
$('domain-sort').addEventListener('change', () => {
  domainSort = $('domain-sort').value;
  searchScroll = 0;
  render();
});
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
$('reveal').addEventListener('click', () => blankAreaAction('revealActive'));
$('new-tab').addEventListener('click', (event) => {
  const result = action('newTab', { groupId: state.view.scopeId });
  treeMotion.addFeedback(event.currentTarget);
  return result;
});
$('new-tab').addEventListener('contextmenu', (event) => newTabMenu(event, state?.view.scopeId));
$('new-tab').addEventListener('keydown', (event) => newTabMenu(event, state?.view.scopeId));
$('new-group').addEventListener('click', () => createDialog());
$('tree-toggle').addEventListener('click', async () => {
  if (!state || changingTree || domainFilter || laterView.isOpen || $('search').value.trim())
    return;
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
  const dismissSearch = shouldDismissSearch(event);
  const dismissDomain = domainFilter && event.target.closest('footer');
  // Clearing the filter must not move or replace a target before its click.
  if (
    event.target.closest('.row, .pinned-tab, .recently-closed-row, .domains-row, .later-row') ||
    dismissSearch ||
    dismissDomain
  )
    pointerHeld = true;
  if (dismissDomain) leaveDomain({ restoreFocus: false });
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
    if (domainFilter && event.target.closest('footer')) leaveDomain({ restoreFocus: false });
    if (!shouldDismissSearch(event)) return;
    // Keyboard and assistive clicks have no pointerdown. Let the control act
    // before rendering the unfiltered tree, including buttons that stop bubbling.
    setTimeout(() => {
      if (shouldDismissSearch(event)) showSearch(false, { restoreFocus: false });
    }, 0);
  },
  true,
);

function shouldDismissSearch({ target, button, ctrlKey }) {
  // Right-click and macOS Control-click inspect a result without leaving search.
  // Its menu and dialogs remain part of that interaction until an action navigates.
  const contextPress = button === 2 || (button === 0 && ctrlKey);
  return (
    searchOpen &&
    !contextPress &&
    !$('navigation-capsule').contains(target) &&
    !$('menu').contains(target) &&
    !$('dialog').contains(target) &&
    !target.closest('.saved-search-results, #toast')
  );
}

for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    pointerHeld = false;
    if (!drag) {
      if (renderPending) scheduleRefresh();
      else refreshScheduler.resume();
    }
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
    if (domainFilter) {
      $('domain-search').focus();
      $('domain-search').select();
    } else if (laterView.isOpen) laterView.focusSearch();
    else showSearch();
  }
  if (event.key === 'Escape' && domainFilter) {
    event.preventDefault();
    if (event.target === $('domain-search') && $('domain-search').value) {
      $('domain-search').value = '';
      render();
    } else leaveDomain();
  } else if (event.key === 'Escape' && searchOpen) {
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
    const controller = await connectDemo(scheduleRefresh, closeFilter);
    if (disposed) return;
    windowId = 1;
    request = (type, args = {}) => controller.request({ type, windowId, ...args });
  } else if (globalThis.browser?.runtime?.id) {
    const currentWindow = await browser.windows.getCurrent();
    if (disposed) return;
    windowId = currentWindow.id;
    windowFocused = Boolean(currentWindow.focused);
    browser.windows.onFocusChanged?.addListener((id) => {
      const focused = id === windowId;
      if (focused && !windowFocused) windowFocusedAt = performance.now();
      windowFocused = focused;
    });

    const send = async (type, args = {}) => {
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

    readSnapshot = createSnapshotReader((snapshotToken) =>
      send('snapshot', { incremental: true, snapshotToken }),
    );
    request = (type, args) =>
      (type === 'snapshot'
        ? readSnapshot()
        : readSnapshot.perform((snapshotToken) =>
            send(type, { ...args, incremental: 2, snapshotToken }),
          )
      ).finally(() => {
        // Late action and recovery responses cannot repopulate a disposed view.
        if (disposed) readSnapshot.clear();
      });
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === 'tabernacle:changed') scheduleRefresh(message);
      if (message.type === 'tabernacle:getCloseFilter' && message.windowId === windowId)
        return Promise.resolve(closeFilter());
    });
  } else
    throw new Error('Load Tabernacle as a Firefox extension, or open the interactive preview.');
  await refresh();
}

start().catch((error) => {
  if (disposed) return;
  tree.replaceChildren(el('p', 'loading', error.message));
});
