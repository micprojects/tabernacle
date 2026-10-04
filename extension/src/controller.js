import { createMoveRecovery } from './move-recovery.js';
import { createBrowserCache } from './browser-cache.js';
import { createTreeIndex, scopeBranches } from './tree-index.js';
import { containerChoices, containerDetails } from './containers.js';
import { deserializeModel, serializeModel } from './persistence.js';
import { normalizeLook, requireLook } from './look.js';
import {
  MODEL_KEY,
  VIEW_KEY,
  emptyModel,
  groupById,
  requireGroup,
  groupPath,
  groupContainer,
  isWithin,
  cleanName,
  addGroup,
  moveGroup,
  removeGroup,
  normalizeView,
  sortTabs,
  insertionOrder,
  resolveTabTree,
  tabAncestors,
  tabSubtree,
  unpinnedTabTree,
} from './model.js';

/** All writes are serialized, including new-tab events, so sidebar windows cannot
 * overwrite one another. Durable state lives in storage/sessions, not tab IDs. */
export function createController(api, notify = () => {}) {
  let model;
  let treeOwners = new Map();
  let tabTreeKeys = new Map();
  let initializedTabs = false;
  let revision = 0;
  const generation = crypto.randomUUID();
  let requestTabs = new Map();
  let queue = Promise.resolve();
  const publish = (windowId) => notify({ windowId, revision: ++revision, generation });
  const cache = createBrowserCache(api, ({ windowId, removedTabId }) => {
    requestTabs.clear();
    if (removedTabId !== undefined) {
      const key = tabTreeKeys.get(removedTabId);
      if (treeOwners.get(key) === removedTabId) treeOwners.delete(key);
      tabTreeKeys.delete(removedTabId);
    }
    publish(windowId);
  });
  let ready;
  const moves = createMoveRecovery({
    api,
    readRecords,
    saveMembership,
    publish,

    async saveGroups(groups) {
      if (JSON.stringify(model.groups) !== JSON.stringify(groups))
        await changeModel((next) => {
          next.groups = structuredClone(groups);
        });
    },
  });

  function initialize() {
    ready ??= (async () => {
      const saved = await api.storage.local.get(MODEL_KEY);
      const next = deserializeModel(saved[MODEL_KEY]) ?? emptyModel();
      if (next.version !== 1 || !Array.isArray(next.groups))
        throw new Error('This Tabernacle data needs a newer version of the extension.');
      next.look = normalizeLook(next.look);
      await moves.load();
      model = next;
    })().catch((error) => {
      ready = null;
      throw error;
    });
    return ready;
  }

  const enqueue = (work) => {
    const result = queue.then(async () => {
      await initialize();
      await moves.recover();
      return work();
    });
    queue = result.catch(() => {});
    return result;
  };

  async function changeModel(change) {
    // Publish only after storage succeeds; a rejected save must not leak into
    // later requests or get persisted by an unrelated action.
    const next = structuredClone(model);
    const result = change(next);
    await api.storage.local.set({ [MODEL_KEY]: serializeModel(next) });
    model = next;
    return result;
  }

  const viewFor = async (windowId) =>
    normalizeView(model, await api.sessions.getWindowValue(windowId, VIEW_KEY));
  const saveView = (windowId, view) =>
    api.sessions.setWindowValue(windowId, VIEW_KEY, normalizeView(model, view));
  const membership = async (tabId) => (await cache.membership(tabId)) ?? null;

  async function saveMembership(tabId, value) {
    await cache.saveMembership(tabId, value);
    requestTabs.clear();
  }

  async function writeTab(windowId, method, ...args) {
    try {
      return await api.tabs[method](...args);
    } finally {
      cache.invalidateTabs(windowId);
      requestTabs.clear();
      if (method === 'remove') cache.invalidateHistory();
    }
  }

  function listTabs(windowId) {
    const key = windowId ?? null;
    if (!requestTabs.has(key)) requestTabs.set(key, loadTabs(windowId));
    return requestTabs.get(key);
  }

  async function confirmedClosed(failures) {
    if (!failures.length) return new Set();
    const live = new Set((await api.tabs.query({})).map((tab) => tab.id));
    const failed = failures.find(({ id }) => live.has(id));
    if (failed)
      throw new Error(
        `Could not read or save tab organisation. Try again. ${failed.error.message}`,
      );
    return new Set(failures.map(({ id }) => id));
  }

  async function readRecords(tabs) {
    const failures = [];
    const records = await Promise.all(
      tabs
        .filter((tab) => !tab.incognito)
        .map(async (tab) => {
          try {
            return { tab, value: (await membership(tab.id)) ?? {} };
          } catch (error) {
            failures.push({ id: tab.id, error });
            return null;
          }
        }),
    );
    await confirmedClosed(failures);
    return records.filter(Boolean);
  }

  async function loadTabs(windowId) {
    // Check identity uniqueness across windows: Firefox can copy session values
    // when duplicating a tab. The duplicate must not inherit the original's children.
    // Establish identity ownership across windows once after an event-page wake.
    // Subsequent reads only visit the requested window and reuse memberships.
    const allWindows = !initializedTabs || windowId == null;
    const tabs = await cache.tabs(allWindows ? null : windowId);
    const records = await readRecords(tabs);
    records.sort(
      (a, b) =>
        Number(treeOwners.get(b.value.treeId) === b.tab.id) -
          Number(treeOwners.get(a.value.treeId) === a.tab.id) || a.tab.id - b.tab.id,
    );
    const owners = allWindows ? new Map() : new Map(treeOwners);
    const liveIds = new Set(records.map(({ tab }) => tab.id));
    const groupIds = new Set(model.groups.map((group) => group.id));
    const result = [];
    const repairs = [];
    for (const { tab, value } of records) {
      let needsSave = false;
      let owner = owners.get(value.treeId);
      if (owner !== undefined && owner !== tab.id && !liveIds.has(owner)) {
        // A close/restore may race its removal event. Never treat a dead owner
        // as a live duplicate and break the restored tab's saved descendants.
        const alive = await api.tabs
          .get(owner)
          .catch(async () => (await api.tabs.query({})).some((tab) => tab.id === owner));
        if (!alive) {
          owners.delete(value.treeId);
          owner = undefined;
        }
      }
      if (
        typeof value.treeId !== 'string' ||
        !value.treeId ||
        (owner !== undefined && owner !== tab.id)
      ) {
        const duplicate = owner !== undefined;
        value.treeId = crypto.randomUUID();
        if (duplicate) value.collapsed = false;
        // Do not set a group here: a just-created tab may still be waiting for
        // its queued onCreated handler to place it beneath its opener.
        needsSave = true;
      }
      // Native indices change when Firefox inserts, pins or moves another tab.
      // Give legacy/new tabs a durable initial order before using fractional
      // positions; otherwise untouched neighbours could drift around a move.
      if (!Number.isFinite(value.order)) {
        value.order = tab.index ?? 0;
        needsSave = true;
      }
      if (needsSave) repairs.push({ id: tab.id, value });
      owners.set(value.treeId, tab.id);
      const { groupId: nativeGroupId, ...nativeTab } = tab;
      result.push({
        ...nativeTab,
        groupId: groupIds.has(value.groupId) ? value.groupId : null,
        nativeGroupId,
        order: value.order,
        treeId: value.treeId,
        ancestors: Array.isArray(value.ancestors)
          ? [...new Set(value.ancestors.filter((id) => typeof id === 'string'))]
          : [],
        collapsed: Boolean(value.collapsed),
      });
    }
    const closed = new Set();
    // Settle each bounded batch before deciding whether a failure was a close.
    for (let offset = 0; offset < repairs.length; offset += 32) {
      const batch = repairs.slice(offset, offset + 32);
      const results = await Promise.allSettled(
        batch.map(({ id, value }) => saveMembership(id, value)),
      );
      const failures = results.flatMap((result, index) =>
        result.status === 'rejected' ? [{ id: batch[index].id, error: result.reason }] : [],
      );
      for (const id of await confirmedClosed(failures)) closed.add(id);
    }
    for (const [key, owner] of owners) if (closed.has(owner)) owners.delete(key);
    treeOwners = owners;
    tabTreeKeys = new Map([...owners].map(([key, id]) => [id, key]));
    initializedTabs = true;
    return resolveTabTree(
      result.filter(
        (tab) => !closed.has(tab.id) && (windowId == null || tab.windowId === windowId),
      ),
    );
  }

  async function snapshot(windowId, extra = {}) {
    const snapshotRevision = revision;
    const results = await Promise.allSettled([
      listTabs(windowId),
      viewFor(windowId),
      // Containers can be disabled in Firefox. Their absence must not hide tabs.
      containers().catch(() => []),
      recentlyClosedTabs(windowId)
        .then((tabs) => ({ tabs }))
        .catch((error) => ({ tabs: [], error: error.message })),
    ]);
    // A failed view read must not release the queue while tab repairs still run.
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const [tabs, view, identities, history] = results.map((result) => result.value);
    const byStore = new Map(identities.map((identity) => [identity.cookieStoreId, identity]));
    return {
      generation,
      revision: snapshotRevision,
      groups: structuredClone(model.groups),
      containers: identities,
      look: { ...model.look },
      canUndoClose: history.tabs.length > 0,
      recentlyClosed: history.tabs,
      recentlyClosedError: history.error ?? null,
      tabs: tabs.map((tab) => {
        const identity = byStore.get(tab.cookieStoreId);
        return {
          ...tab,
          container: identity ? { name: identity.name, colorCode: identity.colorCode } : null,
        };
      }),
      view,
      ...extra,
    };
  }

  function membershipMatches(value, changes) {
    return (
      value?.treeId &&
      Object.entries(changes).every(([key, next]) =>
        Array.isArray(next)
          ? Array.isArray(value[key]) &&
            next.length === value[key].length &&
            next.every((item, i) => item === value[key][i])
          : next === value[key],
      )
    );
  }

  async function updateMembership(tabId, changes) {
    const value = (await membership(tabId)) ?? {};
    if (membershipMatches(value, changes)) return;
    await saveMembership(tabId, {
      ...value,
      treeId: value.treeId || crypto.randomUUID(),
      ...changes,
    });
  }

  async function checkedTab(tabId, windowId) {
    const tab = await api.tabs.get(tabId);
    if (tab.windowId !== windowId || tab.incognito)
      throw new Error('That tab has moved to another window.');
    return tab;
  }

  async function groupContents(id) {
    const group = groupById(model, requireGroup(model, id));
    if (!group) throw new Error('Choose a group.');
    const groupIds = model.groups.filter((item) => isWithin(model, item.id, id)).map((g) => g.id);
    const tabs = (await listTabs()).filter((tab) => groupIds.includes(tab.groupId));
    return {
      groupIds,
      tabIds: tabs.map((tab) => tab.id),
      pinnedCount: tabs.filter((tab) => tab.pinned).length,
      windowCount: new Set(tabs.map((tab) => tab.windowId)).size,
    };
  }

  async function moveGroupContents(id, destinationId) {
    const group = groupById(model, requireGroup(model, id));
    if (!group) throw new Error('Choose a group to move contents from.');
    requireGroup(model, destinationId);
    if (isWithin(model, destinationId, id))
      throw new Error('Choose a destination outside this group and its subgroups.');
    const tabs = await listTabs();
    const windows = new Set(tabs.filter((tab) => tab.groupId === id).map((tab) => tab.windowId));
    const changes = [];
    for (const windowId of windows) {
      const ordered = [
        ...sortTabs(
          tabs.filter((tab) => tab.windowId === windowId && tab.groupId === destinationId),
        ),
        ...sortTabs(tabs.filter((tab) => tab.windowId === windowId && tab.groupId === id)),
      ];
      for (const [index, tab] of ordered.entries()) {
        const before = await membership(tab.id);
        const after = { ...before, groupId: destinationId, order: index * 1024 };
        if (before.groupId !== after.groupId || before.order !== after.order)
          changes.push({ id: tab.id, before, after });
      }
    }
    const after = structuredClone(model.groups);
    const children = after.filter((item) => item.parentId === id);
    const remaining = after.filter((item) => item.parentId !== id);
    for (const child of children) {
      child.parentId = destinationId;
      remaining.push(child);
    }
    await moves.apply(changes, { before: structuredClone(model.groups), after: remaining });
  }

  async function containers() {
    return cache.containers();
  }

  async function requireContainer(cookieStoreId) {
    if (typeof cookieStoreId !== 'string' || !cookieStoreId) throw new Error('Choose a container.');
    if (
      cookieStoreId !== 'firefox-default' &&
      !(await containers()).some((item) => item.cookieStoreId === cookieStoreId)
    )
      throw new Error('That container no longer exists. Close this dialog and choose another.');
  }

  async function newTabContainer(groupId, explicitStore, fallbackStore) {
    const cookieStoreId =
      explicitStore === undefined ? groupContainer(model, groupId) : explicitStore;
    if (cookieStoreId === undefined) return fallbackStore;
    try {
      await requireContainer(cookieStoreId);
    } catch (error) {
      if (explicitStore !== undefined) throw error;
      throw new Error(
        'This group’s default container is unavailable. Choose another in Default container… or select No container.',
      );
    }
    return cookieStoreId;
  }

  async function recentlyClosedTabs(windowId) {
    const sessions = await cache.history();
    return sessions
      .filter(({ tab }) => tab?.windowId === windowId && !tab.incognito && tab.sessionId)
      .map(({ tab, lastModified }) => ({
        sessionId: tab.sessionId,
        title: tab.title || tab.url || 'New tab',
        url: tab.url || '',
        favIconUrl: tab.favIconUrl,
        closedAt: Number.isFinite(lastModified) ? lastModified : 0,
      }))
      .sort((a, b) => b.closedAt - a.closedAt);
  }

  async function revealTab(id, windowId) {
    const tabs = await listTabs(windowId);
    const tab = tabs.find((tab) => tab.id === id);
    if (!tab) return;
    const view = await viewFor(windowId);
    if (!isWithin(model, tab.groupId, view.scopeId)) view.scopeId = tab.groupId;
    const parents = new Set(groupPath(model, tab.groupId).map((group) => group.id));
    view.collapsed = view.collapsed.filter((id) => !parents.has(id));
    await saveView(windowId, view);
    await expandAncestors(tabs, tab.id);
  }

  async function reopenInContainer(tabId, cookieStoreId, windowId) {
    await checkedTab(tabId, windowId);
    const source = (await listTabs(windowId)).find((tab) => tab.id === tabId);
    if (!source) throw new Error('That tab has closed.');
    if (typeof cookieStoreId !== 'string' || !cookieStoreId) throw new Error('Choose a container.');
    if ((source.cookieStoreId ?? 'firefox-default') === cookieStoreId) return source.id;
    await requireContainer(cookieStoreId);
    if (!source.url) throw new Error('This tab does not have a page to reopen yet.');

    const saved = await membership(source.id);
    // Create first and give the replacement the same durable tree identity.
    // Queued snapshots/onCreated cannot observe the temporary duplicate identity.
    const replacement = await writeTab(windowId, 'create', {
      windowId,
      cookieStoreId,
      ...(source.url === 'about:newtab' || source.url === 'about:home' ? {} : { url: source.url }),
      index: source.index + 1,
      pinned: Boolean(source.pinned),
      muted: Boolean(source.mutedInfo?.muted),
      active: false,
    });
    try {
      await saveMembership(replacement.id, {
        ...saved,
        groupId: source.groupId,
        order: source.order ?? source.index,
        treeId: source.treeId,
      });
      if (!source.pinned && Number.isInteger(source.nativeGroupId) && source.nativeGroupId >= 0) {
        await writeTab(windowId, 'group', {
          tabIds: [replacement.id],
          groupId: source.nativeGroupId,
        });
        await writeTab(windowId, 'move', replacement.id, { index: source.index + 1 });
      }
      const reopened = await checkedTab(replacement.id, windowId);
      if (reopened.cookieStoreId !== cookieStoreId)
        throw new Error('Firefox did not open the replacement in the selected container.');
      const current = await checkedTab(source.id, windowId);
      if (current.url !== source.url)
        throw new Error('The original tab navigated to another page. Try again.');
      if (current.active) await writeTab(windowId, 'update', replacement.id, { active: true });
      await writeTab(windowId, 'remove', source.id);
      const remaining = await api.tabs.get(source.id).catch(() => null);
      if (remaining) throw new Error('The original tab could not be closed. Try again.');
      treeOwners.set(source.treeId, replacement.id);
      tabTreeKeys.delete(source.id);
      tabTreeKeys.set(replacement.id, source.treeId);
      return replacement.id;
    } catch (error) {
      // Every fallible preparation step precedes closing the original.
      // If Firefox refuses the close, discard the replacement and retain the source.
      const original = await api.tabs.get(source.id).catch(() => null);
      if (original) {
        if (source.active)
          await writeTab(windowId, 'update', source.id, { active: true }).catch(() => {});
        await writeTab(windowId, 'remove', replacement.id).catch(() => {});
      }
      throw error;
    }
  }

  async function moveTab(tabId, groupId, windowId, beforeId = null, parentTabId = null) {
    await checkedTab(tabId, windowId);
    requireGroup(model, groupId);
    const allTabs = await listTabs(windowId);
    const subtree = tabSubtree(allTabs, tabId);
    if (!subtree.length) throw new Error('That tab has closed.');
    const moving = new Set(subtree.map((tab) => tab.id));
    const parent = allTabs.find((tab) => tab.id === parentTabId);
    if (parentTabId !== null && (!parent || parent.groupId !== groupId))
      throw new Error('The parent tab has moved. Try again.');
    if (moving.has(parentTabId))
      throw new Error('A tab cannot nest under itself or one of its children.');
    if (beforeId === tabId) return;
    // Root ordering includes children exposed beneath pinned tabs.
    const candidates = parentTabId === null ? unpinnedTabTree(allTabs) : allTabs;
    const siblings = sortTabs(
      candidates.filter(
        (tab) => tab.groupId === groupId && tab.parentTabId === parentTabId && !moving.has(tab.id),
      ),
    );
    const index =
      beforeId === null ? siblings.length : siblings.findIndex((tab) => tab.id === beforeId);
    if (index < 0) throw new Error('The destination tab has moved. Try again.');
    const order = insertionOrder(siblings, index);
    const ancestry = new Map();
    const updates = new Map();
    ancestry.set(
      tabId,
      parent ? [parent.treeId, ...tabAncestors(allTabs, parent.id).map((tab) => tab.treeId)] : [],
    );
    for (const tab of subtree) {
      if (tab.id !== tabId) {
        const parent = allTabs.find((item) => item.id === tab.parentTabId);
        ancestry.set(tab.id, [parent.treeId, ...ancestry.get(parent.id)]);
      }
      updates.set(tab.id, {
        groupId,
        ancestors: ancestry.get(tab.id),
        ...(tab.id === tabId && order !== null ? { order } : {}),
      });
    }
    if (order === null) {
      siblings.splice(index, 0, subtree[0]);
      for (const [index, tab] of siblings.entries())
        updates.set(tab.id, { ...updates.get(tab.id), groupId, order: index * 1024 });
    }
    if (parent) {
      for (const tab of [parent, ...tabAncestors(allTabs, parent.id)])
        if (tab.collapsed) updates.set(tab.id, { ...updates.get(tab.id), collapsed: false });
    }
    const changes = [];
    for (const [id, update] of updates) {
      const before = await membership(id);
      if (!membershipMatches(before, update))
        changes.push({ id, before, after: { ...before, ...update } });
    }
    await moves.apply(changes);
  }

  async function expandAncestors(tabs, id) {
    const results = await Promise.allSettled(
      tabAncestors(tabs, id)
        .filter((tab) => tab.collapsed)
        .map((tab) => updateMembership(tab.id, { collapsed: false })),
    );
    // Keep late writes inside the request queue even when another save fails.
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async function handle(message) {
    const { type, windowId } = message;
    if (!Number.isInteger(windowId)) throw new Error('No browser window is available.');
    const window = await api.windows.get(windowId);
    if (window.incognito) throw new Error('Tabernacle is not enabled in private windows.');
    let extra = {};
    switch (type) {
      case 'snapshot':
        return snapshot(windowId);
      case 'getGroupContents':
        return groupContents(message.id);
      case 'getContainers': {
        const tab = message.id === undefined ? null : await checkedTab(message.id, windowId);
        return {
          containers: await containers(),
          cookieStoreId: tab?.cookieStoreId ?? 'firefox-default',
        };
      }
      case 'reopenInContainer':
        extra.reopenedTabId = await reopenInContainer(message.id, message.cookieStoreId, windowId);
        break;
      case 'getContainerChoices':
        await containers();
        return containerChoices(api);
      case 'createContainer': {
        await containers();
        const details = await containerDetails(api, message);
        const identity = await api.contextualIdentities.create(details);
        cache.invalidateContainers();
        extra.createdCookieStoreId = identity.cookieStoreId;
        break;
      }
      case 'updateContainer':
      case 'removeContainer': {
        if (!(await containers()).some((item) => item.cookieStoreId === message.cookieStoreId))
          throw new Error('That container no longer exists. Reopen Manage containers.');
        if (type === 'updateContainer') {
          const details = await containerDetails(api, message);
          await api.contextualIdentities.update(message.cookieStoreId, details);
        } else {
          // Check every window immediately before deletion; never close tabs implicitly.
          if ((await api.tabs.query({})).some((tab) => tab.cookieStoreId === message.cookieStoreId))
            throw new Error(
              'Close this container’s tabs in all Firefox windows before removing it.',
            );
          await api.contextualIdentities.remove(message.cookieStoreId);
        }
        cache.invalidateContainers();
        break;
      }
      case 'createGroup': {
        const id = message.id ?? crypto.randomUUID();
        if (
          typeof id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        )
          throw new Error('Choose a valid group identifier.');
        extra.createdGroupId = id;
        if (groupById(model, id)) break;
        const parentId = requireGroup(model, message.parentId ?? null);
        const name = cleanName(message.name);
        let cookieStoreId = message.cookieStoreId ?? null;
        let details;
        if (message.newContainer != null) {
          if (cookieStoreId !== null)
            throw new Error('Choose an existing container or create a new one.');
          if (typeof message.newContainer !== 'object')
            throw new Error('Enter valid container details.');
          await containers();
          details = await containerDetails(api, message.newContainer);
        } else if (cookieStoreId !== null) await requireContainer(cookieStoreId);
        const view = await viewFor(windowId);
        view.collapsed = view.collapsed.filter((key) => key !== parentId);
        await saveView(windowId, view);
        let createdContainer;
        try {
          if (details) {
            createdContainer = await api.contextualIdentities.create(details);
            cookieStoreId = createdContainer.cookieStoreId;
            cache.invalidateContainers();
          }
          await changeModel((next) => {
            const group = addGroup(next, name, parentId, id);
            if (cookieStoreId !== null) group.defaultCookieStoreId = cookieStoreId;
          });
        } catch (error) {
          if (createdContainer) {
            try {
              if (
                (await api.tabs.query({})).some(
                  (tab) => tab.cookieStoreId === createdContainer.cookieStoreId,
                )
              )
                throw new Error('The new container is already in use.');
              await api.contextualIdentities.remove(createdContainer.cookieStoreId);
            } catch {
              throw new Error(
                `${error.message} The container “${createdContainer.name}” was created. Choose it using Change before retrying.`,
              );
            } finally {
              cache.invalidateContainers();
            }
          }
          throw error;
        }
        break;
      }
      case 'renameGroup': {
        requireGroup(model, message.id);
        if (message.id === null) throw new Error('Choose a group to rename.');
        await changeModel((next) => {
          groupById(next, message.id).name = cleanName(message.name);
        });
        break;
      }
      case 'setGroupContainer': {
        const group = groupById(model, requireGroup(model, message.id));
        if (!group) throw new Error('Choose a group to set a default container.');
        if (message.cookieStoreId !== null) await requireContainer(message.cookieStoreId);
        await changeModel((next) => {
          const target = groupById(next, group.id);
          if (message.cookieStoreId === null) delete target.defaultCookieStoreId;
          else target.defaultCookieStoreId = message.cookieStoreId;
        });
        break;
      }
      case 'moveGroup':
        await changeModel((next) =>
          moveGroup(next, message.id, message.parentId ?? null, message.beforeId ?? null),
        );
        break;
      case 'moveGroupContents':
        await moveGroupContents(message.id, message.groupId ?? null);
        break;
      case 'removeGroup': {
        const group = groupById(model, requireGroup(model, message.id));
        if (!group) throw new Error('Choose a group to delete.');
        if (
          !Array.isArray(message.groupIds) ||
          !message.groupIds.every((id) => typeof id === 'string') ||
          !message.groupIds.includes(group.id) ||
          !Array.isArray(message.tabIds) ||
          !message.tabIds.every(Number.isInteger)
        )
          throw new Error('Confirm the group and tabs to delete.');
        const contents = await groupContents(group.id);
        if (
          contents.groupIds.some((id) => !message.groupIds.includes(id)) ||
          contents.tabIds.some((id) => !message.tabIds.includes(id))
        )
          throw new Error('The group contents changed. Close this dialog and review them again.');
        const windows = await api.windows.getAll();
        // Save views before closing tabs, which may close their browser windows.
        for (const item of windows.filter((item) => !item.incognito)) {
          const view = await viewFor(item.id);
          if (contents.groupIds.includes(view.scopeId)) view.scopeId = group.parentId;
          view.collapsed = view.collapsed.filter((id) => !contents.groupIds.includes(id));
          await saveView(item.id, view);
        }
        if (contents.tabIds.length) await writeTab(null, 'remove', contents.tabIds);
        // A page can refuse to close. Keep its groups available for a retry.
        cache.invalidateTabs();
        requestTabs.clear();
        if ((await groupContents(group.id)).tabIds.length)
          throw new Error(
            'Some tabs are still open. Close them or try again before deleting the group.',
          );
        await changeModel((next) => removeGroup(next, group.id));
        break;
      }
      case 'enterGroup': {
        const scopeId = requireGroup(model, message.id ?? null);
        const view = await viewFor(windowId);
        view.scopeId = scopeId;
        if (scopeId !== null && typeof message.collapsed === 'boolean') {
          view.collapsed = view.collapsed.filter((id) => id !== scopeId);
          if (message.collapsed) view.collapsed.push(scopeId);
        }
        await saveView(windowId, view);
        // Navigating into a nonempty group brings a real member tab into view.
        if (scopeId !== null) {
          const tabs = (await listTabs(windowId)).filter((tab) =>
            isWithin(model, tab.groupId, scopeId),
          );
          if (tabs.length && !tabs.some((tab) => tab.active)) {
            tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
            await writeTab(windowId, 'update', tabs[0].id, { active: true });
          }
        }
        break;
      }
      case 'toggleGroup': {
        requireGroup(model, message.id);
        const view = await viewFor(windowId);
        view.collapsed = view.collapsed.includes(message.id)
          ? view.collapsed.filter((id) => id !== message.id)
          : [...view.collapsed, message.id];
        await saveView(windowId, view);
        break;
      }
      case 'collapseAll': {
        const view = await viewFor(windowId);
        view.collapsed = message.collapsed ? model.groups.map((group) => group.id) : [];
        await saveView(windowId, view);
        break;
      }
      case 'collapseTree': {
        const scopeId = requireGroup(model, message.scopeId ?? null);
        if (typeof message.collapsed !== 'boolean') throw new Error('Choose a tree state.');
        const view = await viewFor(windowId);
        const index = createTreeIndex({ ...model, tabs: await listTabs(windowId) });
        const branches = scopeBranches(index, { ...view, scopeId });
        const tabs = branches.tabs.filter((tab) => tab.collapsed !== message.collapsed);
        // Bound session writes for large trees, and finish a batch before an
        // error escapes so later queued actions cannot race its remaining saves.
        for (let offset = 0; offset < tabs.length; offset += 32) {
          const results = await Promise.allSettled(
            tabs
              .slice(offset, offset + 32)
              .map((tab) => updateMembership(tab.id, { collapsed: message.collapsed })),
          );
          const failed = results.find((result) => result.status === 'rejected');
          if (failed) throw failed.reason;
        }
        view.collapsed = view.collapsed.filter((id) => !branches.groupIds.has(id));
        if (message.collapsed) view.collapsed.push(...branches.groupIds);
        await saveView(windowId, view);
        break;
      }
      case 'moveTab':
        await moveTab(
          message.id,
          message.groupId ?? null,
          windowId,
          message.beforeId ?? null,
          message.parentTabId ?? null,
        );
        break;
      case 'nestTab': {
        const parent = (await listTabs(windowId)).find((tab) => tab.id === message.parentTabId);
        if (!parent) throw new Error('The parent tab has moved. Try again.');
        await moveTab(message.id, parent.groupId, windowId, null, parent.id);
        break;
      }
      case 'detachTab': {
        const tab = (await listTabs(windowId)).find((tab) => tab.id === message.id);
        if (!tab) throw new Error('That tab has moved to another window.');
        await moveTab(tab.id, tab.groupId, windowId);
        break;
      }
      case 'toggleTab': {
        await checkedTab(message.id, windowId);
        if (message.activate === true) {
          await expandAncestors(await listTabs(windowId), message.id);
          await writeTab(windowId, 'update', message.id, { active: true });
          if (!window.focused) await api.windows.update(windowId, { focused: true });
        }
        const value = await membership(message.id);
        await updateMembership(message.id, { collapsed: !value?.collapsed });
        break;
      }
      case 'newChildTab': {
        const parent = (await listTabs(windowId)).find((tab) => tab.id === message.id);
        if (!parent) throw new Error('That tab has moved to another window.');
        const cookieStoreId = await newTabContainer(
          parent.groupId,
          message.cookieStoreId,
          parent.cookieStoreId,
        );
        const tab = await writeTab(windowId, 'create', {
          windowId,
          openerTabId: parent.id,
          active: true,
          ...(cookieStoreId !== undefined ? { cookieStoreId } : {}),
        });
        await moveTab(tab.id, parent.groupId, windowId, null, parent.id);
        break;
      }
      case 'newTab': {
        const groupId = requireGroup(model, message.groupId ?? null);
        const cookieStoreId = await newTabContainer(groupId, message.cookieStoreId);
        const tab = await writeTab(windowId, 'create', {
          windowId,
          active: true,
          ...(cookieStoreId !== undefined ? { cookieStoreId } : {}),
        });
        await moveTab(tab.id, groupId, windowId);
        extra.createdTabId = tab.id;
        break;
      }
      case 'undoCloseTab':
      case 'restoreClosedTab': {
        // Select a tab explicitly: restore() without an ID can reopen a whole window.
        cache.invalidateHistory();
        const history = await recentlyClosedTabs(windowId);
        const closed =
          type === 'undoCloseTab'
            ? history[0]
            : history.find((tab) => tab.sessionId === message.sessionId);
        if (!closed)
          throw new Error(
            type === 'undoCloseTab'
              ? 'No recently closed tabs in this window.'
              : 'That closed tab is no longer available in this window.',
          );
        let restored;
        try {
          restored = await api.sessions.restore(closed.sessionId);
        } finally {
          cache.invalidateHistory();
          cache.invalidateTabs();
          requestTabs.clear();
        }
        if (!restored.tab) throw new Error('Firefox could not restore that tab.');
        await checkedTab(restored.tab.id, windowId);
        await writeTab(windowId, 'update', restored.tab.id, { active: true });
        await revealTab(restored.tab.id, windowId);
        extra.restoredTabId = restored.tab.id;
        break;
      }
      case 'clickTab':
      case 'activateTab': {
        const tab = await checkedTab(message.id, windowId);
        const tabs = await listTabs(windowId);
        if (
          type === 'clickTab' &&
          message.toggleChildren !== false &&
          tab.active &&
          window.focused &&
          !tab.pinned &&
          unpinnedTabTree(tabs).some((child) => child.parentTabId === tab.id)
        ) {
          const value = await membership(tab.id);
          await updateMembership(tab.id, { collapsed: !value?.collapsed });
        } else {
          await expandAncestors(tabs, tab.id);
          await writeTab(windowId, 'update', tab.id, { active: true });
          if (!window.focused) await api.windows.update(windowId, { focused: true });
        }
        break;
      }
      case 'closeTab':
        await checkedTab(message.id, windowId);
        await writeTab(windowId, 'remove', message.id);
        break;
      case 'closeTabTree': {
        if (
          !Array.isArray(message.tabIds) ||
          !message.tabIds.every(Number.isInteger) ||
          !message.tabIds.includes(message.id)
        )
          throw new Error('Choose the tabs to close.');
        await checkedTab(message.id, windowId);
        const confirmed = new Set(message.tabIds);
        // Keep new children and tabs moved out since the confirmation opened.
        // Close descendants first so the parent survives a partial failure.
        const ids = tabSubtree(await listTabs(windowId), message.id)
          .filter((tab) => confirmed.has(tab.id))
          .map((tab) => tab.id)
          .reverse();
        if (ids.length) await writeTab(windowId, 'remove', ids);
        break;
      }
      case 'closeGroupTabs': {
        const group = groupById(model, requireGroup(model, message.id));
        if (!group) throw new Error('Choose a group whose tabs you want to close.');
        if (!Array.isArray(message.tabIds) || !message.tabIds.every(Number.isInteger))
          throw new Error('Choose the tabs to close.');
        // Only close tabs shown in the confirmation that still belong here.
        // Tabs opened later, moved out, or moved to another window are excluded.
        const confirmed = new Set(message.tabIds);
        const ids = (await listTabs(windowId))
          .filter((tab) => confirmed.has(tab.id) && isWithin(model, tab.groupId, group.id))
          .map((tab) => tab.id);
        if (ids.length) await writeTab(windowId, 'remove', ids);
        break;
      }
      case 'pinTab': {
        const tab = await checkedTab(message.id, windowId);
        await writeTab(windowId, 'update', tab.id, { pinned: !tab.pinned });
        break;
      }
      case 'movePinnedTab': {
        const tab = await checkedTab(message.id, windowId);
        if (!tab.pinned) throw new Error('That tab is no longer pinned.');
        const pins = (await listTabs(windowId))
          .filter((item) => item.pinned)
          .sort((a, b) => a.index - b.index);
        const beforeId = message.beforeId ?? null;
        if (beforeId === tab.id) break;
        const remaining = pins.filter((item) => item.id !== tab.id);
        const position =
          beforeId === null
            ? remaining.length
            : remaining.findIndex((item) => item.id === beforeId);
        if (position < 0) throw new Error('The destination pinned tab has moved or closed.');
        const index = pins[position].index;
        if (index !== tab.index) {
          const moved = await writeTab(windowId, 'move', tab.id, { index });
          if (Array.isArray(moved) && !moved.length)
            throw new Error('Firefox could not move that pinned tab. Try again.');
        }
        break;
      }
      case 'muteTab': {
        const tab = await checkedTab(message.id, windowId);
        await writeTab(windowId, 'update', tab.id, { muted: !tab.mutedInfo?.muted });
        break;
      }
      case 'duplicateTab': {
        await checkedTab(message.id, windowId);
        const source = (await listTabs(windowId)).find((tab) => tab.id === message.id);
        const tab = await writeTab(windowId, 'duplicate', message.id);
        await updateMembership(tab.id, {
          treeId: crypto.randomUUID(),
          ancestors: [],
          collapsed: false,
        });
        await moveTab(tab.id, source.groupId, windowId, null, source.parentTabId);
        break;
      }
      case 'revealActive': {
        const tab = (await listTabs(windowId)).find((tab) => tab.active);
        if (tab) await revealTab(tab.id, windowId);
        break;
      }
      case 'setLook': {
        const look = requireLook(message.value);
        await changeModel((next) => {
          next.look = look;
        });
        break;
      }
      default:
        throw new Error('Unknown Tabernacle action.');
    }
    publish(
      [
        'createContainer',
        'updateContainer',
        'removeContainer',
        'createGroup',
        'renameGroup',
        'setGroupContainer',
        'moveGroup',
        'moveGroupContents',
        'removeGroup',
        'setLook',
      ].includes(type)
        ? undefined
        : windowId,
    );
    return snapshot(windowId, extra);
  }

  return {
    start: () => enqueue(() => {}),
    request: (message) =>
      enqueue(() => {
        requestTabs = new Map();
        return handle(message);
      }),
    dispose: () => cache.dispose(),
    created: (tab) =>
      enqueue(async () => {
        if (tab.incognito) return;
        requestTabs = new Map();
        const saved = await membership(tab.id);
        if (saved && Object.hasOwn(saved, 'groupId')) {
          if (treeOwners.get(saved.treeId) === tab.id) return;
          await listTabs(tab.windowId);
          publish(tab.windowId);
          return;
        }
        const view = await viewFor(tab.windowId);
        let groupId = view.scopeId;
        const tabs = await listTabs(tab.windowId);
        // Pins are global shortcuts: their links belong to the current folder,
        // not to the pin's saved group or tree.
        const opener = tabs.find(
          (item) => item.id === tab.openerTabId && item.id !== tab.id && !item.pinned,
        );
        if (opener) groupId = opener.groupId;
        await moveTab(tab.id, groupId, tab.windowId, null, opener?.id ?? null);
        publish(tab.windowId);
      }),
  };
}
