import { icon } from './icons.js';
import { bookmarkRows, bookmarkHighlights } from './bookmarks.js';
import { createSidebarControls } from './sidebar/controls.js';
import { reconcileChildren, setAttribute } from './dom.js';
import { captureScroll, restoreScroll } from './view-state.js';
import { indexBookmarks, bookmarkEditable } from './bookmark-edit.js';
import { createBookmarkDrag } from './bookmark-drag.js';
import { groupContainer } from './model.js';

export function createBookmarksView({
  root,
  getState,
  getBrowser,
  onOpen,
  onClose,
  onSelect,
  onMenu,
  onMove,
  onEdit,
  onDelete,
}) {
  const { el, button } = createSidebarControls();
  const events = new AbortController();
  const pane = el('section', 'bookmarks-view');
  pane.id = 'bookmarks-view';
  pane.hidden = true;
  pane.setAttribute('aria-labelledby', 'bookmarks-title');
  const heading = el('div', 'pane-heading');
  const dismiss = button('Back to tabs', 'back', () => close(true), 'pane-back');
  dismiss.append(el('span', '', 'Tabs'));
  const title = el('h1', '', 'Bookmarks');
  title.id = 'bookmarks-title';
  const manage = button('Bookmark actions', 'more', (event) => onMenu?.(null, event));
  manage.disabled = true;
  heading.append(dismiss, title, manage);
  const destination = el('p', 'bookmarks-destination');
  const destinationLabel = el('span', 'bookmarks-destination-label');
  const containerLabel = el('span', 'bookmarks-container');
  destination.append(destinationLabel, containerLabel);
  const searchField = el('label', 'recent-search');
  const search = el('input');
  search.id = 'bookmarks-search';
  search.type = 'search';
  search.placeholder = 'Search bookmarks';
  search.setAttribute('aria-label', 'Search bookmarks');
  search.setAttribute('aria-controls', 'bookmarks-tree');
  search.autocomplete = 'off';
  const clearSearch = button(
    'Clear bookmark search',
    'closeSmall',
    () => clearQuery(),
    'bookmark-search-clear',
  );
  clearSearch.hidden = true;
  searchField.append(icon('search'), search, clearSearch);
  const results = el('span', 'bookmarks-results');
  results.setAttribute('aria-live', 'polite');
  const list = el('div', 'tree bookmarks-tree');
  list.id = 'bookmarks-tree';
  list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', 'Bookmarks');
  const status = el('div', 'bookmarks-status');
  const message = el('p');
  message.setAttribute('role', 'status');
  const retry = button('Try again', null, () => refresh(), 'pane-back');
  retry.textContent = 'Try again';
  const allow = button('Allow bookmarks', null, grant, 'pane-back');
  allow.textContent = 'Allow bookmarks';
  status.append(message, allow, retry);
  pane.append(heading, destination, searchField, results, status, list);
  root.prepend(pane);
  const trigger = button('Bookmarks', 'bookmark', () => (pane.hidden ? open() : close(true)), '');
  trigger.id = 'bookmarks-toggle';
  trigger.disabled = true;
  trigger.setAttribute('aria-controls', pane.id);
  trigger.setAttribute('aria-expanded', 'false');
  root.querySelector('#recently-closed-toggle').before(trigger);
  const fold = root.querySelector('#tree-toggle');
  let foldDisabled, tree, index, api, timer, loading;
  let disposed = false;
  let generation = 0;
  let sessionToken = 0;
  let expanded = new Set();
  const searchCollapsed = new Set();
  const rows = new Map();
  let entries = [];
  let selectedId;
  let pendingOpen;
  let loadError;
  let initialised = false;
  let savedScroll;
  const subscriptions = [];
  const drag = createBookmarkDrag({
    root: pane,
    list,
    getIndex: () => index,
    captureExpansion: () => ({ expanded: new Set(expanded), collapsed: new Set(searchCollapsed) }),

    restoreExpansion(saved) {
      expanded = saved.expanded;
      searchCollapsed.clear();
      for (const id of saved.collapsed) searchCollapsed.add(id);
      render();
    },

    expand(id) {
      expanded.add(id);
      searchCollapsed.delete(id);
      render();
    },

    commit: (...args) => onMove?.(...args),
  });

  function showStatus(text, { permission = false, failed = false } = {}) {
    message.textContent = text;
    allow.hidden = !permission;
    retry.hidden = !failed;
    status.hidden = !text;
  }

  function unsubscribe() {
    // Revoking an optional Firefox permission removes methods from existing
    // event objects as well as from the browser namespace.
    for (const [event, listener] of subscriptions.splice(0)) event.removeListener?.(listener);
    clearTimeout(timer);
  }

  function subscribe() {
    unsubscribe();

    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh(), 80);
    };

    for (const name of [
      'onCreated',
      'onRemoved',
      'onChanged',
      'onMoved',
      'onChildrenReordered',
      'onImportEnded',
    ]) {
      const event = api.bookmarks?.[name];
      if (event?.addListener) {
        event.addListener(changed);
        subscriptions.push([event, changed]);
      }
    }
    for (const name of ['onAdded', 'onRemoved']) {
      const event = api.permissions?.[name];
      if (event) {
        event.addListener(changed);
        subscriptions.push([event, changed]);
      }
    }
  }

  async function refresh() {
    if (disposed || pane.hidden) return;
    const current = ++generation;
    loading = true;
    if (!tree) showStatus('Loading bookmarks…');
    try {
      const permitted = await api.permissions.contains({ permissions: ['bookmarks'] });
      if (current !== generation || disposed || pane.hidden) return;
      if (!permitted) {
        loadError = null;
        tree = null;
        index = null;
        manage.disabled = true;
        clearSearch.hidden = true;
        results.textContent = '';
        rows.clear();
        entries = [];
        list.replaceChildren();
        search.disabled = true;
        showStatus('Allow Tabernacle to show your Firefox bookmarks.', { permission: true });
        subscribe();
        return;
      }
      // Listen before the read so edits made while getTree() is in flight
      // schedule a fresh read instead of leaving a stale tree until reopening.
      subscribe();
      const next = await api.bookmarks.getTree();
      if (current !== generation || disposed || pane.hidden) return;
      if (!Array.isArray(next) || !Array.isArray(next[0]?.children))
        throw new Error('Firefox returned an unreadable bookmark tree.');
      if (!initialised) {
        expanded = new Set(
          next[0].children.filter((node) => node.type === 'folder').map((node) => node.id),
        );
      }
      const nextIndex = indexBookmarks(next);
      tree = next;
      index = nextIndex;
      initialised = true;
      manage.disabled = false;
      loadError = null;
      search.disabled = false;
      render();
      if (savedScroll) {
        restoreScroll(list, savedScroll);
        savedScroll = null;
      }
    } catch (error) {
      if (current === generation && !disposed && !pane.hidden) {
        loadError = `Could not load bookmarks. ${error.message}`;
        showStatus(loadError, { failed: true });
      }
    } finally {
      if (current === generation) loading = false;
    }
  }

  async function grant() {
    // Call directly in the click handler: Firefox requires a user gesture.
    const result = api.permissions.request({ permissions: ['bookmarks'] });
    allow.disabled = true;
    try {
      await result;
      await refresh();
    } catch (error) {
      if (!disposed && !pane.hidden) showStatus(error.message, { permission: true });
    } finally {
      allow.disabled = false;
    }
  }

  function makeRow(entry) {
    const wrapper = el('div', entry.folder ? 'group-node' : 'tab-node');
    wrapper.setAttribute('role', 'none');
    const row = el('div', `row bookmark-row ${entry.folder ? 'group-row' : 'tab-row'}`);
    row.dataset.bookmarkId = entry.id;
    row.setAttribute('role', 'treeitem');
    const slot = el('span', 'icon-slot');
    const label = el('span', 'label');
    const text = el('span', 'bookmark-text');
    const address = el('span', 'bookmark-address');
    text.append(label, address);
    row.append(slot, text);
    const branch = el('div', 'branch');
    branch.setAttribute('role', 'group');
    const count = el('span', 'bookmark-count');
    if (entry.folder) row.append(count, icon('chevron', 'group-chevron'));
    const more = button(
      `Actions for ${entry.title}`,
      'more',
      (event) => {
        focus(entry.id);
        onMenu?.(entry.id, event);
      },
      'icon-button bookmark-more',
    );
    more.tabIndex = -1;
    more.setAttribute('aria-haspopup', 'menu');
    row.append(more);
    wrapper.append(row);
    const empty = el('p', 'bookmark-empty', 'Empty folder');
    return { wrapper, row, slot, label, branch, more, address, count, empty };
  }

  function highlight(node, text) {
    const key = JSON.stringify([text, search.value]);
    if (node.dataset.highlight === key) return;
    node.dataset.highlight = key;
    node.replaceChildren(
      ...bookmarkHighlights(text, search.value).map((part) =>
        part.match ? el('mark', '', part.text) : document.createTextNode(part.text),
      ),
    );
  }

  function clearQuery() {
    savedScroll = null;
    search.value = '';
    searchCollapsed.clear();
    render();
    search.focus();
  }

  function render() {
    if (!tree || pane.hidden || disposed) return;
    const focused = document.activeElement?.closest('.bookmark-row');
    const focusedId = focused?.dataset.bookmarkId;
    const oldIndex = entries.findIndex((entry) => entry.id === focusedId);
    const scroll = captureScroll(list, '.bookmark-row', 'data-bookmark-id');
    entries = bookmarkRows(tree, expanded, search.value, searchCollapsed);
    clearSearch.hidden = !search.value;
    const searching = Boolean(search.value.trim());
    const matchCount = entries.filter((entry) => entry.match).length;
    results.textContent = searching
      ? `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`
      : '';
    const alive = new Set(entries.map((entry) => entry.id));
    if (!alive.has(selectedId))
      selectedId = entries[Math.max(0, Math.min(oldIndex, entries.length - 1))]?.id;
    const children = new Map([[null, []]]);
    for (const entry of entries) {
      let item = rows.get(entry.id);
      if (!item) rows.set(entry.id, (item = makeRow(entry)));
      item.entry = entry;
      setAttribute(item.row, 'aria-label', entry.title);
      setAttribute(item.row, 'aria-level', entry.depth);
      setAttribute(item.row, 'tabindex', selectedId === entry.id ? 0 : -1);
      setAttribute(item.row, 'title', entry.url ? `${entry.title}\n${entry.url}` : entry.title);
      setAttribute(item.more, 'aria-label', `Actions for ${entry.title}`);
      setAttribute(item.more, 'title', `Actions for ${entry.title}`);
      highlight(item.label, entry.title);
      item.address.hidden = !searching || !entry.url;
      if (entry.url) {
        let address = entry.url;
        try {
          address = new URL(entry.url).host || entry.url;
        } catch {
          /* Preserve unusual bookmark addresses. */
        }
        // Show the matching address when the host alone cannot explain a URL match.
        if (
          searching &&
          search.value
            .trim()
            .toLocaleLowerCase()
            .split(/\s+/)
            .some(
              (term) =>
                entry.url.toLocaleLowerCase().includes(term) &&
                !address.toLocaleLowerCase().includes(term),
            )
        )
          address = entry.url;
        highlight(item.address, address);
      }
      if (entry.folder) {
        const count = String(entry.childCount);
        if (item.count.textContent !== count) item.count.textContent = count;
        item.count.setAttribute('aria-label', `${count} items`);
        item.count.title = `${count} ${entry.childCount === 1 ? 'item' : 'items'} in this folder`;
      }
      const glyph = entry.folder ? (entry.expanded ? 'groupOpen' : 'group') : 'bookmark';
      if (item.glyph !== glyph) {
        item.slot.replaceChildren(icon(glyph));
        item.glyph = glyph;
      }
      if (entry.folder) {
        setAttribute(item.row, 'aria-expanded', entry.expanded);
        reconcileChildren(item.wrapper, entry.expanded ? [item.row, item.branch] : [item.row]);
      }
      const parentId = entry.parentId || null;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(item.wrapper);
    }
    for (const entry of entries)
      if (entry.folder) {
        const branch = rows.get(entry.id).branch;
        const nested = children.get(entry.id) || [];
        if (!nested.length && !entry.childCount && entry.expanded)
          nested.push(rows.get(entry.id).empty);
        reconcileChildren(branch, nested);
        branch.hidden = !nested.length;
      }
    reconcileChildren(list, children.get(null));
    for (const id of rows.keys()) if (!alive.has(id)) rows.delete(id);
    showStatus(
      loadError ||
        (entries.length
          ? ''
          : search.value.trim()
            ? 'No matching bookmarks.'
            : 'No bookmarks yet.'),
      { failed: Boolean(loadError) },
    );
    restoreScroll(list, scroll);
    if (focusedId && !focused?.isConnected)
      (rows.get(focusedId)?.row || rows.get(selectedId)?.row || search).focus({
        preventScroll: true,
      });
  }

  function focus(id) {
    selectedId = id;
    for (const [key, item] of rows) setAttribute(item.row, 'tabindex', key === id ? 0 : -1);
    rows.get(id)?.row.focus();
  }

  async function activate(item) {
    const entry = item.entry;
    if (entry.folder) {
      const set = search.value.trim() ? searchCollapsed : expanded;
      if (set.has(entry.id)) set.delete(entry.id);
      else set.add(entry.id);
      render();
      return;
    }
    if (pendingOpen?.busy) return;
    const groupId = getState().view.scopeId;
    if (pendingOpen?.id !== entry.id || pendingOpen.groupId !== groupId)
      pendingOpen = { id: entry.id, groupId, operationId: crypto.randomUUID() };
    const operation = pendingOpen;
    const openingSession = sessionToken;
    operation.busy = true;
    setAttribute(item.row, 'aria-busy', true);
    try {
      const opened = await onSelect(operation);
      if (opened) {
        if (pendingOpen === operation) pendingOpen = null;
        if (!disposed && openingSession === sessionToken) close(true);
      }
    } catch (error) {
      if (!disposed && openingSession === sessionToken) showStatus(error.message);
    } finally {
      operation.busy = false;
      item.row.removeAttribute('aria-busy');
    }
  }

  list.addEventListener('click', (event) => {
    const row = event.target.closest('.bookmark-row');
    const item = rows.get(row?.dataset.bookmarkId);
    if (!item || item.row !== row) return;
    focus(item.entry.id);
    activate(item);
  });
  list.addEventListener('focusin', (event) => {
    const id = event.target.closest('.bookmark-row')?.dataset.bookmarkId;
    if (!rows.has(id) || selectedId === id) return;
    selectedId = id;
    for (const [key, item] of rows) setAttribute(item.row, 'tabindex', key === id ? 0 : -1);
  });
  list.addEventListener('keydown', (event) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const item = rows.get(event.target.closest('.bookmark-row')?.dataset.bookmarkId);
    if (!item || event.target.closest('button')) return;
    const entry = item.entry;
    const rowIndex = entries.indexOf(entry);
    let next;
    if (event.key === 'ArrowDown') next = entries[Math.min(rowIndex + 1, entries.length - 1)];
    else if (event.key === 'ArrowUp') next = entries[Math.max(0, rowIndex - 1)];
    else if (event.key === 'Home') next = entries[0];
    else if (event.key === 'End') next = entries.at(-1);
    else if (event.key === 'ArrowRight') {
      if (entry.folder && !entry.expanded) activate(item);
      else if (entries[rowIndex + 1]?.parentId === entry.id) next = entries[rowIndex + 1];
    } else if (event.key === 'ArrowLeft') {
      if (entry.folder && entry.expanded) activate(item);
      else next = rows.get(entry.parentId)?.entry;
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      onMenu?.(entry.id, { target: item.row, type: 'keyboard' });
    } else if (event.key === 'F2' && bookmarkEditable(index, entry.id)) onEdit?.(entry.id);
    else if (event.key === 'Delete' && bookmarkEditable(index, entry.id)) {
      if (!event.repeat) onDelete?.(entry.id);
    } else if (event.key === 'Enter' || event.key === ' ') activate(item);
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (next) focus(next.id);
  });
  list.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.bookmark-row');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    focus(row.dataset.bookmarkId);
    onMenu?.(row.dataset.bookmarkId, {
      target: row,
      type: 'contextmenu',
      clientX: event.clientX,
      clientY: event.clientY,
    });
  });
  search.addEventListener('input', () => {
    savedScroll = null;
    searchCollapsed.clear();
    render();
    list.scrollTop = 0;
  });
  search.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' && entries.length) {
      event.preventDefault();
      focus((entries.find((entry) => entry.match) || entries[0]).id);
    } else if (event.key === 'Enter' && search.value.trim()) {
      const entry = entries.find((entry) => entry.match);
      if (!entry) return;
      event.preventDefault();
      focus(entry.id);
      if (!entry.folder) activate(rows.get(entry.id));
    }
  });

  function close(restoreFocus = false) {
    if (pane.hidden) return;
    savedScroll = captureScroll(list, '.bookmark-row', 'data-bookmark-id');
    generation++;
    sessionToken++;
    unsubscribe();
    drag.cancel();
    pane.hidden = true;
    root.classList.remove('bookmarks-open');
    trigger.setAttribute('aria-expanded', 'false');
    fold.disabled = foldDisabled;
    tree = null;
    index = null;
    manage.disabled = true;
    entries = [];
    rows.clear();
    list.replaceChildren();
    onClose();
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function open() {
    if (disposed || !pane.hidden || !getState()) return;
    onOpen();
    sessionToken++;
    api = getBrowser();
    foldDisabled = fold.disabled;
    fold.disabled = true;
    pane.hidden = false;
    root.classList.add('bookmarks-open');
    trigger.setAttribute('aria-expanded', 'true');
    search.disabled = false;
    search.focus();
    search.select();
    update();
    refresh();
  }

  function update() {
    trigger.disabled = !getState();
    if (pane.hidden) return false;
    const state = getState();
    const folder = state.groups.find((group) => group.id === state.view.scopeId);
    const label = `Open in ${folder?.name || 'Home'}`;
    if (destinationLabel.textContent !== label) destinationLabel.textContent = label;
    const containerId = groupContainer(state, folder?.id);
    const container = state.containers?.find((entry) => entry.cookieStoreId === containerId);
    const containerText =
      containerId && containerId !== 'firefox-default'
        ? container?.name || 'Unavailable container'
        : '';
    if (containerLabel.textContent !== containerText) containerLabel.textContent = containerText;
    containerLabel.hidden = !containerText;
    destination.title =
      label + (containerText ? ` · ${containerText} container` : ' · No container');
    list.classList.toggle('show-connecting-lines', state.look.connectingLines);
    return true;
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if (
        event.isComposing ||
        event.key !== 'Escape' ||
        pane.hidden ||
        document.querySelector('dialog[open], #menu:not([hidden])')
      )
        return;
      event.preventDefault();
      if (search.value) clearQuery();
      else close(true);
    },
    { signal: events.signal },
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!trigger.contains(event.target) && event.target.closest('footer')) close();
    },
    { capture: true, signal: events.signal },
  );
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!document.hidden && !loading) refresh();
    },
    { signal: events.signal },
  );

  return {
    open,
    close,
    update,
    refresh,
    getIndex: () => index,

    async reveal(id, { clearSearch = false } = {}) {
      await refresh();
      if (!index || pane.hidden || disposed) return;
      if (clearSearch) search.value = '';
      let node = index.byId.get(id);
      while (node) {
        expanded.add(node.parentId);
        searchCollapsed.delete(node.parentId);
        node = index.byId.get(node.parentId);
      }
      render();
      if (id && index.byId.has(id) && !rows.has(id)) {
        search.value = '';
        render();
      }
      if (rows.has(id)) focus(id);
      else search.focus();
    },

    expandAll(value) {
      if (!index) return;
      search.value = '';
      searchCollapsed.clear();
      expanded = value
        ? new Set(
            [...index.byId.values()]
              .filter((node) => node.type === 'folder')
              .map((node) => node.id),
          )
        : new Set();
      render();
      search.focus();
    },

    get isOpen() {
      return !pane.hidden;
    },

    focusSearch() {
      if (pane.hidden) return false;
      if (search.disabled) allow.focus();
      else {
        search.focus();
        search.select();
      }
      return true;
    },

    dispose() {
      disposed = true;
      generation++;
      unsubscribe();
      drag.dispose();
      events.abort();
      rows.clear();
      entries = [];
      tree = null;
      index = null;
      pane.remove();
      trigger.remove();
      root.classList.remove('bookmarks-open');
    },
  };
}
