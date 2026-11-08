import { bookmarkUrl } from '../bookmarks.js';

export const BOOKMARK_OPEN_KEY = 'tabernacle.bookmark-open.v1';
const stageUrl = (operationId) => `about:blank#tabernacle-bookmark-${operationId}`;
const validId = (id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);

// Called only inside the controller queue. A window receipt and a marked blank
// tab bridge creation, membership and navigation, including lost API replies.
// The receipt follows Firefox's window session across background restarts.
export function createBookmarkActions({ api, requireFolder, newTabContainer, moveTab, writeTab }) {
  async function receipt(windowId) {
    const saved = await api.sessions.getWindowValue(windowId, BOOKMARK_OPEN_KEY);
    if (saved === undefined) return null;
    if (
      !saved ||
      saved.version !== 1 ||
      !validId(saved.operationId) ||
      typeof saved.bookmarkId !== 'string' ||
      typeof saved.url !== 'string' ||
      !(saved.groupId === null || typeof saved.groupId === 'string') ||
      typeof saved.cookieStoreId !== 'string' ||
      !['pending', 'placed', 'complete'].includes(saved.phase)
    )
      throw new Error(
        'The saved bookmark opening is unsupported. Its record has not been changed.',
      );
    bookmarkUrl(saved.url);
    return saved;
  }

  async function findTab(windowId, record) {
    if (Number.isInteger(record.tabId)) {
      const tab = await api.tabs.get(record.tabId).catch(() => null);
      if (
        tab?.windowId === windowId &&
        (await api.sessions.getTabValue(tab.id, BOOKMARK_OPEN_KEY)) === record.operationId
      )
        return tab;
    }
    const tabs = await api.tabs.query({});
    for (const tab of tabs) {
      const marker = await api.sessions.getTabValue(tab.id, BOOKMARK_OPEN_KEY);
      if (marker === record.operationId || tab.url === stageUrl(record.operationId)) {
        if (tab.windowId !== windowId)
          throw new Error(
            'The bookmark tab has moved to another window. Its opening has been preserved.',
          );
        return tab;
      }
    }
    return null;
  }

  async function finish(windowId, record, fresh = false) {
    let tab = fresh ? null : await findTab(windowId, record);
    if (record.phase === 'complete') return tab?.id;
    requireFolder(record.groupId);
    await newTabContainer(record.groupId, record.cookieStoreId);
    if (!tab) {
      // After placement, a missing tab was closed by the user. Never recreate it
      // in response to an old retry.
      if (record.phase === 'placed') {
        await api.sessions.setWindowValue(windowId, BOOKMARK_OPEN_KEY, {
          ...record,
          phase: 'complete',
        });
        return;
      }
      tab = await writeTab(windowId, 'create', {
        windowId,
        url: stageUrl(record.operationId),
        cookieStoreId: record.cookieStoreId,
        active: false,
      });
    }
    if (tab.cookieStoreId !== record.cookieStoreId)
      throw new Error(
        'The bookmark tab’s container has changed. Its opening has been preserved for retry.',
      );
    await api.sessions.setTabValue(tab.id, BOOKMARK_OPEN_KEY, record.operationId);
    // Firefox can return about:blank from create() before exposing its requested
    // fragment. A pending receipt has not navigated to the bookmark yet.
    const needsNavigation = record.phase === 'pending' || tab.url === stageUrl(record.operationId);
    if (record.phase === 'pending') {
      await moveTab(tab.id, record.groupId, windowId);
      record = { ...record, phase: 'placed', tabId: tab.id };
      await api.sessions.setWindowValue(windowId, BOOKMARK_OPEN_KEY, record);
    }
    // A rejected update can already have navigated. Avoid navigating again on
    // retry (including pages that have since redirected).
    if (needsNavigation)
      await writeTab(windowId, 'update', tab.id, { url: record.url, active: true });
    await api.sessions.setWindowValue(windowId, BOOKMARK_OPEN_KEY, {
      ...record,
      phase: 'complete',
    });
    return tab.id;
  }

  return async ({ windowId, id, groupId = null, operationId }) => {
    if (!validId(operationId) || typeof id !== 'string' || !id)
      throw new Error('Choose a bookmark to open.');
    let record = await receipt(windowId);
    if (record?.operationId === operationId) {
      if (record.bookmarkId !== id || record.groupId !== groupId)
        throw new Error('This bookmark opening belongs to another destination.');
      return finish(windowId, record);
    }
    if (record && record.phase !== 'complete') await finish(windowId, record);
    requireFolder(groupId);
    const cookieStoreId = (await newTabContainer(groupId)) ?? 'firefox-default';
    const [bookmark] = await api.bookmarks.get(id);
    if (!bookmark?.url) throw new Error('That bookmark no longer exists.');
    record = {
      ...record,
      version: 1,
      operationId,
      bookmarkId: id,
      url: bookmarkUrl(bookmark.url),
      groupId,
      cookieStoreId,
      phase: 'pending',
    };
    delete record.tabId;
    await api.sessions.setWindowValue(windowId, BOOKMARK_OPEN_KEY, record);
    return finish(windowId, record, true);
  };
}
