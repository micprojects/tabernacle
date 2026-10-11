import { containerChoices, containerDetails } from './containers.js';
import {
  exportFolderBackup,
  parseFolderBackup,
  planFolderImport,
  materializeFolderImport,
} from './folder-backup.js';

export const folderBackupActions = new Set([
  'getFolderBackupState',
  'exportFolders',
  'previewFolderImport',
  'importFolders',
]);

export function createFolderBackupController({
  api,
  getModel,
  changeModel,
  publish,
  invalidateContainers,
}) {
  async function context() {
    let containers = [],
      choices = { colors: [], icons: [] },
      containerError = null;
    try {
      containers = await api.contextualIdentities.query({});
      choices = await containerChoices(api);
    } catch {
      containerError =
        'Container access is unavailable. You can use No container, or enable Firefox containers and preview again.';
    }
    const groups = structuredClone(getModel().groups);
    const identities = containers.map(({ cookieStoreId, name, color, icon }) => ({
      cookieStoreId,
      name,
      color,
      icon,
    }));
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify({ groups, identities, choices, containerError })),
    );
    return {
      groups,
      containers,
      choices,
      containerError,
      fingerprint: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    };
  }

  function preview(backup, destination, current) {
    const plan = planFolderImport(backup, current.groups, destination);
    const token = crypto.randomUUID();
    const result = {
      token,
      fingerprint: current.fingerprint,
      destination: plan.destination,
      createCount: plan.createCount,
      reuseCount: plan.reuseCount,
      rows: plan.rows.map(({ folder, existingId, depth }) => ({
        name: folder.name,
        existingId,
        depth,
      })),
      containers: plan.containers.map((saved) => {
        const matches = saved.unavailable
          ? []
          : current.containers.filter(
              (item) =>
                item.name === saved.name && item.color === saved.color && item.icon === saved.icon,
            );
        return {
          ...saved,
          suggestedStore: matches.length === 1 ? matches[0].cookieStoreId : null,
          canCreate:
            !saved.unavailable &&
            current.choices.colors.some(({ color }) => color === saved.color) &&
            current.choices.icons.some(({ icon }) => icon === saved.icon),
        };
      }),
      groups: current.groups,
      availableContainers: current.containers,
      containerError: current.containerError,
    };
    return result;
  }

  async function commit(message) {
    if (
      typeof message.token !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(message.token) ||
      typeof message.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(message.fingerprint)
    )
      throw new Error('Preview the backup again before importing.');
    // Keep the request in the Settings page, which outlives an idle MV3 background page.
    // Save its receipt with the model so a lost reply cannot duplicate a new destination.
    if (getModel().lastFolderImport?.token === message.token)
      return getModel().lastFolderImport.result;
    const backup = parseFolderBackup(message.backup);
    const current = await context();
    const plan = planFolderImport(backup, current.groups, message.destination);
    if (message.fingerprint !== current.fingerprint)
      return { stale: true, preview: preview(backup, plan.destination, current) };
    const selections = message.containers;
    const mapped = new Map();
    const toCreate = [];
    // Validate all choices before the first Firefox write.
    for (const saved of plan.containers) {
      const selection =
        selections && Object.hasOwn(selections, saved.id) ? selections[saved.id] : null;
      if (selection === 'none') mapped.set(saved.id, 'firefox-default');
      else if (selection === 'create' && !saved.unavailable) {
        toCreate.push({ id: saved.id, details: await containerDetails(api, saved) });
      } else if (current.containers.some((item) => item.cookieStoreId === selection))
        mapped.set(saved.id, selection);
      else
        throw new Error(
          `Choose a container for ${saved.name ? `“${saved.name}”` : 'the unavailable container'}.`,
        );
    }
    const created = [];
    let result;
    try {
      for (const { id, details } of toCreate) {
        const identity = await api.contextualIdentities.create(details);
        created.push(identity);
        mapped.set(id, identity.cookieStoreId);
      }
      // Container edits can happen outside Tabernacle while creation is awaiting Firefox.
      if ([...mapped.values()].some((store) => store !== 'firefox-default')) {
        const live = await api.contextualIdentities.query({});
        for (const store of mapped.values())
          if (store !== 'firefox-default' && !live.some((item) => item.cookieStoreId === store))
            throw new Error('A selected container disappeared. Preview the backup again.');
      }
      const addition = materializeFolderImport(plan, mapped);
      result = {
        stale: false,
        createdFolders: plan.createCount,
        reusedFolders: plan.reuseCount,
        createdDestination: Boolean(plan.destination.newFolderName),
        createdContainers: created.length,
        destinationId: addition.destinationId,
      };
      if (addition.groups.length)
        await changeModel((next) => {
          next.groups.push(...addition.groups);
          next.lastFolderImport = { token: message.token, result };
        });
    } catch (error) {
      const leftovers = [];
      for (const identity of created.reverse()) {
        try {
          const used = (await api.tabs.query({})).some(
            (tab) => tab.cookieStoreId === identity.cookieStoreId,
          );
          if (used) throw new Error('Container is in use.');
          await api.contextualIdentities.remove(identity.cookieStoreId);
        } catch {
          leftovers.push(identity.name);
        }
      }
      throw new Error(
        `${error.message}${leftovers.length ? ` These containers were kept: ${leftovers.join(', ')}. Preview again and choose them before retrying.` : ''}`,
      );
    } finally {
      if (created.length) invalidateContainers();
    }
    publish();
    return result;
  }

  return async (message) => {
    if (message.type === 'importFolders') return commit(message);
    const current = await context();
    if (message.type === 'getFolderBackupState')
      return { groups: current.groups, containers: current.containers };
    if (message.type === 'exportFolders')
      return exportFolderBackup(current.groups, current.containers);
    return preview(parseFolderBackup(message.backup), message.destination, current);
  };
}
