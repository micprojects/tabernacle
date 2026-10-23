import { requireLook } from '../look.js';
import { requireNewTab } from '../new-tab/preferences.js';

// Called only inside the controller's request queue. Commits and publication remain there.
export function createPreferenceActions({ api, getModel, changeModel }) {
  async function setLook(value, partial) {
    const look = requireLook(partial ? { ...getModel().look, ...value } : value);
    await changeModel((next) => {
      next.look = look;
    });
  }

  async function setNewTab(value) {
    const preference = requireNewTab({ ...getModel().newTab, ...value });
    await changeModel((next) => {
      next.newTab = preference;
    });
  }

  async function previewNewTab(value, windowId) {
    const preference = requireNewTab({ ...getModel().newTab, ...value });
    const token = crypto.randomUUID();
    const key = `tabernacle.newTabPreview.${token}`;
    await api.storage.session.set({ [key]: preference });
    try {
      const tab = await api.tabs.create({
        windowId,
        url: api.runtime.getURL(`new-tab.html?preview=${token}`),
        active: true,
      });
      return tab;
    } catch (error) {
      await api.storage.session.remove(key);
      throw error;
    }
  }

  return { setLook, setNewTab, previewNewTab };
}
