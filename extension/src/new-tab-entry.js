import { NEW_TAB_AVAILABLE } from './new-tab/availability.js';

if (NEW_TAB_AVAILABLE) {
  document.body.hidden = false;
  await import('./new-tab-page.js');
} else {
  // Firefox forbids redirects to about:newtab. Keep old links inert without
  // replacing the tab itself or changing its saved folder/container membership.
  location.replace('about:blank');
}
