import { reconcileChildren } from '../dom.js';
import { groupById, groupPath } from '../model.js';

// One instance belongs to one sidebar document. The entry point owns application state.
export function createSidebarNavigation({
  $,
  getIndex,
  getSearchOpen,
  getDomainFilter,
  getAudioInGroups,
  getState,
  getMenuReturnFocus,
  el,
  button,
  enter,
  playingLabel,
  audioIndicator,
  groupContainerDetails,
  closeMenu,
  menu,
  dropTarget,
}) {
  let breadcrumbKey;

  let breadcrumbItems = [];

  let folderMenuKey;

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

  const pathOverflowSeparator = folderChevron(null, 'Home');

  const homeLabel = el('span', 'crumb-label', 'Home');

  function layoutBreadcrumbs() {
    const path = $('group-path');
    const pathMenuOpen = !$('menu').hidden && $('menu').classList.contains('path-menu');
    const focused = pathMenuOpen ? getMenuReturnFocus() : document.activeElement;
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

    if (!getSearchOpen() && !getDomainFilter() && (pathHadFocus || pathMenuOpen)) {
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
      current: group.id === getState().view.scopeId,

      run: async () => {
        if (group.id !== getState().view.scopeId) await enter(group.id);
        ($('scope-heading') || $('home')).focus({ preventScroll: true });
      },
    };
  }

  function togglePathMenu() {
    if (!getState()) return;
    if (pathOverflow.getAttribute('aria-expanded') === 'true') {
      closeMenu(true);
      return;
    }
    const path = [{ id: null, name: 'Home' }, ...groupPath(getState(), getState().view.scopeId)];
    const rect = pathOverflow.getBoundingClientRect();
    menu(path.map(folderMenuItem), rect.left, rect.bottom + 8, {
      path: true,
      trigger: pathOverflow,
    });
    pathOverflow.setAttribute('aria-expanded', 'true');
  }

  function folderHierarchyKey() {
    return JSON.stringify(getState().groups.map(({ id, parentId, name }) => [id, parentId, name]));
  }

  function toggleFolderMenu(trigger, parentId) {
    if (!getState()) return;
    if (trigger.getAttribute('aria-expanded') === 'true') {
      closeMenu(true);
      return;
    }
    const items = [];
    const pending = (getIndex().groupChildren.get(parentId) || [])
      .map((group) => ({ group, depth: 0 }))
      .reverse();
    while (pending.length) {
      const { group, depth } = pending.pop();
      items.push(folderMenuItem(group, depth));
      const children = getIndex().groupChildren.get(group.id) || [];
      for (let i = children.length - 1; i >= 0; i--)
        pending.push({ group: children[i], depth: depth + 1 });
    }
    const parentName = groupById(getState(), parentId)?.name || 'Home';
    const rect = trigger.getBoundingClientRect();
    menu(items, rect.left, rect.bottom + 8, {
      path: true,
      label: `Folders in ${parentName}`,
      trigger,
    });
    trigger.setAttribute('aria-expanded', 'true');
    folderMenuKey = folderHierarchyKey();
  }

  function renderBreadcrumbs(scope) {
    const crumbs = getIndex().folders.path(getState().view.scopeId);
    const scopeContainer = scope && groupContainerDetails(scope);
    const scopeAudio = getAudioInGroups().get(scope?.id);
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

  function resetNavigationMenu(trigger) {
    folderMenuKey = undefined;
    pathOverflow.setAttribute('aria-expanded', 'false');
    if (trigger?.matches('.crumb-children')) trigger.setAttribute('aria-expanded', 'false');
  }

  function clearNavigation() {
    for (const pair of breadcrumbItems) for (const node of pair) node.remove();
    breadcrumbItems = [];
    breadcrumbKey = undefined;
  }

  function validateFolderMenu() {
    if (folderMenuKey && folderMenuKey !== folderHierarchyKey()) closeMenu(true);
  }

  function renderHome(scope) {
    if (scope) {
      $('home').removeAttribute('aria-current');
      homeLabel.remove();
    } else {
      $('home').setAttribute('aria-current', 'location');
      if (!homeLabel.isConnected) $('home').append(homeLabel);
    }
  }

  pathOverflow.id = 'path-overflow';
  new ResizeObserver(layoutBreadcrumbs).observe($('group-path'));
  document.fonts.ready.then(layoutBreadcrumbs);
  window.addEventListener('resize', () => {
    if (!$('menu').hidden && $('menu').classList.contains('path-menu')) closeMenu(true);
  });

  return {
    pathOverflow,
    layoutBreadcrumbs,
    renderBreadcrumbs,
    resetNavigationMenu,
    clearNavigation,
    validateFolderMenu,
    renderHome,
  };
}
