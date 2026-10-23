import { createController } from './controller.js';
import { createSnapshotEncoder } from './snapshot-transfer.js';
import { createNewTabRouting } from './new-tab-routing.js';
import { createWeatherService } from './new-tab-weather.js';

const weather = createWeatherService(browser);

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
createNewTabRouting(browser);
const snapshots = createSnapshotEncoder();
browser.windows.onRemoved.addListener(snapshots.forget);

// Register listeners synchronously so Manifest V3 can wake this event page.
browser.runtime.onMessage.addListener((message, sender) => {
  if (
    sender.id !== browser.runtime.id ||
    typeof message?.type !== 'string' ||
    !message.type.startsWith('tabernacle:')
  )
    return undefined;
  if (
    ['tabernacle:changed', 'tabernacle:getCloseFilter', 'tabernacle:showSettingsSection'].includes(
      message.type,
    )
  )
    return undefined;
  if (['tabernacle:weatherLocations', 'tabernacle:weatherCurrent'].includes(message.type)) {
    const work =
      message.type === 'tabernacle:weatherLocations'
        ? weather.locations(message.query)
        : weather.current();
    return work.then(
      (data) => ({ ok: true, data }),
      (error) => ({ ok: false, error: error.message }),
    );
  }
  return controller
    .requestForTransport({ ...message, type: message.type.slice('tabernacle:'.length) })
    .then(
      (data) => ({
        ok: true,
        data:
          (['tabernacle:snapshot', 'tabernacle:getNewTabState'].includes(message.type) &&
            (message.incremental === true || message.incremental === 1)) ||
          (message.incremental === 2 &&
            Array.isArray(data?.tabs) &&
            Array.isArray(data.groups) &&
            typeof data.generation === 'string' &&
            data.view)
            ? snapshots.encode(
                message.windowId,
                data,
                message.snapshotToken,
                message.incremental === 2 ? 2 : 1,
              )
            : data,
      }),
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
