import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentMenu(menuSource) {
  return replaceSource(
    menuSource,
    '  let menuReturnFocus;',
    '  let menuReturnFocus; window.folderCopyUrls = copyUrls;',
  );
}

export function instrumentSource(source) {
  return (
    source +
    '\nwindow.folderActions = {setState(value) {state = value;}, copyUrls: window.folderCopyUrls, contextMenu, closeGroupTabsDialog, moveDialog};'
  );
}
