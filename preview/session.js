import { createDemo } from './demo.js';

// The preview's settings tab shares the sidebar's in-memory controller.
// This module is never loaded by the installed extension.
export async function connectDemo(onChange) {
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
      ready: createDemo((notice) => {
        for (const listener of listeners) listener(notice);
      }),
    };
  }
  window.tabernacleDemoSession = session;
  session.listeners.add(onChange);
  window.addEventListener('pagehide', () => session.listeners.delete(onChange), { once: true });
  return session.ready;
}
