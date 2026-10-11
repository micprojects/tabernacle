// Theme data is per-window presentation state, never part of the saved model.
export function observeTheme({ api, windowId, media, onChange }) {
  let snapshot = { active: null, details: null };
  let generation = 0;
  let queued = false;
  let disposed = false;
  const removers = [];

  async function read(readValue) {
    try {
      return await readValue();
    } catch {
      return null;
    }
  }

  async function refresh() {
    queued = false;
    const revision = generation;
    const [addons, details, platform] = await Promise.all([
      read(() => api?.management?.getAll()),
      read(() => api?.theme?.getCurrent(windowId)),
      read(() => api?.runtime?.getPlatformInfo()),
    ]);
    if (disposed || revision !== generation) return;
    const active = addons?.find((addon) => addon.type === 'theme' && addon.enabled);
    // Do not retain the installed extension inventory.
    snapshot = {
      active: active ? { id: active.id, name: active.name, version: active.version } : null,
      details,
      platform: platform?.os,
    };
    onChange();
  }

  function schedule() {
    if (disposed) return;
    generation++;
    if (queued) return;
    queued = true;
    queueMicrotask(refresh);
  }

  function listen(getEvent, listener) {
    try {
      const event = getEvent();
      event?.addListener(listener);
      if (event) removers.push(() => event.removeListener(listener));
    } catch {
      /* Missing browser APIs (including the web preview) use fallback. */
    }
  }

  listen(
    () => api?.theme?.onUpdated,
    (event) => {
      if (event.windowId === undefined || event.windowId === windowId) schedule();
    },
  );
  for (const type of ['onEnabled', 'onDisabled', 'onInstalled', 'onUninstalled']) {
    listen(
      () => api?.management?.[type],
      (addon) => {
        if (addon.type === 'theme') schedule();
      },
    );
  }
  const changed = () => onChange();
  media?.addEventListener('change', changed);
  schedule();
  return {
    get snapshot() {
      return snapshot;
    },

    get dark() {
      return media?.matches === true;
    },

    dispose() {
      disposed = true;
      generation++;
      for (const remove of removers) remove();
      media?.removeEventListener('change', changed);
    },
  };
}
