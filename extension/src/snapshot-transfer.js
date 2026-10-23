import { isPlainPresentation } from './presentation-cache.js';

// Native messaging copies every object across processes. Keep unchanged tabs
// in the receiving view, while continuing to read authoritative full snapshots.
// Tokens identify a specific response, independently of notification revisions.
function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  const pending = [[a, b]];
  const forward = new WeakMap();
  const reverse = new WeakMap();
  while (pending.length) {
    const [left, right] = pending.pop();
    if (Object.is(left, right) && (left === null || typeof left !== 'object')) continue;
    if (
      left === null ||
      right === null ||
      typeof left !== 'object' ||
      typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right) ||
      (Array.isArray(left) && left.length !== right.length)
    )
      return false;
    if (forward.has(left) || reverse.has(right)) {
      if (forward.get(left) !== right || reverse.get(right) !== left) return false;
      continue;
    }
    forward.set(left, right);
    reverse.set(right, left);
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(right, key)) return false;
      pending.push([left[key], right[key]]);
    }
  }
  return true;
}

export function createSnapshotEncoder(options = {}) {
  const {
    maxBases = 128,
    maxTabReferences = 250000,
    idleMs = 5 * 60 * 1000,
    now = Date.now,
  } = typeof options === 'number' ? { maxBases: options } : options;
  for (const value of [maxBases, maxTabReferences, idleMs])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError('Snapshot retention limits must be non-negative integers.');
  const previous = new Map();
  const generation = crypto.randomUUID();
  let sequence = 0;
  let tabReferences = 0;

  const remove = (token) => {
    const entry = previous.get(token);
    if (!entry) return;
    tabReferences -= entry.tabs.length;
    previous.delete(token);
  };

  const expire = (time) => {
    for (const [token, entry] of previous) if (time - entry.lastUsed >= idleMs) remove(token);
  };

  return {
    encode(windowId, state, baseToken, version = 1) {
      const time = now();
      expire(time);
      const before = previous.get(baseToken);
      const retainable = isPlainPresentation(state);
      const token = `${generation}:${++sequence}`;
      let result = { token, state };
      if (
        retainable &&
        state.tabs.length <= maxTabReferences &&
        before &&
        before.windowId === windowId &&
        before.generation === state.generation &&
        before.tabs.length === state.tabs.length &&
        state.tabs.every((tab, i) => tab.id === before.tabs[i].id)
      ) {
        const changes = [];
        for (const [index, tab] of state.tabs.entries())
          if (!sameValue(tab, before.tabs[index])) changes.push({ index, tab });
        // Large structural changes are cheaper and simpler to send in full.
        if (changes.length < state.tabs.length / 2) {
          const { tabs, ...rest } = state;
          result = { token, baseToken, state: rest, changes };
        }
      }
      if (before?.windowId === windowId) remove(baseToken);
      if (retainable && maxBases && idleMs && state.tabs.length <= maxTabReferences) {
        while (previous.size >= maxBases || tabReferences + state.tabs.length > maxTabReferences)
          remove(previous.keys().next().value);
        // The transport receives immutable presentation rows from its controller.
        // Retain only comparison data; model/view/selection wrappers are transient.
        previous.set(token, {
          windowId,
          generation: state.generation,
          tabs: state.tabs,
          lastUsed: time,
        });
        tabReferences += state.tabs.length;
      }
      return version === 2 ? { ...result, snapshotProtocol: 2 } : result;
    },

    forget(windowId) {
      expire(now());
      for (const [token, entry] of previous) if (entry.windowId === windowId) remove(token);
    },

    stats() {
      return { bases: previous.size, tabReferences };
    },
  };
}

export function createSnapshotReader(send) {
  let previous;
  let epoch = 0;
  let sequence = 0;
  let completed = 0;

  const receive = async (request, action = false) => {
    // An action and an ordinary refresh share the view's existing response base.
    const before = previous;
    const requestEpoch = epoch;
    const requestSequence = ++sequence;
    let result = await request(before?.token);
    // Other action results (including folder-import previews) also have tokens.
    // Only the negotiated snapshot marker opts a non-snapshot result into decoding.
    if (action && !Array.isArray(result?.tabs) && result?.snapshotProtocol === undefined)
      return result;

    const valid = (value) => {
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value.tabs)) return true;
      if (!value.token || !value.state) return false;
      if (value.baseToken && value.baseToken !== before?.token) return false;
      if (value.snapshotProtocol !== 2) return value.snapshotProtocol === undefined;
      if (typeof value.token !== 'string' || typeof value.state.generation !== 'string')
        return false;
      if (!value.baseToken) return Array.isArray(value.state.tabs);
      if (
        !before ||
        value.state.generation !== before.state.generation ||
        Object.hasOwn(value.state, 'tabs') ||
        !Array.isArray(value.changes)
      )
        return false;
      const indices = new Set();
      for (const change of value.changes) {
        if (
          !change ||
          !Number.isSafeInteger(change.index) ||
          change.index < 0 ||
          change.index >= before.state.tabs.length ||
          indices.has(change.index) ||
          !change.tab ||
          change.tab.id !== before.state.tabs[change.index].id
        )
          return false;
        indices.add(change.index);
      }
      return true;
    };

    let extras;
    if (!valid(result)) {
      // Never repeat a mutation to repair transport. Preserve its receipt and
      // other result fields while taking all snapshot fields from a fresh read.
      extras = action && result?.state && typeof result.state === 'object' ? result.state : null;
      result = await send();
      if (!valid(result) || (!Array.isArray(result.tabs) && result.baseToken))
        throw new Error('Tabernacle could not refresh. Try reopening the sidebar.');
    }
    const envelope = !Array.isArray(result.tabs);
    let state = envelope ? result.state : result;
    if (envelope && result.baseToken) {
      const tabs = before.state.tabs.slice();
      for (const { index, tab } of result.changes) tabs[index] = tab;
      state = { ...state, tabs };
    }
    if (requestEpoch === epoch && requestSequence > completed) {
      completed = requestSequence;
      previous = envelope ? { token: result.token, state } : undefined;
    }
    return extras ? { ...extras, ...state } : state;
  };

  const read = () => receive(send);
  read.perform = (sendAction) => receive(sendAction, true);

  read.clear = () => {
    previous = undefined;
    epoch++;
  };
  return read;
}
