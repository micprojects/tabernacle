import { normalizeNewTab, requireNewTab, linkUrl } from './new-tab-preferences.js';
import { WEATHER_ACCESS } from './new-tab-weather.js';
import { icon } from './icons.js';

export function createNewTabSettings({ request, demo }) {
  const $ = (id) => document.getElementById(id);
  const form = $('new-tab-form');
  const fields = form.elements;
  const dirty = new Set();
  let saved,
    draft,
    saving = false,
    disposed = false,
    editing,
    trigger,
    dragging;
  let locationGeneration = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function errorAt(id, err) {
    $(id).textContent = err?.message || '';
    $(id).hidden = !err;
  }

  function status() {
    $('new-tab-save').disabled = saving || !saved || !dirty.size;
    $('new-tab-discard').disabled = saving || !saved || !dirty.size;
    $('new-tab-preview').disabled = saving || !saved;
    $('new-tab-fields').disabled = saving || !saved;
    $('new-tab-status').textContent = saving
      ? 'Saving…'
      : dirty.size
        ? 'Unsaved changes'
        : 'All changes saved';
  }

  function change(key, value) {
    draft[key] = value;
    if (JSON.stringify(saved[key]) === JSON.stringify(value)) dirty.delete(key);
    else dirty.add(key);
    errorAt('new-tab-error');
    status();
  }

  function move(id, beforeId) {
    const links = [...draft.links];
    const index = links.findIndex((link) => link.id === id);
    if (index < 0 || id === beforeId) return;
    const [link] = links.splice(index, 1);
    const target =
      beforeId == null ? links.length : links.findIndex((item) => item.id === beforeId);
    if (target < 0) return;
    links.splice(target, 0, link);
    change('links', links);
    renderLinks();
  }

  function control(label, symbol, action, disabled = false) {
    const button = el('button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = disabled;
    button.append(icon(symbol));
    button.addEventListener('click', action);
    return button;
  }

  function renderLinks() {
    const focused = document.activeElement?.getAttribute('aria-label');
    const list = $('new-tab-links');
    list.replaceChildren();
    for (const [index, link] of draft.links.entries()) {
      const row = el('div', 'nt-link-row');
      row.draggable = true;
      const handle = el('span', 'nt-drag', '⠿');
      handle.setAttribute('aria-hidden', 'true');
      const copy = el('span', 'nt-link-copy');
      copy.append(el('strong', '', link.name), el('small', '', new URL(link.url).hostname));
      const controls = el('div', 'nt-link-controls');
      controls.append(
        control(
          `Move ${link.name} up`,
          'back',
          () => move(link.id, draft.links[index - 1]?.id),
          index === 0,
        ),
        control(
          `Move ${link.name} down`,
          'enter',
          () => move(link.id, draft.links[index + 2]?.id ?? null),
          index === draft.links.length - 1,
        ),
        control(`Edit ${link.name}`, 'rename', (event) => editLink(link, event.currentTarget)),
        control(`Remove ${link.name}`, 'trash', () => {
          change(
            'links',
            draft.links.filter((item) => item.id !== link.id),
          );
          renderLinks();
          $('new-tab-add-link').focus();
        }),
      );
      row.append(handle, copy, controls);
      row.addEventListener('dragstart', (event) => {
        dragging = link.id;
        event.dataTransfer.setData('text/plain', link.id);
        event.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (event) => {
        if (dragging) {
          event.preventDefault();
          row.classList.add('drag-over');
        }
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        row.classList.remove('drag-over');
        if (dragging) move(dragging, link.id);
        dragging = null;
      });
      row.addEventListener('dragend', () => {
        dragging = null;
        for (const node of list.children) node.classList.remove('drag-over');
      });
      list.append(row);
    }
    if (!draft.links.length)
      list.append(el('p', 'nt-empty', 'Add the websites you want close at hand.'));
    $('new-tab-add-link').disabled = draft.links.length >= 60;
    if (focused)
      [...list.querySelectorAll('button')]
        .find((node) => node.getAttribute('aria-label') === focused && !node.disabled)
        ?.focus();
  }

  function render() {
    if (!draft) return;
    for (const [key, value] of Object.entries(draft)) {
      const field = fields.namedItem(key);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = value;
      else field.value = value;
    }
    $('nt-location-selected').textContent = draft.location
      ? `Selected: ${draft.location.name}`
      : 'No location selected.';
    renderLinks();
    status();
  }

  function accept(value) {
    saved = normalizeNewTab(value);
    draft ??= structuredClone(saved);
    for (const [key, value] of Object.entries(saved)) {
      if (!dirty.has(key)) draft[key] = structuredClone(value);
      else if (JSON.stringify(draft[key]) === JSON.stringify(value)) dirty.delete(key);
    }
    render();
  }

  function closeEditor() {
    $('new-tab-link-editor').close();
    if (trigger?.isConnected) trigger.focus();
    else $('new-tab-add-link').focus();
  }

  function editLink(link, source) {
    editing = link?.id;
    trigger = source;
    $('nt-editor-title').textContent = link ? 'Edit link' : 'Add link';
    $('nt-link-submit').textContent = link ? 'Update link' : 'Add link';
    $('nt-link-name').value = link?.name || '';
    $('nt-link-url').value = link?.url || '';
    errorAt('nt-link-error');
    $('new-tab-link-editor').showModal();
    $('nt-link-name').focus();
  }

  form.addEventListener('change', (event) => {
    const field = event.target;
    if (!saved || !Object.hasOwn(draft, field.name)) return;
    change(field.name, field.type === 'checkbox' ? field.checked : field.value);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || !dirty.size) return;
    saving = true;
    status();
    errorAt('new-tab-error');
    try {
      requireNewTab(draft);
      if (draft.weatherEnabled && !demo && !(await browser.permissions.contains(WEATHER_ACCESS)))
        throw new Error('Use Find location to allow weather access first.');
      const value = Object.fromEntries([...dirty].map((key) => [key, draft[key]]));
      const result = await request('setNewTab', { value });
      if (!disposed) accept(result.newTab);
    } catch (error) {
      if (!disposed) errorAt('new-tab-error', error);
    } finally {
      saving = false;
      if (!disposed) status();
    }
  });
  $('new-tab-discard').addEventListener('click', () => {
    dirty.clear();
    draft = structuredClone(saved);
    errorAt('new-tab-error');
    render();
  });
  $('new-tab-add-link').addEventListener('click', (event) => editLink(null, event.currentTarget));
  $('nt-link-cancel').addEventListener('click', closeEditor);
  $('new-tab-link-editor').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeEditor();
  });
  $('new-tab-link-form').addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const name = $('nt-link-name').value.trim();
      if (!name || name.length > 80)
        throw new Error('Give your link a name of up to 80 characters.');
      const link = {
        id: editing || crypto.randomUUID(),
        name,
        url: linkUrl($('nt-link-url').value),
      };
      if (editing && !draft.links.some((item) => item.id === editing))
        throw new Error('This link was removed elsewhere. Close this editor and add it again.');
      const links = editing
        ? draft.links.map((item) => (item.id === editing ? link : item))
        : [...draft.links, link];
      if (links.length > 60) throw new Error('You can add up to 60 links.');
      change('links', links);
      renderLinks();
      closeEditor();
    } catch (error) {
      errorAt('nt-link-error', error);
    }
  });
  $('new-tab-preview').addEventListener('click', async () => {
    errorAt('new-tab-error');
    try {
      const value = requireNewTab(draft);
      if (demo) {
        sessionStorage.setItem('tabernacle.newTabPreview', JSON.stringify(value));
        window.open(new URL('../new-tab.html?demo&preview=1', import.meta.url), '_blank');
      } else await request('previewNewTab', { value });
    } catch (error) {
      errorAt('new-tab-error', error);
    }
  });
  $('nt-location-query').addEventListener('input', () => {
    locationGeneration++;
    $('nt-location-results').replaceChildren();
    $('nt-location-status').textContent = '';
    $('nt-find-location').disabled = false;
  });
  $('nt-location-query').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('nt-find-location').click();
    }
  });
  $('nt-find-location').addEventListener('click', async () => {
    const generation = ++locationGeneration;
    errorAt('nt-weather-error');
    $('nt-location-results').replaceChildren();
    $('nt-location-status').textContent = '';
    const query = $('nt-location-query').value.trim();
    if (query.length < 2) {
      errorAt('nt-weather-error', new Error('Enter at least two characters.'));
      return;
    }
    try {
      if (demo) throw new Error('Install Tabernacle in Firefox to set up weather.');
      // Request from this click, before any await, so Firefox can show consent.
      const permission = browser.permissions.request(WEATHER_ACCESS);
      $('nt-find-location').disabled = true;
      if (!(await permission))
        throw new Error(
          'Weather access was not allowed. You can keep using the page without weather.',
        );
      $('nt-location-status').textContent = 'Finding locations…';
      const results = await request('weatherLocations', { query });
      if (disposed || generation !== locationGeneration) return;
      $('nt-location-status').textContent = results.length
        ? 'Choose a location:'
        : 'No matching locations. Try a nearby town or city.';
      for (const location of results) {
        const button = el('button', '', location.name);
        button.type = 'button';
        button.addEventListener('click', () => {
          change('location', location);
          $('nt-location-results').replaceChildren();
          $('nt-location-status').textContent = 'Location selected. Save changes to use it.';
          render();
        });
        $('nt-location-results').append(button);
      }
    } catch (error) {
      if (!disposed && generation === locationGeneration) {
        $('nt-location-status').textContent = '';
        errorAt('nt-weather-error', error);
      }
    } finally {
      if (!disposed && generation === locationGeneration) $('nt-find-location').disabled = false;
    }
  });
  $('nt-remove-weather').addEventListener('click', async () => {
    errorAt('nt-weather-error');
    try {
      if (demo) throw new Error('Weather access is managed in Firefox.');
      await browser.permissions.remove(WEATHER_ACCESS);
      const result = await request('setNewTab', { value: { weatherEnabled: false } });
      change('weatherEnabled', false);
      accept(result.newTab);
      $('nt-location-status').textContent = 'Weather access removed.';
    } catch (error) {
      errorAt('nt-weather-error', error);
    }
  });

  return {
    accept,
    isBusy: () => dirty.size > 0 || saving || $('new-tab-link-editor').open,

    dispose() {
      disposed = true;
      locationGeneration++;
    },
  };
}
