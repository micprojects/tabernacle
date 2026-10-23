import { createSidebarControls } from './sidebar/controls.js';
import { createSidebarMenus } from './sidebar/menus.js';
import { createSidebarNavigation } from './sidebar/navigation.js';
import { createSidebarRows } from './sidebar/rows.js';
import { createFullTreeRenderer } from './tree/full-renderer.js';
import { createRefreshScheduler } from './refresh-scheduler.js';
import { createSnapshotReader } from './snapshot-transfer.js';
import { icon } from './icons.js';
import { createTreeIndex, scopeBranches, updateTreeAudio } from './tree/index.js';
import { projectTree, createDomainTreeProjector } from './tree/projection.js';
import { createViewportTreeRenderer } from './tree/viewport.js';
import { captureScroll, restoreScroll } from './view-state.js';
import { createDomainHeader } from './domain-header.js';
import { createDomainsView } from './domains-view.js';
import { createLaterView } from './later-view.js';
import { setAttribute } from './dom.js';
import { createTreeMotion } from './tree/motion.js';
import { createFaviconTints } from './favicon-tint.js';
import { createLabelColors } from './label-colors.js';
import { createDialogs } from './dialogs.js';
import { createPointerMove } from './pointer-move.js';
import { createRecentActivity } from './recently-closed.js';
import { createActivityLauncher } from './activity-launcher.js';
import { openDemoPage } from './internal-pages.js';
import { groupById, isSavedForLater, tabChildren } from './model.js';

const controls = createSidebarControls();
const { el, button } = controls;

const $ = (id) => document.getElementById(id);
const tree = $('tree');
let treeTabs = [];
let index;
let projection;
const domainProjector = createDomainTreeProjector();
const faviconTint = createFaviconTints();
const renderDomainHeader = createDomainHeader($('domain-header'));
const labelColors = createLabelColors(document.documentElement, document.querySelector('.sidebar'));
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

let audioInTabs = new Map(),
  audioInGroups = new Map();
