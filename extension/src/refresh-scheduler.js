// Coalesce notifications without postponing them during a continuous event stream.
// Views supply their own state and pause rules; no browser or DOM globals are needed.
export function createRefreshScheduler({
  refresh,
  getState = () => undefined,
  getWindowId = () => undefined,
  globalOnly = false,
  canRefresh = () => true,
  delay = 16,
  onError = (error) => console.error(error),
}) {
  let pending, timer, running;
  let forced = false;
  let disposed = false;

  function needed() {
    if (forced) return true;
    if (!pending) return false;
    const state = getState();
    return (
      (pending.generation && pending.generation !== state?.generation) ||
      !Number.isFinite(pending.revision) ||
      pending.revision > (state?.revision ?? -1)
    );
  }

  function resume() {
    if (disposed || timer || running || !canRefresh() || !needed()) return;
    timer = setTimeout(() => {
      timer = undefined;
      run().catch(onError);
    }, delay);
  }

  async function run() {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || !canRefresh() || !needed()) return;
    if (running) return running;
    pending = undefined;
    forced = false;
    // Assign the in-flight promise before invoking the view: it may notify synchronously.
    running = Promise.resolve().then(refresh);
    try {
      return await running;
    } finally {
      running = undefined;
      resume();
    }
  }

  function schedule(change) {
    if (disposed) return;
    const windows = change?.windowIds ?? (change?.windowId != null ? [change.windowId] : null);
    if (windows && (globalOnly || !windows.includes(getWindowId()))) return;
    if (!change) forced = true;
    else if (!pending || pending.generation !== change.generation) pending = { ...change };
    else if (!Number.isFinite(change.revision) || !Number.isFinite(pending.revision))
      pending = { ...change, revision: undefined };
    else pending.revision = Math.max(pending.revision, change.revision);
    resume();
  }

  return {
    schedule,
    resume,

    now() {
      forced = true;
      return run();
    },

    dispose() {
      disposed = true;
      clearTimeout(timer);
      pending = undefined;
      forced = false;
    },
  };
}
