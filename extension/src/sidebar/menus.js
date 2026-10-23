import { batchSummary } from '../collection-dialogs.js';
import { folderCollection, sourceUrl, captureTarget } from '../tab-collection.js';
import { createFolderIndex } from '../folder-index.js';
import { icon } from '../icons.js';
import { domainForTab } from '../domain-filter.js';
import { isSavedForLater, sortTabs, tabChildren, tabSubtree } from '../model.js';

// One instance belongs to one sidebar document. The entry point owns application state.
export function createSidebarMenus({
  $,
  tree,
  getTreeTabs,
  getDomainFilter,
  getRecentlyClosed,
  getState,
  getDrag,
  getMovingItem,
  saveTabForLater,
  returnSavedTab,
  el,
  button,
  announce,
  getCreateDialog,
  getRenameDialog,
  getAppearanceDialog,
  getPinFolderDialog,
  getRemoveDialog,
  getCloseGroupTabsDialog,
  getCloseTabTreeDialog,
  getCloseCollection,
  getReviewDuplicates,
  getMoveDialog,
  getContainerDialog,
  getNewContainerDialog,
  getGroupContainerDialog,
  action,
  cancelGroupClick,
  enter,
  revealFolder,
  closeTab,
  filterByDomain,
  showTabInFolder,
  blankAreaAction,
  resetNavigationMenu,
}) {
  let menuReturnFocus;

  function closeMenu(restore = false) {
    getRecentlyClosed()?.close(restore);
    $('menu').hidden = true;
    resetNavigationMenu(menuReturnFocus);
    if (restore && menuReturnFocus?.isConnected) menuReturnFocus.focus();
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

  function newTabMenu(event, groupId, parentTabId = null) {
    const keyboard = event.type === 'keydown';
    if (
      !getState() ||
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
            { label: 'New folder…', icon: 'groupPlus', run: () => getCreateDialog()(groupId) },
          ],
      keyboard ? rect.left : event.clientX,
      keyboard ? rect.bottom : event.clientY,
    );
    return true;
  }

  function blankAreaMenu(x, y) {
    const groupId = getState().view.scopeId;
    menu(
      [
        { label: 'New tab', icon: 'plus', run: () => blankAreaAction('newTab', { groupId }) },
        {
          label: 'New tab in container…',
          icon: 'container',
          run: () => getNewContainerDialog()(groupId),
        },
        { label: 'New folder…', icon: 'groupPlus', run: () => getCreateDialog()(groupId) },
        ...(groupId !== null
          ? [
              {
                label: 'Icon and colour…',
                icon: 'rename',
                run: () => getAppearanceDialog()(groupId),
              },
              {
                label: 'Default container…',
                icon: 'container',
                run: () => getGroupContainerDialog()(groupId),
              },
            ]
          : []),
        null,
        {
          label: 'Undo last closed tab',
          icon: 'undo',
          disabled: !getState().canUndoClose,
          run: () => blankAreaAction('undoCloseTab'),
        },
        {
          label: 'Show current tab',
          icon: 'enter',
          disabled: !getState().tabs.some((tab) => tab.active),
          run: () => blankAreaAction('revealActive'),
        },
        null,
        {
          label: 'Expand all folders',
          icon: 'expand',
          disabled: !getState().groups.length,
          run: () => action('collapseAll', { collapsed: false }),
        },
        {
          label: 'Collapse all folders',
          icon: 'collapse',
          disabled: !getState().groups.length,
          run: () => action('collapseAll', { collapsed: true }),
        },
      ],
      x,
      y,
    );
  }

  function isBlankArea(target) {
    return (
      getState() &&
      !getDrag() &&
      (target === tree || (target.closest('.empty-state') && !target.closest('button, a, input')))
    );
  }

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
                run: () => getCloseCollection()(scope, tabs),
                danger: true,
              },
              null,
            ]
          : []),
        {
          label: 'Review duplicates…',
          icon: 'copy',
          run: () => getReviewDuplicates()(scope, tabs),
        },
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
    const folders = kind === 'group' ? createFolderIndex(getState()) : null;
    const tabs =
      kind === 'group'
        ? sortTabs(
            getState().tabs.filter(
              (tab) => !isSavedForLater(tab) && folders.isWithin(tab.groupId, id),
            ),
          )
        : getState().tabs.filter((tab) => tab.id === id);
    return copyTabUrls(tabs, kind === 'group' ? 'No URLs to copy in this folder.' : undefined);
  }

  function contextMenu(kind, id, x, y) {
    if (getMovingItem()) return;
    const folderTabs = kind === 'group' ? folderCollection(getState(), id) : [];
    const unsavedFolderTabs = folderTabs.filter((tab) => !isSavedForLater(tab));
    if (kind === 'group')
      menu(
        [
          { label: 'Open folder', icon: 'enter', run: () => enter(id) },
          { label: 'Show in tree', icon: 'group', run: () => revealFolder(id) },
          ...(getState().folderPins.some((item) => item.id === id)
            ? [
                {
                  label: 'Change default action…',
                  icon: 'pin',
                  run: () => getPinFolderDialog()(id),
                },
                {
                  label: 'Unpin folder',
                  icon: 'pin',
                  run: () => action('setGroupPin', { id, action: null }),
                },
              ]
            : [{ label: 'Pin folder…', icon: 'pin', run: () => getPinFolderDialog()(id) }]),
          null,
          {
            label: 'New tab here',
            icon: 'plus',
            run: () => action('newTab', { groupId: id }),
          },
          {
            label: 'New subfolder',
            icon: 'groupPlus',
            run: () => getCreateDialog()(id),
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
            run: () => getReviewDuplicates()({ kind: 'folder', id }, folderTabs),
          },
          { label: 'Copy URLs', icon: 'copy', run: () => copyUrls(kind, id) },
          { label: 'Rename folder', icon: 'rename', run: () => getRenameDialog()(id) },
          { label: 'Icon and colour…', icon: 'rename', run: () => getAppearanceDialog()(id) },
          {
            label: 'Default container…',
            icon: 'container',
            run: () => getGroupContainerDialog()(id),
          },
          {
            label: 'Move folder…',
            icon: 'group',
            run: () => getMoveDialog()(kind, id),
          },
          {
            label: 'Move contents…',
            icon: 'group',
            run: () => getMoveDialog()('contents', id),
          },
          null,
          {
            label: 'Close all tabs…',
            icon: 'close',
            run: () => getCloseGroupTabsDialog()(id),
            disabled: !unsavedFolderTabs.length,
            danger: true,
          },
          {
            label: 'Delete folder…',
            icon: 'trash',
            run: () => getRemoveDialog()(id),
            danger: true,
          },
        ],
        x,
        y,
      );
    else {
      const tab = getState().tabs.find((tab) => tab.id === id);
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
          ...(getDomainFilter()
            ? [{ label: 'Show in folder', icon: 'group', run: () => showTabInFolder(id) }]
            : []),
          null,
          { label: 'New child tab', icon: 'plus', run: () => action('newChildTab', { id }) },
          ...(tab.parentTabId !== null
            ? [
                {
                  label: 'Detach from parent',
                  icon: 'back',
                  run: () => action('detachTab', { id }),
                },
              ]
            : []),
          ...(!getDomainFilter() && !tab.pinned && tabChildren(getTreeTabs(), id).length
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
            run: () => getMoveDialog()(kind, id),
          },
          {
            label: 'Reopen in container…',
            icon: 'container',
            run: () => getContainerDialog()(id),
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
          ...(!getDomainFilter() && tabSubtree(getState().tabs, id).length > 1
            ? [
                {
                  label: 'Close tab and nested tabs…',
                  icon: 'close',
                  run: () => getCloseTabTreeDialog()(id),
                },
              ]
            : []),
        ],
        x,
        y,
      );
    }
  }

  function clearMenu() {
    $('menu').replaceChildren();
    menuReturnFocus = undefined;
  }

  function menuKey(event) {
    if (!$('menu').hidden) {
      const buttons = [...$('menu').querySelectorAll('button:enabled')],
        index = buttons.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
        return true;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        buttons[
          (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
        return true;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        (event.key === 'Home' ? buttons[0] : buttons.at(-1))?.focus();
        return true;
      }
      if (event.key === 'Tab') closeMenu($('menu').classList.contains('path-menu'));
    }
    return false;
  }

  return {
    get menuReturnFocus() {
      return menuReturnFocus;
    },

    closeMenu,
    menu,
    newTabMenu,
    blankAreaMenu,
    isBlankArea,
    collectionMenu,
    contextMenu,
    clearMenu,
    menuKey,
  };
}
