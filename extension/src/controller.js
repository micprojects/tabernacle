import { applyTabBatch } from './tab-batch.js';
import { createMoveRecovery } from './move-recovery.js';
import { resolveMove } from './move-plan.js';
import { createBrowserCache } from './browser-cache.js';
import { closeFallback, createCloseSelection } from './close-selection.js';
import { createTreeIndex, scopeBranches } from './tree-index.js';
import { containerChoices, containerDetails } from './containers.js';
import { deserializeModel, serializeModel } from './persistence.js';
import { normaliseDomain } from './domain-filter.js';
import { normaliseDomainPins } from './domains.js';
import { normalizeLook, requireLook } from './look.js';
import { normalizeNewTab, requireNewTab, isNewTabPage } from './new-tab-preferences.js';
import { recordExpansions } from './folder-activity.js';
import { normalizeFolderPins, reconcilePins, pinActionLabels, pinKey } from './pinned-items.js';
import { requireGroupAppearance } from './folder-appearance.js';
import { internalPage, openInternalPage } from './internal-pages.js';
import { createFolderBackupController, folderBackupActions } from './folder-backup-controller.js';
import {
  MODEL_KEY,
  VIEW_KEY,
  emptyModel,
  validGroups,
  groupById,
  requireGroup,
  groupPath,
  groupContainer,
  isWithin,
  isSavedForLater,
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

async function readTogether(reads) {
  // Reading tabs can repair persisted memberships. Keep those writes inside
  // the request queue even when another concurrent read fails first.
  const results = await Promise.allSettled(reads);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}

/** All writes are serialized, including new-tab events, so sidebar windows cannot
 * overwrite one another. Durable state lives in storage/sessions, not tab IDs. */
export function createController(
  api,
  notify = () => {},
  {
    readCloseFilter = (windowId) =>
      api.runtime?.sendMessage?.({ type: 'tabernacle:getCloseFilter', windowId }),
  } = {},
) {
  const receiptKey = 'tabernacle.move-receipts.v1';
  let model;
  let treeOwners = new Map();
  let tabTreeKeys = new Map();
  let initializedTabs = false;
  let revision = 0;
  const generation = crypto.randomUUID();
  let requestTabs = new Map();
  const resolvedTabs = new Map();
  let membershipVersion = 0;
  let stateWrites = 0;
  let queue = Promise.resolve();
  let pendingCreations;
  const openedTimes = new Map();
  const forgottenPins = new Map();
  const publish = (windowId) => notify({ windowId, revision: ++revision, generation });
  const cache = createBrowserCache(api, ({ windowId, removedTabId, detachedTabId }) => {
    requestTabs.clear();
    if (windowId != null) {
      resolvedTabs.delete(windowId);
      resolvedTabs.delete(null);
    }
    const forgotten = tabTreeKeys.get(removedTabId ?? detachedTabId);
    if (forgotten) {
      if (!forgottenPins.has(windowId)) forgottenPins.set(windowId, new Set());
      forgottenPins.get(windowId).add(forgotten);
    }
    if (removedTabId !== undefined) {
      openedTimes.delete(removedTabId);
      const key = tabTreeKeys.get(removedTabId);
      if (treeOwners.get(key) === removedTabId) treeOwners.delete(key);
      tabTreeKeys.delete(removedTabId);
    }
    publish(windowId);
  });
  const closeSelection = createCloseSelection(api, (windowId, before, closedId, current) =>
    enqueue(() => settleClose(windowId, before, closedId, current)),
  );
  let ready;
  const folderBackup = createFolderBackupController({
    api,
    getModel: () => model,
    changeModel,
    publish,
    invalidateContainers: () => cache.invalidateContainers(),
  });
  const moves = createMoveRecovery({
    api,
    readRecords,
    saveMembership,
    publish,
    applyEffects,
    saveReceipt,

    async saveGroups(groups, source) {
      if (source?.kind === 'group') {
        // Recovery owns this folder's placement only. A rename, appearance
        // change or newly created folder must survive a background restart.
        if (!groupById(model, source.id)) return;
        const desired = groups.find((group) => group.id === source.id);
        if (!desired) throw new Error('The saved folder destination is unavailable.');
        const siblings = groups.filter((group) => group.parentId === desired.parentId);
        const following = siblings
          .slice(siblings.indexOf(desired) + 1)
          .find((group) => groupById(model, group.id)?.parentId === desired.parentId);
        await changeModel((next) =>
          moveGroup(next, source.id, desired.parentId, following?.id ?? null),
        );
        return;
      }
      if (JSON.stringify(model.groups) !== JSON.stringify(groups))
        await changeModel((next) => {
          next.groups = structuredClone(groups);
        });
    },
  });

  async function saveReceipt(receipt) {
    const saved = (await api.storage.local.get(receiptKey))[receiptKey] || {};
    const windows = new Set((await api.windows.getAll()).map((window) => String(window.id)));
    const receipts = Object.fromEntries(Object.entries(saved).filter(([id]) => windows.has(id)));
    receipts[receipt.windowId] = receipt;
    await api.storage.local.set({ [receiptKey]: receipts });
  }

  async function applyEffects(effects, direction) {
    if (effects.pin) {
      const records = await readRecords(await api.tabs.query({}));
      const matches = records.filter(({ value }) => value.treeId === effects.pin.treeId);
      if (matches.length > 1) throw new Error('Move recovery found duplicated tab identities.');
      const source = matches[0]?.tab;
      if (source) {
        if (source.windowId !== effects.windowId)
          throw new Error(
            'The moving tab changed windows. Return it to its original window to finish recovery.',
          );
        const desired = effects.pin[direction];
        if (Boolean(source.pinned) !== desired.pinned)
          await writeTab(effects.windowId, 'update', source.id, { pinned: desired.pinned });
        if (desired.pinned) {
          const before = records.find(
            ({ tab, value }) =>
              value.treeId === desired.beforeTreeId &&
              tab.windowId === source.windowId &&
              tab.pinned,
          )?.tab;
          await moveNativePin(effects.windowId, source.id, before?.id ?? null);
        }
      }
    }
    if (effects.folderPins) {
      const order = effects.folderPins[direction];
      const byId = new Map(model.folderPins.map((pin) => [pin.id, pin]));
      const folderPins = [
        ...order.flatMap((pin) => (byId.has(pin.id) ? [byId.get(pin.id)] : [])),
        ...model.folderPins.filter((pin) => !order.some((item) => item.id === pin.id)),
      ];
      // Reordering does not remove slots. Other windows reconcile their own
      // mixed layouts against this shared folder order on their next snapshot.
      const next = { ...model, folderPins };
      await api.storage.local.set({ [MODEL_KEY]: serializeModel(next) });
      model = next;
      stateWrites++;
    }
    if (effects.layout) {
      const view = await viewFor(effects.windowId);
      const desired = effects.layout[direction];
      const key = pinKey(effects.layout.item);
      const current = (view.pinLayout || effects.layout.before).filter(
        (item) => pinKey(item) !== key,
      );
      const index = desired.findIndex((item) => pinKey(item) === key);
      if (index >= 0) {
        const next = desired
          .slice(index + 1)
          .find((item) => current.some((pin) => pinKey(pin) === pinKey(item)));
        const slot = next
          ? current.findIndex((item) => pinKey(item) === pinKey(next))
          : current.length;
        current.splice(slot, 0, desired[index]);
      }
      view.pinLayout = current;
      await saveView(effects.windowId, view);
    }
  }

  function initialize() {
    ready ??= (async () => {
      const saved = await api.storage.local.get(MODEL_KEY);
      const next = deserializeModel(saved[MODEL_KEY]) ?? emptyModel();
      if (next.version !== 1 || !Array.isArray(next.groups))
        throw new Error('This Tabernacle data needs a newer version of the extension.');
      if (!validGroups(next.groups))
        throw new Error(
          'The saved folder structure is invalid. Your stored data has not been changed.',
        );
      next.look = normalizeLook(next.look);
      next.newTab = normalizeNewTab(next.newTab);
      next.folderPins = normalizeFolderPins(next.groups, next.folderPins);
      next.domainPins = normaliseDomainPins(next.domainPins);
      await moves.load();
      model = next;
    })().catch((error) => {
      ready = null;
      throw error;
    });
    return ready;
  }

  const enqueue = (work, recoverMoves = true) => {
    // A request is an ordering boundary: later native creations must not join
    // a batch already queued before that request.
    pendingCreations = null;
    const result = queue.then(async () => {
      await initialize();
      if (recoverMoves) await moves.recover();
      else if (moves.hasPending())
        throw new Error('A folder or tab move needs to finish. Open the sidebar, then try again.');
      return work();
    });
    queue = result.catch(() => {});
    return result;
  };

  async function changeModel(change) {
    // Publish only after storage succeeds; a rejected save must not leak into
    // later requests or get persisted by an unrelated action.
    const next = structuredClone(model);
    const previousPins = model.folderPins;
    const result = change(next);
    next.folderPins = normalizeFolderPins(next.groups, next.folderPins);
    await api.storage.local.set({ [MODEL_KEY]: serializeModel(next) });
    model = next;
    stateWrites++;
    if (
      JSON.stringify(previousPins.map((item) => item.id)) !==
      JSON.stringify(next.folderPins.map((item) => item.id))
    ) {
      try {
        // A closed sidebar still owns a layout. Resolve its previous folder
        // order before removing slots, otherwise a reorder followed by unpin
        // could remove the wrong position in a window that never refreshed.
        for (const window of (await api.windows.getAll()).filter((item) => !item.incognito)) {
          const view = await viewFor(window.id);
          if (!view.pinLayout) continue;
          const prior = reconcilePins(view.pinLayout, previousPins, []).layout;
          const layout = reconcilePins(prior, next.folderPins, []).layout;
          if (JSON.stringify(layout) === JSON.stringify(view.pinLayout)) continue;
          view.pinLayout = layout;
          await saveView(window.id, view);
        }
      } catch (error) {
        publish();
        throw error;
      }
    }
    return result;
  }

  const viewFor = async (windowId) =>
    normalizeView(model, await api.sessions.getWindowValue(windowId, VIEW_KEY));

  const saveView = async (windowId, view) => {
    await api.sessions.setWindowValue(windowId, VIEW_KEY, normalizeView(model, view));
    stateWrites++;
  };

  const membership = async (tabId) => (await cache.membership(tabId)) ?? null;

  async function saveMembership(tabId, value) {
    await cache.saveMembership(tabId, value);
    membershipVersion++;
    stateWrites++;
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

  async function selectionState(windowId) {
    const [tabs, view] = await readTogether([listTabs(windowId), viewFor(windowId)]);
    return { groups: structuredClone(model.groups), tabs, view };
  }

  async function settleClose(windowId, before, closedId, current) {
    if (!current()) return;
    // Ask the live sidebar, so native closes use its current query too. A closed
    // sidebar has no filter; nothing is persisted or left behind when it closes.
    let filter = null;
    try {
      filter = await readCloseFilter(windowId);
    } catch {
      // No receiver when the sidebar is closed or the extension is reloading.
    }
    if (!current()) return;
    const after = await selectionState(windowId);
    const id = closeFallback(before, after, closedId, filter);
    if (id !== null && current()) {
      await writeTab(windowId, 'update', id, { active: true });
      publish(windowId);
    }
  }

  async function closeTabs(windowId, ids, validate) {
    const before = await selectionState(windowId);
    const closing = Array.isArray(ids) ? ids : [ids];
    const active = before.tabs.find((tab) => tab.active && closing.includes(tab.id));
    const current = closeSelection.guard(windowId, closing);
    if (validate && !(await validate())) return false;
    await writeTab(windowId, 'remove', ids);
    if (active) await settleClose(windowId, before, active.id, current);
  }

  async function closeWithPromotion(windowId, id) {
    const tabs = await listTabs(windowId);
    const [parent, first, ...rest] = tabSubtree(tabs, id);
    if (!first) return closeTabs(windowId, id);
    const firstBranch = new Set(tabSubtree(tabs, first.id).map((tab) => tab.id));
    const descendants = [first, ...rest];
    const updates = new Map();
    let order = parent.order;
    // A shared preorder keeps both the promoted tree and an undone close in
    // the same visual order, even when the children were manually reordered.
    const fits = descendants.every(
      (_, index) =>
        Number.isFinite(order + index * 1024) &&
        (index === 0 || order + index * 1024 > order + (index - 1) * 1024),
    );
    if (!fits) {
      const peers = sortTabs(
        tabs.filter(
          (tab) => tab.groupId === parent.groupId && tab.parentTabId === parent.parentTabId,
        ),
      );
      for (const [index, tab] of peers.entries()) updates.set(tab.id, { order: index * 1024 });
      order = updates.get(id).order;
    }
    for (const [index, tab] of descendants.entries()) {
      const ancestors = [...tab.ancestors];
      // Keep the closed parent's key first: Undo then reconnects its original
      // children. The promoted child is only the fallback while it is absent.
      if (!firstBranch.has(tab.id))
        ancestors.splice(ancestors.indexOf(parent.treeId) + 1, 0, first.treeId);
      updates.set(tab.id, { ancestors, order: order + index * 1024 });
    }
    const changes = [];
    for (const [tabId, update] of updates) {
      const before = await membership(tabId);
      if (!membershipMatches(before, update))
        changes.push({ id: tabId, before, after: { ...before, ...update } });
    }
    await moves.apply(changes);
    try {
      await closeTabs(windowId, id);
    } catch (error) {
      // A failed close must not leave a half-promoted branch. If Firefox did
      // close the parent before reporting an error, retain the surviving tree.
      if (await findOpenTab(id))
        await moves.apply(
          changes.map(({ id, before, after }) => ({ id, before: after, after: before })),
        );
      throw error;
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
    // Native close animations can leave a tab in query() after Firefox has
    // invalidated its ID. Confirm that specific ID before reporting a session
    // failure; unrelated lookup errors are not evidence that a tab has closed.
    const stillLive = await Promise.all(
      failures.map(async ({ id }) =>
        live.has(id)
          ? api.tabs.get(id).then(
              () => true,
              (error) => error.message !== `Invalid tab ID: ${id}`,
            )
          : false,
      ),
    );
    const failed = failures.find((_, index) => stillLive[index]);
    if (failed)
      throw new Error(
        `Could not read or save tab organisation. Try again. ${failed.error.message}`,
      );
    // Animation completion sends no further removal event. Do not keep a
    // native list containing the closing tab cached for subsequent snapshots.
    cache.invalidateTabs();
    requestTabs.clear();
    for (const { id } of failures) cache.forgetMembership(id);
    return new Set(failures.map(({ id }) => id));
  }

  async function readRecords(tabs) {
    const failures = [];
    const records = await Promise.all(
      tabs
        .filter((tab) => !tab.incognito && !internalPage(api, tab.url))
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
    const key = windowId ?? null;
    const cached = resolvedTabs.get(key);
    if (
      cached?.native === tabs &&
      cached.groups === model.groups &&
      cached.membershipVersion === membershipVersion
    )
      return cached.tabs;
    const records = await readRecords(tabs);
    records.sort(
      (a, b) =>
        Number(treeOwners.get(b.value.treeId) === b.tab.id) -
          Number(treeOwners.get(a.value.treeId) === a.tab.id) || a.tab.id - b.tab.id,
    );
    const owners = allWindows ? new Map() : new Map(treeOwners);
    const groupIds = new Set(model.groups.map((group) => group.id));
    const result = [];
    const repairs = [];
    const closed = new Set();
    for (const { tab, value } of records) {
      let needsSave = false;
      let owner = owners.get(value.treeId);
      if (owner !== undefined && owner !== tab.id) {
        // A close/restore may race its removal event. Never treat a dead owner
        // as a live duplicate and break the restored tab's saved descendants.
        const alive = await findOpenTab(owner);
        if (!alive) {
          closed.add(owner);
          cache.forgetMembership(owner);
          cache.invalidateTabs();
          requestTabs.clear();
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
        if (duplicate) {
          value.collapsed = false;
          // Firefox copies session values on duplication, including the source's date.
          delete value.openedAt;
          delete value.savedForLaterAt;
        }
        // Do not set a group here: a just-created tab may still be waiting for
        // its queued onCreated handler to place it beneath its opener.
        needsSave = true;
      }
      if (!(Number.isFinite(value.openedAt) && value.openedAt > 0) && openedTimes.has(tab.id)) {
        value.openedAt = openedTimes.get(tab.id);
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
        openedAt: value.openedAt,
        ...(isSavedForLater(value) ? { savedForLaterAt: value.savedForLaterAt } : {}),
        treeId: value.treeId,
        ancestors: Array.isArray(value.ancestors)
          ? [...new Set(value.ancestors.filter((id) => typeof id === 'string'))]
          : [],
        collapsed: Boolean(value.collapsed),
      });
    }
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
    const resolved = resolveTabTree(
      result.filter(
        (tab) => !closed.has(tab.id) && (windowId == null || tab.windowId === windowId),
      ),
    );
    resolvedTabs.set(key, {
      native: tabs,
      groups: model.groups,
      membershipVersion,
      tabs: resolved,
    });
    return resolved;
  }

  async function snapshot(windowId, extra = {}) {
    const snapshotRevision = revision;
    const [tabs, view, identities, history] = await readTogether([
      listTabs(windowId),
      viewFor(windowId),
      // Containers can be disabled in Firefox. Their absence must not hide tabs.
      containers().catch(() => []),
      recentlyClosedTabs(windowId)
        .then((tabs) => ({ tabs }))
        .catch((error) => ({ tabs: [], error: error.message })),
    ]);
    closeSelection.remember(windowId, { groups: structuredClone(model.groups), tabs, view });
    const pins = reconcilePins(view.pinLayout, model.folderPins, tabs, forgottenPins.get(windowId));
    // Tab-only installations need no additional session writes. Once a mixed
    // layout exists, remember new slots without discarding pending restorations.
    if (
      (model.folderPins.length || view.pinLayout) &&
      JSON.stringify(view.pinLayout) !== JSON.stringify(pins.layout)
    ) {
      view.pinLayout = pins.layout;
      await saveView(windowId, view);
    }
    forgottenPins.delete(windowId);
    const savedKeys = new Set(tabs.filter(isSavedForLater).map((tab) => tab.treeId));
    const byStore = new Map(identities.map((identity) => [identity.cookieStoreId, identity]));
    return {
      generation,
      revision: snapshotRevision,
      groups: structuredClone(model.groups),
      folderPins: structuredClone(model.folderPins),
      domainPins: [...model.domainPins],
      pins: pins.items.filter((item) => item.kind !== 'tab' || !savedKeys.has(item.id)),
      containers: identities,
      look: { ...model.look },
      canUndoClose: history.tabs.length > 0,
      recentlyClosed: history.tabs,
      recentlyClosedError: history.error ?? null,
      tabs: tabs.map((tab) => {
        const identity = byStore.get(tab.cookieStoreId);
        return {
          ...tab,
          ancestors: [...tab.ancestors],
          ...(tab.mutedInfo ? { mutedInfo: { ...tab.mutedInfo } } : {}),
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
    if (!group) throw new Error('Choose a folder.');
    const groupIds = model.groups.filter((item) => isWithin(model, item.id, id)).map((g) => g.id);
    const tabs = (await listTabs()).filter(
      (tab) => !isSavedForLater(tab) && groupIds.includes(tab.groupId),
    );
    return {
      groupIds,
      tabIds: tabs.map((tab) => tab.id),
      pinnedCount: tabs.filter((tab) => tab.pinned).length,
      windowCount: new Set(tabs.map((tab) => tab.windowId)).size,
    };
  }

  async function moveGroupContents(id, destinationId) {
    const group = groupById(model, requireGroup(model, id));
    if (!group) throw new Error('Choose a folder to move contents from.');
    requireGroup(model, destinationId);
    if (isWithin(model, destinationId, id))
      throw new Error('Choose a destination outside this folder and its subfolders.');
    const tabs = (await listTabs()).filter((tab) => !isSavedForLater(tab));
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
        'This folder’s default container is unavailable. Choose another in Default container… or select No container.',
      );
    }
    return cookieStoreId;
  }

  async function recentlyClosedTabs(windowId) {
    const sessions = await cache.history();
    return sessions
      .filter(
        ({ tab }) =>
          tab?.windowId === windowId &&
          !tab.incognito &&
          tab.sessionId &&
          !internalPage(api, tab.url) &&
          !isNewTabPage(api, tab.url),
      )
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
    if (!tab || isSavedForLater(tab)) return;
    const view = await viewFor(windowId);
    if (!isWithin(model, tab.groupId, view.scopeId)) view.scopeId = tab.groupId;
    const parents = new Set(groupPath(model, tab.groupId).map((group) => group.id));
    view.collapsed = view.collapsed.filter((id) => !parents.has(id));
    await saveView(windowId, view);
    await expandAncestors(tabs, tab.id);
  }

  async function moveNativePin(windowId, id, beforeId = null) {
    const tab = await checkedTab(id, windowId);
    if (!tab.pinned) throw new Error('That tab is no longer pinned.');
    const pins = (await listTabs(windowId))
      .filter((item) => item.pinned)
      .sort((a, b) => a.index - b.index);
    if (beforeId === id) return;
    const remaining = pins.filter((item) => item.id !== id);
    const position =
      beforeId === null ? remaining.length : remaining.findIndex((item) => item.id === beforeId);
    if (position < 0) throw new Error('The destination pinned tab has moved or closed.');
    const index = pins[position].index;
    if (index === tab.index) return;
    const moved = await writeTab(windowId, 'move', id, { index });
    if (Array.isArray(moved) && !moved.length)
      throw new Error('Firefox could not move that pinned tab. Try again.');
    const expected = remaining.map((item) => item.id);
    expected.splice(position, 0, id);
    const actual = (await listTabs(windowId))
      .filter((item) => item.pinned)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.id);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('Firefox could not move that pinned tab. Try again.');
  }

  async function findOpenTab(id) {
    try {
      return await api.tabs.get(id);
    } catch (error) {
      if (error.message === `Invalid tab ID: ${id}`) return null;
      // A transient lookup failure is not evidence that the tab was closed.
      // Only an absent ID in a successful query can confirm it instead.
      if ((await api.tabs.query({})).some((tab) => tab.id === id)) throw error;
      return null;
    }
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
      const remaining = await findOpenTab(source.id);
      if (remaining) throw new Error('The original tab could not be closed. Try again.');
      treeOwners.set(source.treeId, replacement.id);
      tabTreeKeys.delete(source.id);
      tabTreeKeys.set(replacement.id, source.treeId);
      return replacement.id;
    } catch (error) {
      // Every fallible preparation step precedes closing the original.
      // If Firefox refuses the close, discard the replacement and retain the source.
      // If confirmation itself failed, retain the replacement: the original
      // may already be gone, and cleanup must never delete its only successor.
      const original = await findOpenTab(source.id).catch(() => null);
      if (original) {
        if (source.active)
          await writeTab(windowId, 'update', source.id, { active: true }).catch(() => {});
        await writeTab(windowId, 'remove', replacement.id).catch(() => {});
      }
      throw error;
    }
  }

  async function planTabMove(tabId, groupId, windowId, beforeId = null, parentTabId = null) {
    await checkedTab(tabId, windowId);
    requireGroup(model, groupId);
    const allTabs = await listTabs(windowId);
    if (isSavedForLater(allTabs.find((tab) => tab.id === tabId)))
      throw new Error('Return this tab from Saved for Later before moving it.');
    const subtree = tabSubtree(allTabs, tabId);
    if (!subtree.length) throw new Error('That tab has closed.');
    const moving = new Set(subtree.map((tab) => tab.id));
    const parent = allTabs.find((tab) => tab.id === parentTabId);
    if (parentTabId !== null && (!parent || isSavedForLater(parent) || parent.groupId !== groupId))
      throw new Error('The parent tab has moved. Try again.');
    if (moving.has(parentTabId))
      throw new Error('A tab cannot nest under itself or one of its children.');
    if (beforeId === tabId) return [];
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
    return changes;
  }

  async function moveTab(tabId, groupId, windowId, beforeId = null, parentTabId = null) {
    await moves.apply(await planTabMove(tabId, groupId, windowId, beforeId, parentTabId));
  }

  async function revealItem(source, windowId) {
    if (source.kind === 'tab') {
      const tab = (await listTabs(windowId)).find((tab) =>
        source.treeId ? tab.treeId === source.treeId : tab.id === source.id,
      );
      if (!tab) throw new Error('That tab has closed or moved to another window.');
      if (!tab.pinned) await revealTab(tab.id, windowId);
      return { kind: 'tab', id: tab.id, treeId: tab.treeId };
    }
    const group = groupById(model, requireGroup(model, source.id));
    if (!group) throw new Error('That folder no longer exists.');
    if (source.kind !== 'pin-group') {
      const view = await viewFor(windowId);
      if (view.scopeId === group.id || !isWithin(model, group.id, view.scopeId))
        view.scopeId = group.parentId;
      const parents = new Set(groupPath(model, group.parentId).map((item) => item.id));
      view.collapsed = view.collapsed.filter((id) => !parents.has(id));
      await saveView(windowId, view);
    }
    return source;
  }

  async function moveItem(message) {
    const { windowId, operationId } = message;
    if (typeof operationId !== 'string' || !operationId || operationId.length > 128)
      throw new Error('Choose a valid move operation.');
    let receipt = ((await api.storage.local.get(receiptKey))[receiptKey] || {})[windowId];
    if (receipt?.operationId !== operationId) {
      const current = await snapshot(windowId);
      const plan = resolveMove(current, message.source, message.destination);
      if (message.expected !== plan.expected)
        throw new Error('The source or destination has moved. Try again.');
      const destination = plan.destination;
      let changes = [],
        groups = null,
        effects = null;
      if (!plan.noOp) {
        if (destination.kind === 'tree') {
          changes = await planTabMove(
            plan.source.id,
            destination.groupId,
            windowId,
            destination.beforeId,
            destination.parentTabId,
          );
        } else if (destination.kind === 'folder') {
          const next = structuredClone(model);
          moveGroup(next, plan.source.id, destination.parentId, destination.beforeId);
          groups = { before: model.groups, after: next.groups };
        }
        const tab = current.tabs.find(
          (tab) => tab.id === plan.source.id && plan.source.kind === 'tab',
        );
        if (destination.kind === 'pins' || tab?.pinned) {
          effects = { windowId };
          if (tab) {
            const nativePins = current.tabs
              .filter((tab) => tab.pinned)
              .sort((a, b) => a.index - b.index);
            const ordered = (plan.pinItems || []).filter((item) => item.kind === 'tab');
            effects.pin = {
              treeId: tab.treeId,
              before: {
                pinned: Boolean(tab.pinned),
                beforeTreeId:
                  nativePins[nativePins.findIndex((item) => item.id === tab.id) + 1]?.treeId ??
                  null,
              },
              after: {
                pinned: plan.pinned,
                beforeTreeId: plan.pinned
                  ? (ordered[ordered.findIndex((item) => item.id === tab.treeId) + 1]?.id ?? null)
                  : null,
              },
            };
          }
          const layout =
            destination.kind === 'pins'
              ? plan.pinItems
              : current.pins.filter((item) => item.kind !== 'tab' || item.id !== tab.treeId);
          if (current.folderPins.length || current.view.pinLayout)
            effects.layout = {
              item: { kind: tab ? 'tab' : 'group', id: tab ? tab.treeId : plan.source.id },
              before: current.view.pinLayout || current.pins,
              after: layout,
            };
          if (plan.source.kind === 'pin-group') {
            const pins = new Map(model.folderPins.map((pin) => [pin.id, pin]));
            effects.folderPins = {
              before: model.folderPins,
              after: plan.pinItems
                .filter((item) => item.kind === 'group')
                .map((item) => pins.get(item.id)),
            };
          }
        }
      }
      receipt = {
        windowId,
        operationId,
        source: plan.source,
        label: plan.noOp
          ? 'Already in this position.'
          : plan.label
              .replace(/^Unpin and move/, 'Unpinned and moved')
              .replace(/^Move/, 'Moved')
              .replace(/^Pin /, 'Pinned ')
              .replace(/^Reorder /, 'Reordered '),
      };
      await moves.apply(changes, groups, { effects, receipt });
    }
    let revealError;
    try {
      receipt = { ...receipt, source: await revealItem(receipt.source, windowId) };
    } catch (error) {
      revealError = error.message;
    }
    return { ...receipt, committed: true, revealError };
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
    if (folderBackupActions.has(type)) return folderBackup(message);
    let extra = {};
    switch (type) {
      case 'moveStatus':
        return ((await api.storage.local.get(receiptKey))[receiptKey] || {})[windowId] ?? null;
      case 'moveItem':
        extra.moveResult = await moveItem(message);
        break;
      case 'revealItem':
        extra.revealedItem = await revealItem(message.source, windowId);
        break;
      case 'snapshot':
        return snapshot(windowId);
      case 'getSettings':
        return {
          look: { ...model.look },
          newTab: structuredClone(model.newTab),
          generation,
          revision,
        };
      case 'getNewTabState':
        return { ...(await snapshot(windowId)), newTab: structuredClone(model.newTab) };
      case 'setNewTab': {
        const value = requireNewTab({ ...model.newTab, ...message.value });
        await changeModel((next) => {
          next.newTab = value;
        });
        publish();
        return {
          newTab: structuredClone(model.newTab),
          look: { ...model.look },
          generation,
          revision,
        };
      }
      case 'previewNewTab': {
        const value = requireNewTab({ ...model.newTab, ...message.value });
        const token = crypto.randomUUID();
        const key = `tabernacle.newTabPreview.${token}`;
        await api.storage.session.set({ [key]: value });
        try {
          const tab = await api.tabs.create({
            windowId,
            url: api.runtime.getURL(`new-tab.html?preview=${token}`),
            active: true,
          });
          return { tabId: tab.id };
        } catch (error) {
          await api.storage.session.remove(key);
          throw error;
        }
      }
      case 'openPage':
        return openInternalPage(api, message.page, windowId, { section: message.section });
      case 'claimSettingsPage': {
        const tab = await checkedTab(message.id, windowId);
        if (internalPage(api, tab.url) !== 'settings') throw new Error('Not a Settings page.');
        return openInternalPage(api, 'settings', windowId, { claimingTabId: tab.id });
      }
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
          throw new Error('Choose a valid folder identifier.');
        extra.createdGroupId = id;
        if (groupById(model, id)) break;
        const parentId = requireGroup(model, message.parentId ?? null);
        const name = cleanName(message.name);
        const appearance = requireGroupAppearance(message.appearance ?? {});
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
            if (Object.keys(appearance).length) group.appearance = appearance;
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
        if (message.id === null) throw new Error('Choose a folder to rename.');
        await changeModel((next) => {
          groupById(next, message.id).name = cleanName(message.name);
        });
        break;
      }
      case 'setGroupContainer': {
        const group = groupById(model, requireGroup(model, message.id));
        if (!group) throw new Error('Choose a folder to set a default container.');
        if (message.cookieStoreId !== null) await requireContainer(message.cookieStoreId);
        await changeModel((next) => {
          const target = groupById(next, group.id);
          if (message.cookieStoreId === null) delete target.defaultCookieStoreId;
          else target.defaultCookieStoreId = message.cookieStoreId;
        });
        break;
      }
      case 'setGroupAppearance': {
        const group = groupById(model, requireGroup(model, message.id));
        if (!group) throw new Error('Choose a folder to customise.');
        const appearance = requireGroupAppearance(message.appearance);
        await changeModel((next) => {
          const target = groupById(next, group.id);
          if (Object.keys(appearance).length) target.appearance = appearance;
          else delete target.appearance;
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
        if (!group) throw new Error('Choose a folder to delete.');
        if (
          !Array.isArray(message.groupIds) ||
          !message.groupIds.every((id) => typeof id === 'string') ||
          !message.groupIds.includes(group.id) ||
          !Array.isArray(message.tabIds) ||
          !message.tabIds.every(Number.isInteger)
        )
          throw new Error('Confirm the folder and tabs to delete.');
        const contents = await groupContents(group.id);
        if (
          contents.groupIds.some((id) => !message.groupIds.includes(id)) ||
          contents.tabIds.some((id) => !message.tabIds.includes(id))
        )
          throw new Error('The folder contents changed. Close this dialog and review them again.');
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
            'Some tabs are still open. Close them or try again before deleting the folder.',
          );
        await changeModel((next) => removeGroup(next, group.id));
        break;
      }
      case 'enterGroup': {
        const scopeId = requireGroup(model, message.id ?? null);
        const view = await viewFor(windowId);
        if (scopeId !== null && scopeId !== view.scopeId)
          view.recentFolders = [
            { id: scopeId, enteredAt: Date.now() },
            ...(view.recentFolders ?? []).filter(({ id }) => id !== scopeId),
          ];
        view.scopeId = scopeId;
        if (scopeId !== null && typeof message.collapsed === 'boolean') {
          if (!message.collapsed && view.collapsed.includes(scopeId))
            recordExpansions(view, [scopeId]);
          view.collapsed = view.collapsed.filter((id) => id !== scopeId);
          if (message.collapsed) view.collapsed.push(scopeId);
        }
        await saveView(windowId, view);
        // Navigating into a nonempty group brings a real member tab into view.
        if (scopeId !== null) {
          const tabs = (await listTabs(windowId)).filter(
            (tab) => !isSavedForLater(tab) && isWithin(model, tab.groupId, scopeId),
          );
          if (tabs.length && !tabs.some((tab) => tab.active)) {
            tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
            await writeTab(windowId, 'update', tabs[0].id, { active: true });
          }
        }
        break;
      }
      case 'revealGroup': {
        const group = groupById(model, requireGroup(model, message.id));
        if (!group) throw new Error('Choose a folder to show.');
        const view = await viewFor(windowId);
        // The scoped folder itself has no row: its parent tree must be shown.
        if (view.scopeId === group.id || !isWithin(model, group.id, view.scopeId))
          view.scopeId = null;
        if (view.collapsed.includes(group.id)) recordExpansions(view, [group.id]);
        const expanded = new Set(groupPath(model, group.id).map((item) => item.id));
        view.collapsed = view.collapsed.filter((id) => !expanded.has(id));
        await saveView(windowId, view);
        break;
      }
      case 'setDomainPin': {
        const domain = normaliseDomain(message.domain);
        if (!domain || typeof message.pinned !== 'boolean')
          throw new Error('Choose a domain and whether to pin it.');
        await changeModel((next) => {
          const pins = new Set(next.domainPins);
          if (message.pinned) pins.add(domain);
          else pins.delete(domain);
          next.domainPins = [...pins];
        });
        break;
      }
      case 'setGroupPin': {
        const group = groupById(model, requireGroup(model, message.id));
        if (!group) throw new Error('Choose a folder to pin.');
        if (message.action !== null && !Object.hasOwn(pinActionLabels, message.action))
          throw new Error('Choose what clicking the pinned folder does.');
        await changeModel((next) => {
          const existing = next.folderPins.find((item) => item.id === group.id);
          if (message.action === null)
            next.folderPins = next.folderPins.filter((item) => item.id !== group.id);
          else if (existing) existing.action = message.action;
          else next.folderPins.push({ id: group.id, action: message.action });
        });
        break;
      }
      case 'toggleGroup': {
        requireGroup(model, message.id);
        const view = await viewFor(windowId);
        if (view.collapsed.includes(message.id)) recordExpansions(view, [message.id]);
        view.collapsed = view.collapsed.includes(message.id)
          ? view.collapsed.filter((id) => id !== message.id)
          : [...view.collapsed, message.id];
        await saveView(windowId, view);
        break;
      }
      case 'collapseAll': {
        const view = await viewFor(windowId);
        if (!message.collapsed) recordExpansions(view, view.collapsed);
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
        if (!message.collapsed)
          recordExpansions(
            view,
            view.collapsed.filter((id) => branches.groupIds.has(id)),
          );
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
          ...(model.newTab.enabled ? { url: api.runtime.getURL('new-tab.html?start=1') } : {}),
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
          ...(model.newTab.enabled ? { url: api.runtime.getURL('new-tab.html?start=1') } : {}),
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
          if (message.expandAncestors !== false) await expandAncestors(tabs, tab.id);
          await writeTab(windowId, 'update', tab.id, { active: true });
          if (!window.focused) await api.windows.update(windowId, { focused: true });
        }
        if (message.reveal === true) await revealTab(message.id, windowId);
        break;
      }
      case 'saveTabsForLater':
      case 'undoSaveTabsForLater':
      case 'closeTabSet':
      case 'closeDuplicateTabs': {
        const tabs = await listTabs(windowId);
        const initial = new Map(tabs.map((tab) => [tab.id, tab]));

        const freshTab = async (id) => {
          const original = initial.get(id);
          if (!original) return null;
          const current = await membership(id);
          if (!current || current.treeId !== original.treeId) return null;
          const native = await findOpenTab(id);
          if (!native || native.windowId !== windowId) return null;
          return { ...original, ...native, ...current };
        };

        const state = { groups: model.groups, tabs };
        extra.batchResult = await applyTabBatch(message, {
          state,
          freshTab,
          isClosed: async (id) => !(await findOpenTab(id)),

          save: async (id, savedForLaterAt, validate) => {
            if (!(await validate())) return false;
            await updateMembership(id, { savedForLaterAt });
          },

          close: (id, validate) => closeTabs(windowId, id, validate),
        });
        break;
      }
      case 'saveForLater': {
        await checkedTab(message.id, windowId);
        // Initialise durable placement first; saving changes only the queue membership.
        const tabs = await listTabs(windowId);
        const tab = tabs.find((tab) => tab.id === message.id);
        if (!tab) throw new Error('That tab has closed.');
        if (!isSavedForLater(tab)) {
          // Preserve addition order even when multiple saves share a clock tick.
          const newest = tabs.reduce((time, item) => Math.max(time, item.savedForLaterAt || 0), 0);
          await updateMembership(tab.id, { savedForLaterAt: Math.max(Date.now(), newest + 1) });
        }
        break;
      }
      case 'returnFromLater': {
        await checkedTab(message.id, windowId);
        await updateMembership(message.id, { savedForLaterAt: null });
        break;
      }
      case 'closeTab':
        await checkedTab(message.id, windowId);
        if (message.promoteFirstChild) await closeWithPromotion(windowId, message.id);
        else await closeTabs(windowId, message.id);
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
        if (ids.length) await closeTabs(windowId, ids);
        break;
      }
      case 'closeGroupTabs': {
        const group = groupById(model, requireGroup(model, message.id));
        if (!group) throw new Error('Choose a folder whose tabs you want to close.');
        if (!Array.isArray(message.tabIds) || !message.tabIds.every(Number.isInteger))
          throw new Error('Choose the tabs to close.');
        // Only close tabs shown in the confirmation that still belong here.
        // Tabs opened later, moved out, or moved to another window are excluded.
        const confirmed = new Set(message.tabIds);
        const ids = (await listTabs(windowId))
          .filter(
            (tab) =>
              !isSavedForLater(tab) &&
              confirmed.has(tab.id) &&
              isWithin(model, tab.groupId, group.id),
          )
          .map((tab) => tab.id);
        if (ids.length) await closeTabs(windowId, ids);
        break;
      }
      case 'pinTab': {
        const tab = await checkedTab(message.id, windowId);
        await writeTab(windowId, 'update', tab.id, { pinned: !tab.pinned });
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
          openedAt: openedTimes.get(tab.id) ?? Date.now(),
          savedForLaterAt: null,
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
        const look = requireLook(
          message.partial ? { ...model.look, ...message.value } : message.value,
        );
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
        'setGroupAppearance',
        'moveGroup',
        'moveGroupContents',
        'removeGroup',
        'setGroupPin',
        'setDomainPin',
        'setLook',
      ].includes(type) ||
        (type === 'moveItem' && message.source?.kind !== 'tab')
        ? undefined
        : windowId,
    );
    return snapshot(windowId, extra);
  }

  async function assignCreated(tab, contexts) {
    if (tab.incognito || internalPage(api, tab.url)) return;
    const saved = await membership(tab.id);
    if (saved && Object.hasOwn(saved, 'groupId')) {
      if (treeOwners.get(saved.treeId) === tab.id) {
        if (!(Number.isFinite(saved.openedAt) && saved.openedAt > 0)) {
          await updateMembership(tab.id, { openedAt: openedTimes.get(tab.id) });
          publish(tab.windowId);
        }
        return;
      }
      await listTabs(tab.windowId);
      contexts.delete(tab.windowId);
      publish(tab.windowId);
      return;
    }
    await checkedTab(tab.id, tab.windowId);
    let context = contexts.get(tab.windowId);
    if (!context || context.revision !== revision) {
      requestTabs = new Map();
      const before = revision;
      const [tabs, view] = await readTogether([listTabs(tab.windowId), viewFor(tab.windowId)]);
      // This projection belongs only to this batch. Never edit cached snapshots.
      const projected = tabs.map((tab) => ({ ...tab }));
      const byId = new Map(projected.map((tab) => [tab.id, tab]));
      const siblings = new Map();
      for (const item of sortTabs(unpinnedTabTree(projected))) {
        const key = JSON.stringify([item.groupId, item.parentTabId]);
        if (!siblings.has(key)) siblings.set(key, []);
        siblings.get(key).push(byId.get(item.id));
      }
      context = { tabs: projected, byId, siblings, view, revision: before };
      contexts.set(tab.windowId, context);
    }
    const source = context.byId.get(tab.id);
    if (!source) throw new Error('That tab has closed or moved to another window.');
    const candidate = context.byId.get(tab.openerTabId);
    const opener =
      candidate && candidate.id !== tab.id && !candidate.pinned && !isSavedForLater(candidate)
        ? candidate
        : null;
    const groupId = opener ? opener.groupId : context.view.scopeId;
    const parentTabId = opener?.id ?? null;
    const key = JSON.stringify([groupId, parentTabId]);
    const peers = (context.siblings.get(key) || []).filter((item) => item.id !== tab.id);
    const order = insertionOrder(peers, peers.length);
    const ancestors = [];
    const seen = new Set([tab.id]);
    let collapsedParent = false;
    for (
      let parent = opener;
      parent && !seen.has(parent.id);
      parent = context.byId.get(parent.parentTabId)
    ) {
      seen.add(parent.id);
      ancestors.push(parent.treeId);
      collapsedParent ||= parent.collapsed;
    }
    // Restored relationships, parent expansion, pinned siblings and exhausted
    // orders keep the complete move/recovery path. Ordinary new leaves only
    // need one membership write and can share this batch's index.
    if (
      order === null ||
      source.pinned ||
      collapsedParent ||
      context.tabs.some(
        (item) =>
          item.parentTabId === tab.id ||
          (parentTabId !== null &&
            item.pinned &&
            item.groupId === groupId &&
            item.parentTabId === parentTabId),
      )
    ) {
      await moveTab(tab.id, groupId, tab.windowId, null, parentTabId);
      contexts.delete(tab.windowId);
      publish(tab.windowId);
      return;
    }
    const before = revision;
    await updateMembership(tab.id, { groupId, ancestors, order });
    const oldParent = context.byId.get(source.parentTabId);
    const oldKey = JSON.stringify([source.groupId, oldParent?.pinned ? null : source.parentTabId]);
    const oldPeers = context.siblings.get(oldKey);
    const oldIndex = oldPeers?.findIndex((item) => item.id === tab.id) ?? -1;
    if (oldIndex >= 0) oldPeers.splice(oldIndex, 1);
    Object.assign(source, { groupId, ancestors, order, parentTabId });
    if (!source.pinned) {
      peers.push(source);
      context.siblings.set(key, peers);
    }
    const fresh = context.revision === before && revision === before;
    publish(tab.windowId);
    if (fresh) context.revision = revision;
  }

  function created(tab) {
    // Capture the event time before queued work runs. Existing tabs discovered at
    // startup have no known creation date; restored tabs retain their saved date.
    openedTimes.set(tab.id, Date.now());
    requestTabs.clear();
    resolvedTabs.delete(tab.windowId);
    resolvedTabs.delete(null);
    let batch = pendingCreations;
    if (!batch) {
      batch = { entries: [] };
      const work = enqueue(async () => {
        if (pendingCreations === batch) pendingCreations = null;
        const contexts = new Map();
        let needsRecovery = false;
        for (const entry of batch.entries) {
          try {
            if (needsRecovery) {
              await moves.recover();
              needsRecovery = false;
            }
            await assignCreated(entry.tab, contexts);
            entry.resolve();
          } catch (error) {
            contexts.clear();
            needsRecovery = true;
            entry.reject(error);
          } finally {
            openedTimes.delete(entry.tab.id);
          }
        }
      });
      pendingCreations = batch;
      work.catch((error) => {
        for (const entry of batch.entries) {
          openedTimes.delete(entry.tab.id);
          entry.reject(error);
        }
      });
    }
    return new Promise((resolve, reject) => batch.entries.push({ tab, resolve, reject }));
  }

  return {
    start: () => enqueue(() => {}),
    request: (message) =>
      enqueue(async () => {
        requestTabs = new Map();
        const beforeWrites = stateWrites;
        try {
          return await handle(message);
        } catch (error) {
          // Some operations span browser and session writes. Refresh all
          // sidebars from committed state even if a later write failed.
          if (stateWrites !== beforeWrites) publish();
          throw error;
        }
      }, !folderBackupActions.has(message.type)),

    dispose() {
      closeSelection.dispose();
      cache.dispose();
      resolvedTabs.clear();
    },

    created,
  };
}
