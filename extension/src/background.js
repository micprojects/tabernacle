import { createController } from './controller.js';

let notificationTimer;
let pendingWindows = new Set();
let allWindows = false;
let latestRevision = 0;
let generation;

const notify = ({ windowId, revision, generation: nextGeneration } = {}) => {
  generation = nextGeneration ?? generation;
  if (windowId == null) allWindows = true;
  else pendingWindows.add(windowId);
  latestRevision = Math.max(latestRevision, revision || 0);
  // Coalesce bursts without postponing delivery indefinitely during navigation.
  if (notificationTimer) return;
  notificationTimer = setTimeout(() => {
    const message = {
      type: 'tabernacle:changed',
      windowIds: allWindows ? null : [...pendingWindows],
      revision: latestRevision,
      generation,
    };
    notificationTimer = null;
    pendingWindows.clear();
    allWindows = false;
    browser.runtime.sendMessage(message).catch(() => {});
  }, 16);
};

const controller = createController(browser, notify);

// Register listeners synchronously so Manifest V3 can wake this event page.
browser.runtime.onMessage.addListener((message, sender) => {
  if (
    sender.id !== browser.runtime.id ||
    typeof message?.type !== 'string' ||
    !message.type.startsWith('tabernacle:')
  )
    return undefined;
  if (message.type === 'tabernacle:changed') return undefined;
  return controller.request({ ...message, type: message.type.slice('tabernacle:'.length) }).then(
    (data) => ({ ok: true, data }),
    (error) => ({ ok: false, error: error.message }),
  );
});
browser.tabs.onCreated.addListener((tab) =>
  controller.created(tab).catch((error) => {
    console.warn('Tabernacle could not assign a new tab:', error.message);
    notify();
  }),
);
// The controller's cache registers tab, session and container listeners before
// its first await and publishes only changes relevant to a sidebar.
browser.action.onClicked.addListener(() => browser.sidebarAction.toggle());

// Wake once at browser startup, and also recover whenever this event page loads.
const start = () =>
  controller.start().catch((error) => {
    console.warn('Tabernacle could not initialize:', error.message);
    notify();
  });
browser.runtime.onStartup?.addListener(start);
start();
