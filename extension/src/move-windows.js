export const MOVE_WINDOW_KEY = 'tabernacle.move-window.v1';
const RECEIPT_KEY = 'tabernacle.move-receipts.v1';

// Native window IDs last only for a browser process. Assign a session identity
// lazily, before journalling a move; existing views and journals are untouched.
export function createMoveWindows(api) {
  async function read(windowId) {
    const key = await api.sessions.getWindowValue(windowId, MOVE_WINDOW_KEY);
    if (key !== undefined && (typeof key !== 'string' || !key))
      throw new Error('The saved move window identity is invalid. Your data has been kept.');
    return key;
  }

  async function windows() {
    return Promise.all(
      (await api.windows.getAll()).map(async ({ id }) => ({ id, key: await read(id) })),
    );
  }

  function match(records, key) {
    const matches = records.filter((window) => window.key === key);
    if (matches.length > 1)
      throw new Error('Move recovery found duplicated window identities. Your data has been kept.');
    return matches[0];
  }

  return {
    async identify(windowId) {
      const saved = await read(windowId);
      if (saved !== undefined) return saved;
      const key = crypto.randomUUID();
      await api.sessions.setWindowValue(windowId, MOVE_WINDOW_KEY, key);
      return key;
    },

    async resolve(record) {
      // Version 1 and older version 2 records retain their original contract.
      if (record.windowKey === undefined) return record.windowId;
      const window = match(await windows(), record.windowKey);
      if (!window)
        throw new Error('The moving window is unavailable. Restore it to finish recovery.');
      return window.id;
    },

    async receipt(windowId) {
      const saved = (await api.storage.local.get(RECEIPT_KEY))[RECEIPT_KEY] || {};
      const key = await read(windowId);
      const receipt =
        (key && Object.values(saved).find((value) => value.windowKey === key)) ||
        (saved[windowId]?.windowKey === undefined ? saved[windowId] : null);
      return receipt ? { ...receipt, windowId } : null;
    },

    async saveReceipt(receipt) {
      const saved = (await api.storage.local.get(RECEIPT_KEY))[RECEIPT_KEY] || {};
      const current = await windows();
      const receipts = {};
      // Retain legacy receipts while allowing keyed records to follow restored
      // windows, including when Firefox reuses another window's old numeric ID.
      for (const value of Object.values(saved).sort(
        (a, b) => Number(Boolean(a.windowKey)) - Number(Boolean(b.windowKey)),
      )) {
        const window = value.windowKey
          ? match(current, value.windowKey)
          : current.find((window) => window.id === value.windowId);
        if (window) receipts[window.id] = { ...value, windowId: window.id };
      }
      const window = receipt.windowKey
        ? match(current, receipt.windowKey)
        : current.find((window) => window.id === receipt.windowId);
      if (window) receipts[window.id] = { ...receipt, windowId: window.id };
      await api.storage.local.set({ [RECEIPT_KEY]: receipts });
    },
  };
}
