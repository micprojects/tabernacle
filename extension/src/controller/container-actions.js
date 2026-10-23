import { containerChoices, containerDetails } from '../containers.js';

// The controller serialises calls and owns cache invalidation and notifications.
export function createContainerActions({ api, list, invalidate }) {
  async function choices() {
    await list();
    return containerChoices(api);
  }

  async function create(message) {
    await list();
    const details = await containerDetails(api, message);
    const identity = await api.contextualIdentities.create(details);
    invalidate();
    return identity;
  }

  async function requireExisting(cookieStoreId) {
    if (!(await list()).some((item) => item.cookieStoreId === cookieStoreId))
      throw new Error('That container no longer exists. Reopen Manage containers.');
  }

  async function update(message) {
    await requireExisting(message.cookieStoreId);
    const details = await containerDetails(api, message);
    await api.contextualIdentities.update(message.cookieStoreId, details);
    invalidate();
  }

  async function remove(cookieStoreId) {
    await requireExisting(cookieStoreId);
    // Check every window immediately before deletion; never close tabs implicitly.
    if ((await api.tabs.query({})).some((tab) => tab.cookieStoreId === cookieStoreId))
      throw new Error('Close this container’s tabs in all Firefox windows before removing it.');
    await api.contextualIdentities.remove(cookieStoreId);
    invalidate();
  }

  return { list, choices, create, update, remove };
}
