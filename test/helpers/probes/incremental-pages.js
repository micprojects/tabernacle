import { replaceSource } from '../../../scripts/instrumentation/source.js';

export function instrumentSource(source) {
  return (
    replaceSource(source, 'start().catch(', 'window.pageStartDone = start().catch(') +
    '\nwindow.pageStartProbe = () => ({ disposed, retainedState: Boolean(state), reader: Boolean(readSnapshot) });'
  );
}
