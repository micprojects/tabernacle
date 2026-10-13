import { openDemoPage } from './internal-pages.js';

export function createActivityLauncher({ demo, request, onError }) {
  let opening = false;

  return async () => {
    if (opening) return;
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
  };
}
