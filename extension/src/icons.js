const paths = {
  home: ['m3 10 9-7 9 7', 'M5 9v12h5v-7h4v7h5V9'],
  group: [
    'M2.5 9V5.5a2 2 0 0 1 2-2h4.7a2 2 0 0 1 1.5.7L13 7h6.5a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2Z',
    'M4.5 8h15a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z',
  ],
  groupPlus: [
    'M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v5M3 8h18M3 7v12a2 2 0 0 0 2 2h8',
    'M18 15v8m-4-4h8',
  ],
  chevron: ['m9 6 6 6-6 6'],
  back: ['m12 5-7 7 7 7', 'M5 12h15'],
  undo: ['M3 4v6h6', 'M3 10a9 9 0 1 1 2 9'],
  history: ['M3 4v6h6', 'M3 10a9 9 0 1 1 2 9', 'M12 7v5l3 2'],
  plus: ['M12 4v16M4 12h16'],
  close: ['m6 6 12 12M6 18 18 6'],
  search: ['M20 20l-5-5', 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14'],
  more: ['M5 12h.01M12 12h.01M19 12h.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18', 'M12 11v6M12 7h.01'],
  enter: ['M5 12h14m-6-6 6 6-6 6'],
  keyboard: [
    'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
    'M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10',
  ],
  globe: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
    'M3 12h18M12 3a17 17 0 0 0 0 18 17 17 0 0 0 0-18',
  ],
  pin: ['m8 3 8 0-1 6 3 4v2H6v-2l3-4-1-6', 'M12 15v7'],
  speaker: ['M11 4 5 9H2v6h3l6 5V4Z', 'M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14'],
  muted: ['M11 4 5 9H2v6h3l6 5V4Z', 'm16 9 5 6m-5 0 5-6'],
  rename: ['m4 16 12-12 4 4L8 20H4v-4Z', 'm13 7 4 4'],
  trash: ['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7'],
  copy: ['M8 8h13v13H8z', 'M16 8V3H3v13h5'],
  container: ['M4 5h16v14H4z', 'M4 9h16M8 5v4'],
  collapse: ['m7 8 5-5 5 5M7 16l5 5 5-5'],
  fold: ['m7 3 5 5 5-5M7 21l5-5 5 5'],
  check: ['m5 12 4 4L19 6'],
  list: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
};

export function icon(name, className = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  if (name === 'group') svg.classList.add('folder-icon');
  if (name === 'more') svg.style.strokeWidth = '3.5';
  for (const d of paths[name] ?? paths.globe) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
