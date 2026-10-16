import { createDemo } from './demo.js';

// The preview's settings tab shares the sidebar's in-memory controller.
// This module is never loaded by the installed extension.
export async function connectDemo(onChange, readCloseFilter) {
  let session;
  try {
    session = window.opener?.tabernacleDemoSession;
  } catch {
    /* Unrelated opener. */
  }
  session ||= window.tabernacleDemoSession;
  if (!session) {
    const listeners = new Set();
    session = {
      listeners,
    };
    session.ready = createDemo(
      (notice) => {
        for (const listener of listeners) listener(notice);
      },
      () => session.readCloseFilter?.(),
    );
  }
  if (readCloseFilter) session.readCloseFilter = readCloseFilter;
  window.tabernacleDemoSession = session;
  session.listeners.add(onChange);
  window.addEventListener(
    'pagehide',
    () => {
      session.listeners.delete(onChange);
      if (readCloseFilter && session.readCloseFilter === readCloseFilter)
        delete session.readCloseFilter;
    },
    { once: true },
  );
  return session.ready;
}
