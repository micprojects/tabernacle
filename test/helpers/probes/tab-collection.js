import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentDialog(dialogSource) {
  return replaceSource(
    dialogSource,
    '  return {\n    ...collections,',
    `  window.dialogLifecycleProbe = {
      show: showDialog, dispose, container: () => newContainerDialog(),
      resumeUi: () => { createDialog(); manageContainersDialog(); createContainerDialog(); },
      bulk: () => collections.closeCollection({ kind: 'window' }, getState().tabs),
      inspect: () => ({ action: Boolean(dialogAction), cancel: Boolean(dialogCancel),
        complete: Boolean(dialogComplete), cleanup: Boolean(dialogCleanup),
        context: Boolean(dialogContext), controls: Boolean(disabledControls), back: Boolean($('dialog-back').onclick),
        pickerHandlers: [$('container-search').oninput, $('container-search').onkeydown,
          $('dialog-options').onkeydown, $('container-search-clear').onclick,
          $('create-container').onclick, $('manage-containers').onclick].filter(Boolean).length,
        options: $('dialog-options').childElementCount, choices: $('dialog-select').childElementCount,
        content: $('dialog-content').childElementCount }),
    };
  return {
    ...collections,`,
  );
}

export function instrumentDemo(demo) {
  return replaceSource(
    replaceSource(
      replaceSource(demo, 'memoryBrowser({ groups,', 'memoryBrowser({ events: true, groups,'),
      'const memberships = {};',
      `
      entries[0] = ['Shared page first', 'design', 'https://example.test/same'];
      entries[1] = ['Shared page second', 'design', 'https://example.test/same'];
      entries[2] = ['Shared page third', 'research', 'https://example.test/same'];
      entries[3] = ['Shared article', 'design', 'https://example.test/article'];
      entries[4] = ['Shared other folder', 'personal', 'https://example.test/other'];
      const memberships = {};`,
    ),
    'return controller;',
    'window.collectionTest = { api, send: (type, args = {}) => controller.request({ type, windowId: 1, ...args }) }; return controller;',
  );
}
