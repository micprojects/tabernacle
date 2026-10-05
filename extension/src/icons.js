// Official Acorn desktop assets, plus the documented folder and badge adaptations.
// See ../icons/ui/NOTICE.txt for source revision, licensing and native sizes.
const assets = {
  home: 'home-16',
  group: 'folder-16',
  groupPlus: 'folder-add-16',
  chevron: 'chevron-right-12',
  back: 'back-16',
  undo: 'arrow-counterclockwise-16',
  history: 'restore-16',
  plus: 'add-16',
  close: 'close-16',
  closeSmall: 'close-12',
  search: 'search-16',
  searchLarge: 'search-20',
  more: 'page-actions-16',
  info: 'information-16',
  enter: 'forward-16',
  keyboard: 'keyboard-16',
  globe: 'globe-16',
  pin: 'pin-16',
  speaker: 'audio-16',
  speakerSmall: 'audio-12',
  muted: 'audio-muted-16',
  mutedSmall: 'audio-muted-12',
  rename: 'edit-16',
  trash: 'delete-16',
  copy: 'copy-16',
  container: 'identity-16',
  expand: 'expand-all-16',
  collapse: 'collapse-all-16',
  check: 'checkmark-16',
  list: 'list-16',
  addCircle: 'add-circle-12',
  subtractCircle: 'subtract-circle-12',
};
const sprite = new URL('../icons/ui/acorn.svg', import.meta.url).href;

export function icon(name, className = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const asset = assets[name] ?? assets.globe;
  const size = asset.split('-').at(-1);
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.dataset.icon = asset;
  if (className) svg.setAttribute('class', className);
  if (name === 'group') svg.classList.add('folder-icon');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `${sprite}#${asset}`);
  svg.append(use);
  return svg;
}