let recentlyClosed;
const darkMode = matchMedia('(prefers-color-scheme: dark)');
const forcedColors = matchMedia('(forced-colors: active)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const treeMotion = createTreeMotion(
  tree,
  () => state?.look.animations !== false && !reducedMotion.matches,
  () => {
    detachRows();
    queueMicrotask(() => treeRenderer.refresh(true));
  },
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
let state, request, windowId, selected, drag, toastTimer;
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
  domainProjector.clear();
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

const menus = createSidebarMenus({
  $,
  tree,
  getTreeTabs: () => treeTabs,
  getDomainFilter: () => domainFilter,
  getRecentlyClosed: () => recentlyClosed,
  getState: () => state,
  getDrag: () => drag,
  getMovingItem: () => movingItem,
  saveTabForLater,
  returnSavedTab,
  el,
  button,
  announce,
  getCreateDialog: () => createDialog,
  getRenameDialog: () => renameDialog,
  getAppearanceDialog: () => appearanceDialog,
  getPinFolderDialog: () => pinFolderDialog,
  getRemoveDialog: () => removeDialog,
  getCloseGroupTabsDialog: () => closeGroupTabsDialog,
  getCloseTabTreeDialog: () => closeTabTreeDialog,
  getCloseCollection: () => closeCollection,
  getReviewDuplicates: () => reviewDuplicates,
  getMoveDialog: () => moveDialog,
  getContainerDialog: () => containerDialog,
  getNewContainerDialog: () => newContainerDialog,
  getGroupContainerDialog: () => groupContainerDialog,
  action,
  cancelGroupClick,
  enter,
  revealFolder,
  closeTab,
  filterByDomain,
  showTabInFolder,
  blankAreaAction,
  resetNavigationMenu: (...args) => resetNavigationMenu(...args),
});
const {
  closeMenu,
  menu,
  newTabMenu,
  blankAreaMenu,
  isBlankArea,
  collectionMenu,
  contextMenu,
  clearMenu,
  menuKey,
} = menus;

const navigation = createSidebarNavigation({
  $,
  getIndex: () => index,
  getSearchOpen: () => searchOpen,
  getDomainFilter: () => domainFilter,
  getAudioInGroups: () => audioInGroups,
  getState: () => state,
  getMenuReturnFocus: () => menus.menuReturnFocus,
  el,
  button,
  enter,
  playingLabel: (...args) => playingLabel(...args),
  audioIndicator: (...args) => audioIndicator(...args),
  groupContainerDetails: (...args) => groupContainerDetails(...args),
  closeMenu,
  menu,
  dropTarget,
});
const {
  pathOverflow,
  layoutBreadcrumbs,
  renderBreadcrumbs,
  resetNavigationMenu,
  clearNavigation,
  validateFolderMenu,
  renderHome,
} = navigation;

const rows = createSidebarRows({
  tree,
  getIndex: () => index,
  getProjection: () => projection,
  faviconTint,
  labelColors,
  getDomainFilter: () => domainFilter,
  getDomainSort: () => domainSort,
  getWindowFocused: () => windowFocused,

  setWindowFocusedAt: (value) => {
    windowFocusedAt = value;
  },

  canToggleTabChildren,
  getAudioInTabs: () => audioInTabs,
  getAudioInGroups: () => audioInGroups,
  treeMotion,
  getState: () => state,
  getSelected: () => selected,
  returnSavedTab,
  demo,
  el,
  button,
  action,
  getLastGroupClick: () => lastGroupClick,

  setLastGroupClick: (value) => {
    lastGroupClick = value;
  },

  setHandledGroupDoubleClick: (value) => {
    handledGroupDoubleClick = value;
  },

  getHandledGroupDoubleClick: () => handledGroupDoubleClick,
  cancelGroupClick,
  clickGroup,
  enter,
  revealFolder,
  parent,
  count,
  selectRow,
  closeTab,
  activateTab,
  getTreeRenderer: () => treeRenderer,
  moveTreeFocus,
  rowKey,
  blankAreaAction,
  newTabMenu,
  blankAreaMenu,
  isBlankArea,
  contextMenu,
  dropTarget,
});
const {
  renderRow,
  patchTab,
  patchGroup,
  prepareViewportRows,
  reconcileTreeChildren,
  playingLabel,
  audioIndicator,
  tabFavicon,
  groupContainerDetails,
  finishRows,
  clearRows,
  detachRows,
  beginRows,
  reuseRow,
  renderSaved,
} = rows;

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
  treeRenderer.ensureVisible(`group:${id}`);
  const row = treeRenderer.mount(`group:${id}`);
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

const treeRendererOptions = {
  tree,
  pins: $('pinned-tabs'),
  reconcile: reconcileTreeChildren,
  // Pane callers own focus, including close({ restoreFocus: false }).
  captureView: () => ({ scroll: captureScroll(tree, '.row, .new-tab-action') }),
  restoreView: (saved) => restoreScroll(tree, saved.scroll),

  renderRow,

  renderSaved,
};

const treeRenderer = createViewportTreeRenderer({
  ...treeRendererOptions,
  full: createFullTreeRenderer(treeRendererOptions),
  begin: beginRows,
  prepare: prepareViewportRows,
  finish: finishRows,

  reuse: (row) => {
    reuseRow(row.key);
  },

  retained: () => [
    selected,
    menus.menuReturnFocus?.closest('[data-key]')?.dataset.key,
    ...[...tree.querySelectorAll('.dragging, .move-complete')].map((row) => row.dataset.key),
  ],
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
    patchTab(tab);
  }
  for (const id of audio.groups) {
    audioInGroups.set(id, index.groupStats.get(id).audio);
    patchGroup(id);
  }
  if (audio.groups.has(state.view.scopeId)) renderBreadcrumbs(index.groups.get(state.view.scopeId));
  if (audioChanges.length) treeRenderer.refreshWidth();
  return true;
}

function restoreRowFocus(key) {
  if (document.activeElement?.closest('[data-key]')?.dataset.key === key) return;
  treeRenderer.mount(key)?.focus({ preventScroll: true });
}

function releaseTree() {
  treeMotion.finishAll();
  treeRenderer.suspend();
  projection = null;
  clearRows();
  treeTabs = [];
  index = undefined;
  domainProjector.clear();
  audioInTabs.clear();
  audioInGroups.clear();
  previousRender = null;
  domainVisibleTabs = [];
  searchVisibleIds = [];
  clearNavigation();
  clearMenu();
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
  beginRows();
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
  const options = { query, domain: domainFilter, sort: domainSort };
  // Domain query changes only need fresh text matches, not another full-tree
  // index, hostname scan and sort of the unchanged collection.
  projection = domainFilter
    ? domainProjector.project(state, options)
    : projectTree(state, createTreeIndex(state, query), options);
  index = projection.index;
  // Folder menus must not retain destinations renamed, moved or removed elsewhere.
  validateFolderMenu();
  updateTreeToggle(query);
  treeTabs = index.tabs;
  audioInTabs = index.audio;
  audioInGroups = new Map([...index.groupStats].map(([id, stats]) => [id, stats.audio]));
  const pins = state.pins;
  $('pinned-tabs').hidden = Boolean(domainFilter) || (!pins.length && !drag);
  $('pinned-tabs').classList.toggle('empty-pins', !pins.length && Boolean(drag));
  renderHome(scope);
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
  if (!treeRenderer.virtual) finishRows();
  // Native closes or another sidebar can remove the row owning an open menu.
  if (!$('menu').hidden && menus.menuReturnFocus && !menus.menuReturnFocus.isConnected) closeMenu();
  $('new-tab').title = scope ? `New tab in ${scope.name}` : 'New tab';
  tree.scrollTop = searchScroll ?? scroll;
  if (treeRenderer.virtual) treeRenderer.refresh();
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
  domainProjector.clear();
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
    const row = selected && treeRenderer.mount(selected);
    (row || $('scope-heading') || $('home')).focus({ preventScroll: true });
  }
}

