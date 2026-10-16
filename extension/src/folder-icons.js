import { icon, svgIcon } from './icons.js';
import { containerIconUrl } from './containers.js';
import { folderAppearance } from './folder-appearance.js';
import { groupContainer } from './model.js';
import { appearanceColor } from './appearance-colors.js';

const sprite = new URL('../icons/ui/folder-icons.svg', import.meta.url).href;

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

// Share the rendered shade with folder guides and new-tab controls.
export function folderIconColor(color) {
  return color && CSS.supports('color', color) ? appearanceColor(color, true) || color : null;
}

export function folderIcon(
  group,
  container,
  {
    expanded = false,
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
  } else glyph = icon(expanded ? 'groupOpen' : 'group');
  glyph.classList.add('folder-glyph');
  if (className) glyph.classList.add(className);
  const color = folderIconColor(appearance.color);
  if (color) {
    glyph.style.color = color;
    glyph.style.setProperty('--folder-color', color);
  }
  return glyph;
}
