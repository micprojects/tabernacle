import { MODEL_KEY, validGroups } from './model.js';
import { deserializeModel } from './persistence.js';

// A rejected model-write reply may follow a durable commit. Remove a newly
// created container only after saved folders and live tabs confirm it is unused.
export async function removeUnusedCreatedContainer(api, cookieStoreId) {
  const saved = deserializeModel((await api.storage.local.get(MODEL_KEY))[MODEL_KEY]);
  if (saved !== undefined && (saved?.version !== 1 || !validGroups(saved.groups)))
    throw new Error('Saved folder state is unavailable.');
  if (
    saved?.groups.some((group) => group.defaultCookieStoreId === cookieStoreId) ||
    (await api.tabs.query({})).some((tab) => tab.cookieStoreId === cookieStoreId)
  )
    throw new Error('The new container is already in use.');
  await api.contextualIdentities.remove(cookieStoreId);
}