async function showTabInFolder(id) {
  const tab = state.tabs.find((tab) => tab.id === id);
  if (!tab) return;
  await enter(tab.groupId);
  const next = await action('activateTab', { id, reveal: true });
  if (!next) return;
  const row = treeRenderer.mount(`tab:${id}`);
  if (row) {
    selectRow(row);
    treeRenderer.ensureVisible(`tab:${id}`);
  }
}

function moveTreeFocus(event, row) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
  event.preventDefault();
  const rows = projection?.visibleRows || [];
  const position = rows.findIndex((item) => item.key === row.dataset.key);
  const next =
    event.key === 'Home'
      ? rows[0]
      : event.key === 'End'
        ? rows.at(-1)
        : rows[position + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    treeRenderer.ensureVisible(next.key);
    const target = treeRenderer.mount(next.key);
    if (target) selectRow(target);
  }
  return true;
}

function rowKey(event, row, kind, id) {
  cancelGroupClick();
  if (event.target !== row || moveTreeFocus(event, row)) return;
  const rows = projection?.visibleRows || [];
  const index = rows.findIndex((item) => item.key === row.dataset.key);
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
    else if (rows[index + 1]) {
      treeRenderer.ensureVisible(rows[index + 1].key);
      selectRow(treeRenderer.mount(rows[index + 1].key));
    }
  } else if (event.key === 'ArrowLeft' && !event.altKey) {
    event.preventDefault();
    if (domainFilter) return;
    if (hasChildren && !collapsed) toggle();
    else {
      const parentKey =
        tab?.parentTabId != null
          ? `tab:${tab.parentTabId}`
          : `group:${kind === 'group' ? groupById(state, id)?.parentId : tab?.groupId}`;
      const parentRow =
        rows.some((item) => item.key === parentKey) && treeRenderer.mount(parentKey);
      if (parentRow) {
        treeRenderer.ensureVisible(parentKey);
        selectRow(parentRow);
      } else parent();
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

function dropTarget(node, kind, id) {
  node.dataset.dropKind = kind;
  node.dataset.dropId = id ?? '';
}

function showMovedItem(source) {
  if (!source) return false;
  if (source.kind !== 'pin-group') treeRenderer.ensureVisible(`${source.kind}:${source.id}`);
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
  if (menuKey(event)) return;
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
