import { SITE_ENHANCEMENTS, siteAccess } from './site-enhancements.js';
import { paintFaviconWash } from './domain-header.js';

export function createSiteEnhancementsSettings({ request, demo, api = globalThis.browser }) {
  const $ = (id) => document.getElementById(id);
  const master = $('site-enhancements-enabled');
  const status = $('site-enhancements-status');
  const error = $('site-enhancements-error');
  const rows = new Map();
  const permissions = api?.permissions;
  const canManage =
    !demo &&
    permissions?.getAll &&
    permissions?.contains &&
    permissions?.request &&
    permissions?.remove;
  let saved,
    saving = false,
    disposed = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showError(value) {
    error.textContent = value?.message || '';
    error.hidden = !value;
  }

  function render() {
    const enabled = saved?.siteEnhancementsEnabled !== false;
    if (!saving) master.checked = enabled;
    master.disabled = !saved || saving;
    for (const [id, row] of rows) {
      if (!saving)
        row.toggle.checked =
          id === 'youtube' ? saved?.youtubeMode !== false : saved?.siteModes?.[id] !== false;
      row.toggle.disabled = !saved || saving || !enabled;
    }
    status.textContent = !saved
      ? 'Loading settings…'
      : saving
        ? 'Saving…'
        : 'Changes apply immediately to every window.';
  }

  async function save(type, args) {
    if (!saved || saving) return;
    saving = true;
    render();
    showError();
    try {
      saved = await request(type, args);
    } catch (error) {
      showError(error);
    } finally {
      saving = false;
      if (!disposed) render();
    }
  }

  master.addEventListener('change', () =>
    save('setSiteEnhancementsEnabled', { enabled: master.checked }),
  );

  async function refreshAccess(row) {
    if (!canManage) return;
    const token = ++row.generation;
    row.accessButton.disabled = true;
    try {
      const access = await siteAccess(permissions, row.site.origins);
      if (disposed || token !== row.generation) return;
      row.access = access;
      row.accessStatus.textContent = access.wider
        ? 'Allowed by wider site access. Manage this in Firefox’s extension permissions.'
        : access.allowed
          ? 'Access allowed.'
          : access.any
            ? 'Access partly allowed.'
            : 'Access not allowed.';
      row.accessButton.textContent = access.any ? 'Revoke access' : 'Allow access';
      row.accessButton.disabled = row.busy || access.wider;
    } catch {
      if (!disposed && token === row.generation)
        row.accessStatus.textContent = 'Could not check access. Reopen this section to try again.';
    }
  }

  async function changeAccess(row) {
    if (!row.access || row.busy || row.access.wider) return;
    row.busy = true;
    row.accessButton.disabled = true;
    row.select.disabled = true;
    showError();
    try {
      // Request directly in the click handler, before any await, to retain
      // Firefox's required user gesture for its permission prompt.
      const result = row.access.any
        ? permissions.remove({ origins: row.access.removable })
        : permissions.request({ origins: row.site.origins });
      if (!(await result))
        throw new Error(
          row.access.any
            ? 'Access could not be revoked. Try again.'
            : 'Access was not granted. You can try again when ready.',
        );
    } catch (error) {
      showError(error);
    } finally {
      row.busy = false;
      row.select.disabled = false;
      await refreshAccess(row);
    }
  }

  for (const enhancement of SITE_ENHANCEMENTS) {
    const row = { site: enhancement.sites[0], generation: 0, busy: false };
    const item = el('div', 'enhancement-item');
    item.dataset.enhancement = enhancement.id;
    const wash = el('canvas', 'domain-wash');
    wash.width = wash.height = 1;
    wash.setAttribute('aria-hidden', 'true');
    const icons = el('span', 'enhancement-icons');
    icons.dataset.count = enhancement.favicons.length;
    icons.setAttribute('aria-hidden', 'true');
    const loaded = new Map();
    for (const [index, file] of enhancement.favicons.entries()) {
      const image = el('img');
      image.alt = '';
      image.draggable = false;
      image.addEventListener(
        'load',
        () => {
          loaded.set(index, image);
          // Sample all logos in grouped enhancements through the same colour
          // extraction used by the domain header.
          const source = el('canvas');
          source.width = 32 * loaded.size;
          source.height = 32;
          const context = source.getContext('2d');
          [...loaded.entries()]
            .sort(([a], [b]) => a - b)
            .forEach(([, image], index) => {
              context.drawImage(image, index * 32, 0, 32, 32);
            });
          paintFaviconWash(source, wash);
        },
        { once: true },
      );
      image.addEventListener(
        'error',
        () => {
          image.hidden = true;
        },
        { once: true },
      );
      image.src = new URL(`../icons/sites/${file}`, import.meta.url).href;
      icons.append(image);
    }
    const label = el('label', 'enhancement-switch');
    const copy = el('span');
    const name = el('strong', '', enhancement.name);
    name.id = `enhancement-${enhancement.id}-name`;
    const description = el('span', 'setting-help', enhancement.description);
    description.id = `enhancement-${enhancement.id}-help`;
    copy.append(name, description);
    row.toggle = el('input');
    row.toggle.type = 'checkbox';
    row.toggle.setAttribute('role', 'switch');
    row.toggle.setAttribute('aria-labelledby', name.id);
    row.toggle.setAttribute('aria-describedby', description.id);
    row.toggle.addEventListener('change', () =>
      save(enhancement.id === 'youtube' ? 'setYouTubeMode' : 'setSiteMode', {
        mode: enhancement.id,
        enabled: row.toggle.checked,
      }),
    );
    label.append(icons, copy, row.toggle);
    const details = el('details', 'enhancement-access');
    const summary = el('summary', '', 'Site data access');
    summary.setAttribute('aria-label', `${enhancement.name} site data access`);
    details.append(
      summary,
      el(
        'p',
        'setting-help',
        `Allow access to read ${enhancement.id === 'youtube' ? 'video details and playback progress' : enhancement.description[0].toLowerCase() + enhancement.description.slice(1, -1)}. Access is shared with other Tabernacle features, including article previews.`,
      ),
    );
    const controls = el('div', 'enhancement-access-controls');
    row.select = el('select');
    row.select.setAttribute('aria-label', `${enhancement.name} site`);
    for (const site of enhancement.sites) {
      const option = el('option', '', site.domain);
      option.value = site.domain;
      row.select.append(option);
    }
    row.select.hidden = enhancement.sites.length === 1;
    row.select.addEventListener('change', () => {
      row.site = enhancement.sites.find((site) => site.domain === row.select.value);
      refreshAccess(row);
    });
    row.accessButton = el('button', 'settings-button', 'Allow access');
    row.accessButton.type = 'button';
    row.accessButton.disabled = true;
    row.accessButton.addEventListener('click', () => changeAccess(row));
    row.accessStatus = el(
      'p',
      'setting-help',
      canManage
        ? 'Checking access…'
        : demo
          ? 'Site access is available when Tabernacle is installed in Firefox.'
          : 'Manage site access in Firefox’s extension permissions.',
    );
    row.accessStatus.setAttribute('role', 'status');
    controls.hidden = !canManage;
    controls.append(row.select, row.accessButton);
    details.append(controls, row.accessStatus);
    details.addEventListener('toggle', () => {
      if (details.open) refreshAccess(row);
    });
    item.append(wash, label, details);
    $('site-enhancements-list').append(item);
    rows.set(enhancement.id, row);
  }

  function refreshPermissions() {
    for (const row of rows.values()) refreshAccess(row);
  }

  permissions?.onAdded?.addListener(refreshPermissions);
  permissions?.onRemoved?.addListener(refreshPermissions);
  render();
  return {
    accept(value) {
      saved = value;
      render();
    },

    refreshPermissions,
    isBusy: () => saving || [...rows.values()].some((row) => row.busy),

    dispose() {
      disposed = true;
      permissions?.onAdded?.removeListener(refreshPermissions);
      permissions?.onRemoved?.removeListener(refreshPermissions);
    },
  };
}
