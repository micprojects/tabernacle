export const uiSuites = [
  'test-ui',
  'test-navigation-ui',
  'test-search-dismiss-ui',
  'test-domain-filter-ui',
  'test-domains-ui',
  'test-pane-refresh-ui',
  'test-tab-collection-ui',
  'test-duplicate-selection-ui',
  'test-breadcrumbs-ui',
  'test-folder-picker-ui',
  'test-move-dialog-ui',
  'test-folder-appearance-ui',
  'test-group-creation-ui',
  'test-folder-clicks-ui',
  'test-group-actions-ui',
  'test-folder-action-index-ui',
  'test-tree-expansion-ui',
  'test-tree-motion-ui',
  'test-tree-guides-ui',
  'test-tab-clicks-ui',
  'test-pinned-tabs-ui',
  'test-pinned-folders-ui',
  'test-tab-close-ui',
  'test-recently-closed-ui',
  'test-activity-page-ui',
  'test-incremental-pages-ui',
  'test-edge-cases-ui',
  'test-drag-ui',
  'test-audio-ui',
  'test-containers-ui',
  'test-container-style-ui',
  'test-color-mode-ui',
  'test-look-ui',
  'test-favicon-tint-ui',
  'test-settings-ui',
  'test-new-tab-ui',
  'test-backup-ui',
  'test-neutral-ui',
  'test-performance-ui',
  'test-cold-render-ui',
  'test-viewport-ui',
  'test-refresh-ui',
];

export const firefoxSuites = [
  'test-firefox',
  'test-upgrade-firefox',
  'test-memory-benchmark-firefox',
  'test-domain-filter-firefox',
  'test-tab-collection-firefox',
  'test-move-dialog-firefox',
  'test-container-picker-firefox',
  'test-drag-firefox',
  'test-tab-close-firefox',
  'test-backup-firefox',
  'test-new-tab-firefox',
  'test-activity-firefox',
  'test-find-firefox',
  'test-pinned-folders-firefox',
  'test-toolbar-icon-firefox',
];

// Identifiers also name reports and select native resource guards.
export const suiteFiles = new Map([
  ...uiSuites.map((name) => [name, `test/ui/${name}.js`]),
  ...firefoxSuites.map((name) => [name, `test/firefox/${name}.js`]),
  ['stress-firefox', 'scripts/stress-firefox.js'],
]);

export function suiteFile(name) {
  const file = suiteFiles.get(name);
  if (!file) throw new Error(`Unknown browser suite: ${name}`);
  return file;
}
