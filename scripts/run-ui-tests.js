import { spawnSync } from 'node:child_process';

for (const name of [
  'test-ui',
  'test-navigation-ui',
  'test-search-dismiss-ui',
  'test-breadcrumbs-ui',
  'test-folder-picker-ui',
  'test-folder-appearance-ui',
  'test-group-creation-ui',
  'test-folder-clicks-ui',
  'test-group-actions-ui',
  'test-tree-expansion-ui',
  'test-tab-clicks-ui',
  'test-pinned-tabs-ui',
  'test-pinned-folders-ui',
  'test-tab-close-ui',
  'test-recently-closed-ui',
  'test-activity-page-ui',
  'test-edge-cases-ui',
  'test-audio-ui',
  'test-containers-ui',
  'test-color-mode-ui',
  'test-look-ui',
  'test-settings-ui',
  'test-backup-ui',
  'test-themes-ui',
  'test-performance-ui',
]) {
  const result = spawnSync(process.execPath, [`scripts/${name}.js`], {
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
