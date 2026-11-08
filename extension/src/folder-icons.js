import { icon, svgIcon } from './icons.js';
import { containerIconUrl } from './containers.js';
import { folderAppearance } from './folder-appearance.js';
import { groupContainer } from './model.js';
import { appearanceColor } from './appearance-colors.js';

const sprite = new URL('../icons/ui/folder-icons.svg', import.meta.url).href;

let pinnedFolderTemplate;

function pinnedFolderGlyph() {
  if (!pinnedFolderTemplate) {
    const glyph = icon('group');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    // Acorn folder-16 path, MPL-2.0; see ../icons/ui/NOTICE.txt.
    // Dense shelves need no per-icon use shadow tree.
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute(
      'd',
      'M5.309 1c.78 0 1.523.331 2.044.91l.983 1.092a54 54 0 0 1 4.441.21l.746.073.258.04A2.76 2.76 0 0 1 16 6.024v5.949c0 1.4-1.049 2.59-2.454 2.737a53.6 53.6 0 0 1-11.068.003A2.76 2.76 0 0 1 0 11.974V3.75A2.75 2.75 0 0 1 2.75 1zM2.75 2.5c-.69 0-1.25.56-1.25 1.25v8.224c0 .639.49 1.181 1.133 1.248a52 52 0 0 0 10.758-.003 1.246 1.246 0 0 0 1.109-1.245v-5.95a1.26 1.26 0 0 0-1.133-1.247A52 52 0 0 0 8 4.5a.75.75 0 0 1-.558-.248L6.237 2.914A1.25 1.25 0 0 0 5.31 2.5z',
    );
    path.setAttribute('clip-rule', 'evenodd');
    glyph.replaceChildren(path);
    pinnedFolderTemplate = glyph;
  }
  return pinnedFolderTemplate.cloneNode(true);
}

export function folderSymbol(id) {
  return svgIcon(`${id}-16`, sprite);
}

export function folderContainer(state, group) {
  const id = groupContainer(state, group?.id ?? null);
  return state.containers?.find((container) => container.cookieStoreId === id);
}

export function folderContainerIconUrl(group, container) {
  // Container colours inherit, but its icon belongs only to an explicit assignment.
  return group?.defaultCookieStoreId &&
    group.defaultCookieStoreId !== 'firefox-default' &&
    container
    ? containerIconUrl(container)
    : undefined;
}

// Folder icons and new-tab controls share this shade; guides have lighter tones.
export function folderIconColor(color) {
  return color && CSS.supports('color', color) ? appearanceColor(color, true) || color : null;
}

export function folderIcon(
  group,
  container,
  {
    expanded = false,
    pinned = false,
    className = '',
    state,
    appearance = folderAppearance(group, container, state),
  } = {},
) {
  let glyph;
  const url = folderContainerIconUrl(group, container);
  if (appearance.icon && appearance.icon !== 'folder') glyph = folderSymbol(appearance.icon);
  else if (!appearance.icon && url) {
    glyph = document.createElement('span');
    glyph.className =
      'container-list-icon container-list-icon-mask group-container-icon folder-glyph-mask';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.style.maskImage = `url("${url}")`;
  } else glyph = pinned && !expanded ? pinnedFolderGlyph() : icon(expanded ? 'groupOpen' : 'group');
  glyph.classList.add('folder-glyph');
  if (className) glyph.classList.add(className);
  const color = folderIconColor(appearance.color);
  if (color) {
    glyph.style.color = color;
    glyph.style.setProperty('--folder-color', color);
  }
  return glyph;
}
