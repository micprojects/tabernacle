import { openDemoPage } from './internal-pages.js';

// Temporary page experiment. ?history=panel restores the untouched slide-up UI.
export function installActivityLauncher({ trigger, demo, request, beforeOpen, onError }) {
  if (new URLSearchParams(location.search).get('history') === 'panel') return;
  for (const name of ['aria-haspopup', 'aria-expanded', 'aria-controls'])
    trigger.removeAttribute(name);
  trigger.title = 'Open recent activity';
  let opening = false;

  async function open(event) {
    if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (opening) return;
    beforeOpen();
    if (demo) {
      openDemoPage('activity');
      return;
    }
    opening = true;
    try {
      await request('openPage', { page: 'activity' });
    } catch (error) {
      onError(`Could not open recent activity. ${error.message}`);
    } finally {
      opening = false;
    }
  }

  trigger.addEventListener('click', open, { capture: true });
  trigger.addEventListener('keydown', open, { capture: true });
}
