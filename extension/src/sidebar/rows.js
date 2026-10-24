import { viewedAge } from '../tab-collection.js';
import { icon } from '../icons.js';
import {
  createRowCache,
  reconcileChildren,
  reconcileRetainedChildren,
  setAttribute,
} from '../dom.js';
import { guideColors } from '../appearance-colors.js';
import { folderIcon, folderIconColor } from '../folder-icons.js';
import { pinActionLabels } from '../pinned-items.js';

// One instance belongs to one sidebar document. The entry point owns application state.
export function createSidebarRows({
  tree,
  getIndex,
  getProjection,
  faviconTint,
  labelColors,
  getDomainFilter,
  getDomainSort,
  getWindowFocused,
  setWindowFocusedAt,
  canToggleTabChildren,
  getAudioInTabs,
  getAudioInGroups,
  treeMotion,
  getState,
  getSelected,
  demo,
  el,
  button,
  action,
  getLastGroupClick,
  setLastGroupClick,
  setHandledGroupDoubleClick,
  getHandledGroupDoubleClick,
  cancelGroupClick,
  clickGroup,
  enter,
  revealFolder,
  parent,
  count,
  selectRow,
  closeTab,
  activateTab,
  getTreeRenderer,
  moveTreeFocus,
  rowKey,
  blankAreaAction,
  newTabMenu,
  blankAreaMenu,
  isBlankArea,
  contextMenu,
  dropTarget,
}) {
  // Keep the previous 96-view dormant budget shared between identity caching
  // and cross-identity reuse. Mounted and interaction-owned rows remain separate.
  const pooledLeafLimit = 64;

  const virtualDormantLimit = 96;

  const rowCache = createRowCache({
    retain: () => (getTreeRenderer().virtual ? virtualDormantLimit - leafPool.length : 2048),
    owned: (node) => treeMotion.owns(node),
  });

  const wrappers = new Map();

  const leafPool = [];

  const pooledLeafParts = new WeakMap();

  const usedWrappers = new Set();

  const guideColorsApplied = new WeakMap();

  function wrapperFor(kind, id, needsBranch = true, recyclable = false) {
    const key = `${kind}:${id}`;
    usedWrappers.add(key);
    if (!wrappers.has(key)) {
      const recycled = recyclable && !rowCache.has(key) && leafPool.pop();
      if (recycled) {
        wrappers.set(key, recycled.wrapper);
        rowCache.adopt(key, recycled.entry);
      } else {
        const node = el('div', `${kind}-node`);
        node.setAttribute('role', 'none');
        wrappers.set(key, { node });
      }
    }
    const wrapper = wrappers.get(key);
    if (needsBranch && !wrapper.branch) {
      wrapper.branch = el('div', kind === 'group' ? 'branch' : 'tab-branch');
      wrapper.branch.setAttribute('role', 'group');
    }
    return wrapper;
  }

  // Release only departing, unowned leaf views before assigning entering rows.
  // Overlapping keys retain their existing controls and loaded favicon.
  function prepareViewportRows(rows, pins, owners) {
    const keep = new Set([
      ...rows.map(({ row }) => row.key),
      ...pins.map((row) => (row.kind === 'pin-tab' ? `pin:${row.id}` : row.key)),
      // A removed tab may still own a press or menu. Detach its view normally,
      // but never assign those outstanding controls to another logical tab.
      ...owners,
    ]);
    wrappers.forEach((wrapper, key) => {
      if (leafPool.length >= pooledLeafLimit || keep.has(key) || wrapper.branch) return;
      const row = wrapper.node.firstElementChild;
      if (!pooledLeafParts.has(row) || wrapper.node.contains(document.activeElement)) return;
      if (
        treeMotion.owns(wrapper.node) ||
        wrapper.node.querySelector(
          '.dragging, .drop-before, .drop-after, .drop-inside, .drop-invalid, .move-complete, [data-tree-motion]',
        )
      )
        return;
      const entry = rowCache.take(key);
      if (!entry) return;
      wrapper.node.remove();
      wrappers.delete(key);
      leafPool.push({ wrapper, entry });
    });
  }

  function reconcileTreeChildren(parent, children) {
    (getTreeRenderer().virtual ? reconcileRetainedChildren : reconcileChildren)(parent, children);
  }

  function markSelected(row) {
    row.classList.toggle('selected', getSelected() === row.dataset.key);
    return row;
  }

  // Cancel on the second press, before its release can outlast the grace period.
  // Keep the native click count and original target even if scrolling moves it.
  tree.addEventListener(
    'mousedown',
    (event) => {
      if (event.button === 0 && event.detail === 2 && getLastGroupClick()) cancelGroupClick();
    },
    true,
  );

  tree.addEventListener(
    'click',
    (event) => {
      if (event.detail < 2) {
        setLastGroupClick(null);
        setHandledGroupDoubleClick(false);
      } else if (event.detail === 2 && getLastGroupClick()) {
        event.stopImmediatePropagation();
        setHandledGroupDoubleClick(true);
        enter(getLastGroupClick().id, getLastGroupClick().collapsed);
        setLastGroupClick(null);
      }
    },
    true,
  );

  tree.addEventListener(
    'dblclick',
    (event) => {
      if (getHandledGroupDoubleClick()) {
        event.stopImmediatePropagation();
        setHandledGroupDoubleClick(false);
      }
    },
    true,
  );

  const rowTemplates = new Map();

  function rowBase(kind, id) {
    if (!rowTemplates.has(kind)) {
      const template = el('div', `row ${kind}-row`);
      template.dataset.kind = kind;
      template.tabIndex = 0;
      template.setAttribute('role', 'treeitem');
      template.draggable = false;
      rowTemplates.set(kind, template);
    }
    const row = rowTemplates.get(kind).cloneNode(true);
    row.dataset.key = `${kind}:${id}`;
    row.dataset.id = id;
    row.classList.toggle('selected', getSelected() === row.dataset.key);
    dropTarget(row, kind, id);
    return row;
  }

  function rowButton(label, iconName, action, className = 'icon-button') {
    const node = button(label, iconName, null, className);
    node.dataset.rowAction = action;
    return node;
  }

  // Transient press state belongs to the row without retaining a detached subtree.
  const rowPress = new WeakMap();

  function rowTarget(event) {
    const row = event.target.closest('.row');
    if (!row || !tree.contains(row) || row.closest('[inert]') || !getState()) return null;
    const kind = row.dataset.kind;
    const id = kind === 'tab' ? Number(row.dataset.id) : row.dataset.id;
    if (kind !== 'group' && kind !== 'tab') return null;
    return { row, kind, id };
  }

  function currentRow(target) {
    return (
      target &&
      (target.kind === 'tab'
        ? getState().tabs.some((tab) => tab.id === target.id)
        : getState().groups.some((group) => group.id === target.id))
    );
  }

  tree.addEventListener('pointerdown', (event) => {
    const target = rowTarget(event);
    if (!target || target.kind !== 'tab' || event.button !== 0) return;
    if (event.target.closest('button')) rowPress.delete(target.row);
    else rowPress.set(target.row, canToggleTabChildren());
  });

  tree.addEventListener('pointercancel', (event) => {
    const target = rowTarget(event);
    if (target) rowPress.delete(target.row);
  });

  tree.addEventListener('mousedown', (event) => {
    if (event.button === 1 && rowTarget(event)?.kind === 'tab') event.preventDefault();
  });

  tree.addEventListener('auxclick', (event) => {
    const target = rowTarget(event);
    if (event.button !== 1 || target?.kind !== 'tab' || !currentRow(target)) return;
    event.preventDefault();
    event.stopPropagation();
    closeTab(target.id);
  });

  tree.addEventListener('click', (event) => {
    const target = rowTarget(event);
    if (!currentRow(target)) return;
    const { row, kind, id } = target;
    const control = event.target.closest('button');
    if (control) {
      const actionName = control.dataset.rowAction;
      if (!actionName) return;
      event.stopPropagation();
      if (actionName === 'toggle-group' && kind === 'group') {
        selectRow(row);
        clickGroup(id, event);
      } else if (actionName === 'toggle-tab' && kind === 'tab') {
        selectRow(row);
        setWindowFocusedAt(-Infinity);
        action('toggleTab', { id, activate: true });
      } else if (kind === 'tab') {
        if (actionName === 'mute-tab') action('muteTab', { id });
        else if (actionName === 'close-tab') closeTab(id);
      }
      return;
    }
    selectRow(row);
    if (kind === 'group') {
      if (event.detail < 2) clickGroup(id, event);
      return;
    }
    if (getDomainFilter()) {
      rowPress.delete(row);
      activateTab(id);
      return;
    }
    const toggleChildren = (rowPress.get(row) ?? true) && canToggleTabChildren();
    rowPress.delete(row);
    setWindowFocusedAt(-Infinity);
    action('clickTab', { id, toggleChildren }).then((next) => {
      // A focus notification caused by this activation can arrive after click.
      if (next && !toggleChildren && getWindowFocused()) setWindowFocusedAt(-Infinity);
    });
  });

  tree.addEventListener('contextmenu', (event) => {
    const target = rowTarget(event);
    if (!currentRow(target)) return;
    cancelGroupClick();
    event.preventDefault();
    selectRow(target.row);
    contextMenu(target.kind, target.id, event.clientX, event.clientY);
  });

  tree.addEventListener('keydown', (event) => {
    const target = rowTarget(event);
    if (currentRow(target)) rowKey(event, target.row, target.kind, target.id);
  });

  function playsAudio(tab) {
    return Boolean(tab.audible && !tab.mutedInfo?.muted);
  }

  function childAudioCount(tab) {
    if (getDomainFilter()) return 0;
    return (getAudioInTabs().get(tab.id) || 0) - Number(playsAudio(tab));
  }

  function playingLabel(count, location) {
    return `${count} ${count === 1 ? 'tab' : 'tabs'} playing audio ${location}`;
  }

  function audioDescription(tab) {
    const descriptions = [];
    if (tab.mutedInfo?.muted) descriptions.push('This tab is muted');
    else if (playsAudio(tab)) descriptions.push('This tab is playing audio');
    const children = childAudioCount(tab);
    if (children) descriptions.push(playingLabel(children, 'in this tab’s children'));
    return descriptions.join(' · ');
  }

  function audioIndicator(description, iconName = 'speaker') {
    const marker = el('span', 'audio-indicator');
    marker.title = description;
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', description);
    marker.append(icon(`${iconName}Small`));
    return marker;
  }

  function describeAudio(node, description) {
    if (!description) return;
    if (node.hasAttribute('title')) node.title += `\n${description}`;
    node.setAttribute('aria-label', `${node.getAttribute('aria-label')}, ${description}`);
  }

  function tabLabel(tab) {
    const label = el('span', 'label', tab.title || 'New tab');
    if (!getState().look.domains) return label;
    const copy = el('span', 'row-copy');
    const secondary = el('span', 'row-detail', tabDomain(tab));
    secondary.setAttribute('aria-hidden', 'true');
    copy.append(label, secondary);
    return copy;
  }

  function tabDomain(tab) {
    try {
      return new URL(tab.url).hostname.replace(/^www\./, '') || 'New tab';
    } catch {
      return '';
    }
  }

  function createGroupRow(group, container) {
    const row = rowBase('group', group.id);
    row.setAttribute('aria-label', `${group.name}, ${count(group.id)} tabs`);
    row.title = `${group.name}\nClick to expand/collapse · Double-click to open · Right-click for options`;
    describeContainer(row, { container }, 'Default container');
    const playing = getAudioInGroups().get(group.id) || 0;
    const audio = playingLabel(playing, 'in this folder');
    if (playing) describeAudio(row, audio);
    const disclosure = rowButton(`Expand ${group.name}`, null, 'toggle-group', 'disclosure');
    disclosure.tabIndex = -1;
    const total = el('span', 'group-count', String(count(group.id)));
    total.setAttribute('aria-hidden', 'true');
    row.append(
      disclosure,
      el('span', 'label', group.name),
      ...(playing ? [audioIndicator(audio)] : []),
      total,
      icon('chevron', 'group-chevron'),
    );
    return row;
  }

  function paintGuide(branch, color) {
    const key = color || '';
    if (guideColorsApplied.get(branch) === key) return;
    for (const [i, shade] of guideColors(color).entries()) {
      const property = `--guide-${i + 1}`;
      if (branch.style.getPropertyValue(property) !== shade)
        branch.style.setProperty(property, shade);
    }
    guideColorsApplied.set(branch, key);
  }

  function groupRow(group, expanded) {
    const container = groupContainerDetails(group);
    const { appearance } = getIndex().folders.details.get(group.id);
    const row = markSelected(
      rowCache.get(
        `group:${group.id}`,
        [
          group.name,
          group.appearance?.icon,
          group.defaultCookieStoreId,
          appearance.color,
          count(group.id),
          getAudioInGroups().get(group.id) || 0,
          container?.name,
          container?.colorCode,
          container?.icon,
          container?.iconUrl,
        ],
        () => createGroupRow(group, container),
      ),
    );
    labelColors.apply(row, appearance.color);
    setAttribute(row, 'aria-expanded', expanded);
    const disclosure = row.querySelector('.disclosure');
    const label = `${expanded ? 'Collapse' : 'Expand'} ${group.name}`;
    if (disclosure.getAttribute('aria-expanded') !== String(expanded))
      disclosure.replaceChildren(
        folderIcon(group, container, { className: 'group', expanded, appearance }),
      );
    setAttribute(disclosure, 'aria-expanded', expanded);
    setAttribute(disclosure, 'aria-label', label);
    setAttribute(disclosure, 'title', label);
    return row;
  }

  function groupNode({ group, expanded }, children) {
    const { node, branch } = wrapperFor('group', group.id);
    const { appearance } = getIndex().folders.details.get(group.id);
    const color = folderIconColor(appearance.color) || 'var(--folder-icon)';
    node.style.setProperty('--item-colour', color);
    paintGuide(branch, appearance.color);
    const row = groupRow(group, expanded);
    const showBranch = expanded && (!getProjection().query || children.length > 0);
    treeMotion.reconcile(node, row, branch, showBranch, () => {
      reconcileTreeChildren(branch, children);
      if (!branch.childElementCount) {
        const empty = el('div', 'empty-child', 'Drop tabs here');
        empty.setAttribute('role', 'none');
        dropTarget(empty, 'inside', group.id);
        branch.append(empty);
      }
    });
    return node;
  }

  function fallbackFavicon(node) {
    node.classList.add('tab-globe');
    node.setAttribute('aria-hidden', 'true');
  }

  function hasFavicon(tab) {
    return (
      typeof tab.favIconUrl === 'string' &&
      /^(https?:|data:image\/|moz-extension:)/i.test(tab.favIconUrl)
    );
  }

  function tabFavicon(tab) {
    const favicon = el('span', 'tab-icon');
    const tint = getState().look.tintFavicons && faviconTint(tab.container?.colorCode);
    if (tint) {
      favicon.style.setProperty('--favicon-filter', tint.filter);
      favicon.style.setProperty('--favicon-colour', tint.color);
    }
    // Never fetch a third-party favicon service. Use only Firefox's supplied icon.
    if (hasFavicon(tab)) {
      const img = el('img');
      img.src = tab.favIconUrl;
      img.alt = '';
      img.draggable = false;
      img.referrerPolicy = 'no-referrer';
      img.addEventListener(
        'error',
        () => {
          img.remove();
          fallbackFavicon(favicon);
        },
        { once: true },
      );
      favicon.append(img);
    } else if (demo && tab.title !== 'New tab') {
      favicon.classList.add('tab-fallback');
      favicon.textContent = (tab.title || 'T').charAt(0);
    } else fallbackFavicon(favicon);
    return favicon;
  }

  function groupContainerDetails(group) {
    const { source, container: identity } = getIndex().folders.details.get(group.id);
    if (!source) return null;
    const name =
      source.defaultCookieStoreId === 'firefox-default'
        ? 'No container'
        : identity?.name || 'Unavailable container';
    return {
      name: `${name}${source.id === group.id ? '' : ' (inherited)'}`,
      colorCode: identity?.colorCode,
      icon: identity?.icon,
      iconUrl: identity?.iconUrl,
    };
  }

  function describeContainer(node, { container }, label = 'Container') {
    if (!container) return;
    const name = container.name || 'Unnamed container';
    if (node.hasAttribute('title')) node.title += `\n${label}: ${name}`;
    node.setAttribute(
      'aria-label',
      `${node.getAttribute('aria-label')}, ${label.toLowerCase()}: ${name}`,
    );
  }

  function closeOnMiddleClick(node, id) {
    node.addEventListener('mousedown', (event) => {
      // Stop native autoscroll before it can consume the middle click.
      if (event.button === 1) event.preventDefault();
    });
    node.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      closeTab(id);
    });
  }

  function pinnedDrag(node, item) {
    node.dataset.pinKind = item.kind;
    node.dataset.pinId = item.id;
    node.draggable = false;
  }

  function pinnedMenu(node, kind, id) {
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      node.focus();
      contextMenu(kind, id, event.clientX, event.clientY);
    });
    node.addEventListener('keydown', (event) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        const rect = node.getBoundingClientRect();
        contextMenu(kind, id, rect.left, rect.bottom);
      }
    });
  }

  function createPinnedTab(tab) {
    const label = `${tab.title || 'New tab'}, pinned`;
    const node = button(label, null, () => activateTab(tab.id), 'pinned-tab');
    node.dataset.key = `tab:${tab.id}`;
    node.removeAttribute('title');
    node.setAttribute('aria-pressed', String(Boolean(tab.active)));
    node.classList.toggle('active', Boolean(tab.active));
    pinnedDrag(node, { kind: 'tab', id: tab.treeId });
    node.append(tabFavicon(tab));
    describeContainer(node, tab);
    const audio = audioDescription(tab);
    describeAudio(node, audio);
    if (audio)
      node.append(audioIndicator(audio, getAudioInTabs().get(tab.id) ? 'speaker' : 'muted'));
    pinnedMenu(node, 'tab', tab.id);
    closeOnMiddleClick(node, tab.id);
    return node;
  }

  function pinnedFolder(pin) {
    const group = getIndex().groups.get(pin.id);
    const container = groupContainerDetails(group);
    const { appearance } = getIndex().folders.details.get(group.id);
    const path = getIndex()
      .folders.path(group.id)
      .map((item) => item.name)
      .join(' / ');
    const current = group.id === getState().view.scopeId;
    return rowCache.get(
      `pin:group:${group.id}`,
      [
        path,
        pin.action,
        current,
        appearance.icon,
        appearance.color,
        group.defaultCookieStoreId,
        container?.iconUrl,
        container?.icon,
      ],
      () => {
        const node = button(
          `${path}, pinned folder, ${pinActionLabels[pin.action]}`,
          null,
          () => {
            const current = getState().folderPins.find((item) => item.id === group.id);
            if (current) current.action === 'reveal' ? revealFolder(group.id) : enter(group.id);
          },
          'pinned-tab pinned-folder',
        );
        node.title = `${path}\n${pinActionLabels[pin.action]} · Right-click for options`;
        node.dataset.key = `pin:group:${group.id}`;
        node.classList.toggle('active', current);
        if (current) node.setAttribute('aria-current', 'location');
        node.append(folderIcon(group, container, { appearance }));
        pinnedDrag(node, { kind: 'group', id: group.id });
        pinnedMenu(node, 'group', group.id);
        return node;
      },
    );
  }

  function rowValues(tab) {
    return [
      tab.title,
      tab.url,
      tab.favIconUrl,
      tab.active,
      tab.discarded,
      tab.audible,
      tab.mutedInfo?.muted,
      tab.container?.name,
      tab.container?.colorCode,
      getState().look.tintFavicons,
      getAudioInTabs().get(tab.id) || 0,
    ];
  }

  function pinnedTab(tab) {
    return rowCache.get(`pin:${tab.id}`, rowValues(tab), () => createPinnedTab(tab));
  }

  function createTabRow(tab, expanded, stats) {
    const favicon = tabFavicon(tab);
    const row = rowBase('tab', tab.id);
    row.classList.toggle('active', Boolean(tab.active));
    row.classList.toggle('contains-active', !expanded && stats.active);
    row.classList.toggle('discarded', Boolean(tab.discarded));
    row.setAttribute('aria-selected', String(Boolean(tab.active)));
    row.setAttribute('aria-label', tab.title || 'New tab');
    if (getDomainFilter()) {
      const location = tabFolderLabel(tab);
      row.title = `${tab.title || 'New tab'}\n${tab.url}\n${location}`;
      row.setAttribute('aria-description', location);
    }
    describeContainer(row, tab);
    describeAudio(row, audioDescription(tab));
    if (stats.descendants) {
      row.setAttribute('aria-expanded', String(expanded));
      const count = `${stats.descendants} nested ${stats.descendants === 1 ? 'tab' : 'tabs'}`;
      row.setAttribute('aria-label', `${row.getAttribute('aria-label')}, ${count}`);
      const disclosure = rowButton(
        `${expanded ? 'Collapse' : 'Expand'} child tabs of ${tab.title || 'New tab'}`,
        null,
        'toggle-tab',
        'disclosure tab-disclosure',
      );
      disclosure.tabIndex = -1;
      disclosure.setAttribute('aria-expanded', String(expanded));
      const badge = el('span', 'tab-toggle-badge');
      badge.setAttribute('aria-hidden', 'true');
      badge.append(icon(expanded ? 'subtractCircle' : 'addCircle'));
      disclosure.append(favicon, badge);
      row.append(disclosure);
    } else {
      const slot = el('span', 'icon-slot');
      slot.append(favicon);
      row.append(slot);
    }
    row.append(tabLabel(tab));
    if (getDomainFilter() && getDomainSort() === 'least-viewed' && viewedAge(tab.lastAccessed)) {
      const age = `Last viewed ${new Date(tab.lastAccessed).toLocaleString()}`;
      row.title += `\n${age}`;
      row.setAttribute('aria-description', `${row.getAttribute('aria-description')}. ${age}`);
    }
    if (childAudioCount(tab) && !playsAudio(tab))
      row.append(audioIndicator(playingLabel(childAudioCount(tab), 'in this tab’s children')));
    if (tab.audible || tab.mutedInfo?.muted)
      row.append(
        rowButton(
          tab.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab',
          tab.mutedInfo?.muted ? 'mutedSmall' : 'speakerSmall',
          'mute-tab',
          'audio-button',
        ),
      );
    row.append(rowButton(`Close ${tab.title || 'New tab'}`, null, 'close-tab', 'close-tab'));
    return row;
  }

  function canPoolLeaf(tab, stats) {
    return Boolean(
      getTreeRenderer().virtual &&
      !getDomainFilter() &&
      !getState().look.domains &&
      !stats.descendants &&
      !tab.audible &&
      !tab.mutedInfo?.muted &&
      !childAudioCount(tab),
    );
  }

  function updatePooledLeaf(row, tab, expanded, stats) {
    const parts = pooledLeafParts.get(row);
    if (!parts) return false;
    const key = `tab:${tab.id}`;
    const reassigned = row.dataset.key !== key;
    if (reassigned) {
      rowPress.delete(row);
      row.className = 'row tab-row';
      row.dataset.key = key;
      row.dataset.id = tab.id;
      row.dataset.dropId = tab.id;
    }
    const tint = getState().look.tintFavicons ? tab.container?.colorCode || null : null;
    if (
      parts.favIconUrl !== tab.favIconUrl ||
      parts.tint !== tint ||
      (reassigned && hasFavicon(tab) && parts.favicon.classList.contains('tab-globe'))
    ) {
      // Each replaced icon keeps its error callback attached to its own span.
      // A late response cannot mutate the new owner's icon. A failed icon gets
      // a fresh attempt for a new owner, even when its URL is unchanged.
      const favicon = tabFavicon(tab);
      parts.favicon.replaceWith(favicon);
      parts.favicon = favicon;
      parts.faviconText = favicon.firstChild?.nodeType === 3 ? favicon.firstChild : null;
      parts.favIconUrl = tab.favIconUrl;
      parts.tint = tint;
    }
    const title = tab.title || 'New tab';
    const active = Boolean(tab.active);
    const containsActive = Boolean(!expanded && stats.active);
    const discarded = Boolean(tab.discarded);
    if (row.classList.contains('active') !== active) row.classList.toggle('active', active);
    if (row.classList.contains('contains-active') !== containsActive)
      row.classList.toggle('contains-active', containsActive);
    if (row.classList.contains('discarded') !== discarded)
      row.classList.toggle('discarded', discarded);
    setAttribute(row, 'aria-selected', active);
    setAttribute(row, 'aria-label', title);
    describeContainer(row, tab);
    if (parts.label.data !== title) parts.label.data = title;
    setAttribute(parts.close, 'aria-label', `Close ${title}`);
    setAttribute(parts.close, 'title', `Close ${title}`);
    if (demo && !hasFavicon(tab)) {
      const letter = tab.title !== 'New tab';
      const className = `tab-icon ${letter ? 'tab-fallback' : 'tab-globe'}`;
      if (parts.favicon.className !== className) parts.favicon.className = className;
      if (letter) parts.favicon.removeAttribute('aria-hidden');
      else setAttribute(parts.favicon, 'aria-hidden', true);
      if (!parts.faviconText && letter) {
        parts.faviconText = document.createTextNode('');
        parts.favicon.append(parts.faviconText);
      }
      const character = letter ? (tab.title || 'T').charAt(0) : '';
      if (parts.faviconText && parts.faviconText.data !== character)
        parts.faviconText.data = character;
    }
    return true;
  }

  function tabRow(tab, expanded, stats) {
    const recyclable = canPoolLeaf(tab, stats);
    const row = markSelected(
      rowCache.get(
        `tab:${tab.id}`,
        [
          ...rowValues(tab),
          getState().look.domains,
          expanded,
          stats.descendants,
          stats.active,
          getDomainFilter() ? tabFolderLabel(tab) : null,
          getDomainSort() === 'least-viewed' ? viewedAge(tab.lastAccessed) : null,
          getDomainSort() === 'least-viewed' ? tab.lastAccessed : null,
        ],
        () => createTabRow(tab, expanded, stats),
        recyclable
          ? (row) => updatePooledLeaf(row, tab, expanded, stats)
          : (row, previous, next) => patchTabRow(row, tab, expanded, stats, previous, next),
      ),
    );
    if (recyclable && !pooledLeafParts.has(row)) {
      const favicon = row.querySelector('.tab-icon');
      pooledLeafParts.set(row, {
        label: row.querySelector('.label').firstChild,
        close: row.querySelector('.close-tab'),
        favicon,
        faviconText: favicon.firstChild?.nodeType === 3 ? favicon.firstChild : null,
        favIconUrl: tab.favIconUrl,
        tint: getState().look.tintFavicons ? tab.container?.colorCode || null : null,
      });
    } else if (!recyclable) pooledLeafParts.delete(row);
    labelColors.apply(row, tab.container?.colorCode);
    return row;
  }

  function patchTabRow(row, tab, expanded, stats, previous, next) {
    if (getDomainFilter() || previous.length !== next.length) return false;
    // These positions are title, URL, active, discarded, expanded and descendant
    // activation in tabRow's presentation values. Every shape/icon/audio/colour
    // change still uses the established builder and focus-preserving replacement.
    if (
      next.some(
        (value, i) =>
          value !== previous[i] && i !== 0 && i !== 1 && i !== 3 && i !== 4 && i !== 12 && i !== 14,
      )
    )
      return false;
    const title = tab.title || 'New tab';
    row.classList.toggle('active', Boolean(tab.active));
    row.classList.toggle('contains-active', !expanded && stats.active);
    row.classList.toggle('discarded', Boolean(tab.discarded));
    setAttribute(row, 'aria-selected', Boolean(tab.active));
    setAttribute(row, 'aria-label', title);
    describeContainer(row, tab);
    describeAudio(row, audioDescription(tab));
    if (stats.descendants) {
      setAttribute(row, 'aria-expanded', expanded);
      setAttribute(
        row,
        'aria-label',
        `${row.getAttribute('aria-label')}, ${stats.descendants} nested ${stats.descendants === 1 ? 'tab' : 'tabs'}`,
      );
      const disclosure = row.querySelector('.disclosure');
      const label = `${expanded ? 'Collapse' : 'Expand'} child tabs of ${title}`;
      setAttribute(disclosure, 'aria-label', label);
      setAttribute(disclosure, 'title', label);
      if (disclosure.getAttribute('aria-expanded') !== String(expanded)) {
        setAttribute(disclosure, 'aria-expanded', expanded);
        disclosure
          .querySelector('.tab-toggle-badge')
          .replaceChildren(icon(expanded ? 'subtractCircle' : 'addCircle'));
      }
    }
    const label = row.querySelector('.label');
    if (label.textContent !== title) label.textContent = title;
    const detail = row.querySelector('.row-detail');
    if (detail && detail.textContent !== tabDomain(tab)) detail.textContent = tabDomain(tab);
    const close = row.querySelector('.close-tab');
    setAttribute(close, 'aria-label', `Close ${title}`);
    setAttribute(close, 'title', `Close ${title}`);
    // Demo letter icons depend on the title; native supplied images keep their
    // existing load/error lifecycle when only a title or activation changes.
    if (demo && !hasFavicon(tab) && previous[0] !== next[0])
      row.querySelector('.tab-icon').replaceWith(tabFavicon(tab));
    return true;
  }

  function tabFolderLabel(tab) {
    const path = [
      'Home',
      ...getIndex()
        .folders.path(tab.groupId)
        .map((group) => group.name),
    ].join(' / ');
    return `${tab.pinned ? 'Pinned · ' : ''}Folder: ${path}`;
  }

  function tabNode({ tab, stats, expanded }, children) {
    const { node, branch } = wrapperFor(
      'tab',
      tab.id,
      stats.descendants > 0,
      canPoolLeaf(tab, stats),
    );
    // A tab owns its child rail, even when a child uses a different container.
    if (stats.descendants) paintGuide(branch, tab.container?.colorCode);
    node.classList.toggle('tab-parent', stats.descendants > 0);
    const row = tabRow(tab, expanded, stats);
    if (!branch) {
      reconcileTreeChildren(node, [row]);
      return node;
    }
    treeMotion.reconcile(node, row, branch, Boolean(stats.descendants && expanded), () => {
      reconcileTreeChildren(branch, children);
    });
    return node;
  }

  function newTabItem(groupId, parentTab = null) {
    const group = getIndex().groups.get(groupId);
    const folderColor = getIndex().folders.details.get(groupId)?.appearance.color;
    // Creation controls follow the folder, never an individual tab's container.
    const color = folderIconColor(folderColor) || 'var(--folder-icon)';
    const parentTabId = parentTab?.id ?? null;
    const label = parentTab
      ? `New child tab of ${parentTab.title || 'New tab'}`
      : group
        ? `New tab in ${group.name}`
        : 'New tab';
    const key = parentTab ? `new-child-tab:${parentTabId}` : `new-tab:${groupId}`;
    return rowCache.get(key, [label, color], () => {
      const item = el('div', 'new-tab-item');
      item.style.setProperty('--item-colour', color);
      item.setAttribute('role', 'treeitem');
      item.setAttribute('aria-label', label);
      const add = button(
        label,
        null,
        (event) => {
          const result =
            parentTabId !== null
              ? blankAreaAction('newChildTab', { id: parentTabId })
              : blankAreaAction('newTab', { groupId });
          treeMotion.addFeedback(event.currentTarget);
          return result;
        },
        'new-tab-action',
      );
      add.dataset.key = key;
      const slot = el('span', 'icon-slot');
      slot.append(icon('plus'));
      add.append(slot);
      add.addEventListener('contextmenu', (event) => newTabMenu(event, groupId, parentTabId));
      add.addEventListener('keydown', (event) => {
        if (newTabMenu(event, groupId, parentTabId) || moveTreeFocus(event, add)) return;
        if (event.key === 'ArrowLeft' && !event.altKey) {
          event.preventDefault();
          const parentKey = parentTabId !== null ? `tab:${parentTabId}` : `group:${groupId}`;
          getTreeRenderer().ensureVisible(parentKey);
          const parentRow = getTreeRenderer().mount(parentKey);
          if (parentRow) selectRow(parentRow);
          else parent();
        }
      });
      item.append(add);
      dropTarget(item, parentTab ? 'tab' : 'inside', parentTabId ?? groupId);
      return item;
    });
  }

  function finishRows() {
    if (!getTreeRenderer().virtual || getDomainFilter() || getState().look.domains)
      leafPool.length = 0;
    rowCache.finish((key) => {
      if (key.startsWith('pin:group:'))
        return getIndex().groups.has(key.slice('pin:group:'.length));
      const separator = key.indexOf(':');
      const kind = key.slice(0, separator);
      const id = key.slice(separator + 1);
      if (kind === 'tab' || kind === 'pin' || kind === 'new-child-tab')
        return getIndex().byId.has(Number(id));
      return (kind === 'new-tab' && id === 'null') || getIndex().groups.has(id);
    });
    wrappers.forEach((wrapper, key) => {
      if (!usedWrappers.has(key) && !treeMotion.owns(wrapper.node)) wrappers.delete(key);
    });
    usedWrappers.clear();
  }

  tree.addEventListener('dblclick', (event) => {
    if (event.button !== 0 || !isBlankArea(event.target)) return;
    event.preventDefault();
    blankAreaAction('newTab', { groupId: getState().view.scopeId });
  });

  tree.addEventListener('contextmenu', (event) => {
    if (!isBlankArea(event.target)) return;
    event.preventDefault();
    tree.focus({ preventScroll: true });
    blankAreaMenu(event.clientX, event.clientY);
  });

  tree.addEventListener('keydown', (event) => {
    if (event.target !== tree || !getState()) return;
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = tree.getBoundingClientRect();
      blankAreaMenu(rect.left + 12, rect.top + 12);
    }
  });

  function clearRows() {
    rowCache.clear();
    leafPool.length = 0;
    wrappers.clear();
    usedWrappers.clear();
  }

  function detachRows() {
    rowCache.detach();
  }

  function beginRows() {
    rowCache.begin();
  }

  function reuseRow(key) {
    rowCache.reuse(key);
    usedWrappers.add(key);
  }

  function renderRow(row, children) {
    let node;
    let target;
    if (row.kind === 'group') node = groupNode(row, children);
    else if (row.kind === 'new-tab') node = newTabItem(row.groupId, row.parentTab);
    else if (row.kind === 'pin-tab') node = target = pinnedTab(row.tab);
    else if (row.kind === 'pin-group') node = target = pinnedFolder(row.group);
    else if (row.mode === 'tree') node = tabNode(row, children);
    else node = target = tabRow(row.tab, true, row.stats);
    target ||= node.querySelector('.row, .new-tab-action');
    if (!getTreeRenderer().virtual) {
      for (const name of ['aria-level', 'aria-posinset', 'aria-setsize'])
        target.closest('[role="treeitem"]')?.removeAttribute(name);
    }
    return { node, target };
  }

  function patchTab(tab) {
    const renderer = getTreeRenderer();
    if (tab.pinned) {
      renderer.replaceTarget(`tab:${tab.id}`, pinnedTab(tab));
      const row = getProjection()?.materializedByKey.get(`tab:${tab.id}`);
      if (row) row.tab = tab;
    } else {
      const wrapper = wrappers.get(`tab:${tab.id}`);
      if (!wrapper?.node.isConnected) return;
      const stats = getIndex().tabStats.get(tab.id);
      renderer.replaceTarget(`tab:${tab.id}`, tabRow(tab, !tab.collapsed, stats));
      if (wrapper.branch) paintGuide(wrapper.branch, tab.container?.colorCode);
      if (stats.descendants && !tab.collapsed)
        renderer.replaceTarget(
          `new-child-tab:${tab.id}`,
          newTabItem(tab.groupId, tab).querySelector('.new-tab-action'),
        );
    }
  }

  function patchGroup(id) {
    const renderer = getTreeRenderer();
    const row = getProjection()?.materializedByKey.get(`group:${id}`);
    if (row && renderer.target(row.key)?.isConnected)
      renderer.replaceTarget(row.key, groupRow(row.group, row.expanded));
  }

  return {
    prepareViewportRows,
    renderRow,
    patchTab,
    patchGroup,
    reconcileTreeChildren,
    playingLabel,
    audioIndicator,
    tabFavicon,
    groupContainerDetails,
    finishRows,
    clearRows,
    detachRows,
    beginRows,
    reuseRow,
  };
}
