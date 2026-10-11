/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Adapted from Firefox 157.0.1 design-system and tab tokens. See NOTICE.txt. */

export const firefoxSource = {
  version: '157.0.1',
  revision: '737ec77d798755890b062aab541a90d6c75afd19',
  repository: 'https://hg.mozilla.org/releases/mozilla-release',
};

// Resolved Nova tokens. These are Firefox colours, not Tabernacle's fallback.
export function firefoxDefaults(dark) {
  return {
    frame: dark ? '#252428' : '#ffffff',
    tab_background_text: dark ? '#f2f0f8' : '#180e30',
    toolbar: dark ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.4)',
    toolbar_text: dark ? '#fcfbff' : '#15141a',
    icons: dark ? '#e7e1f8' : '#75669f',
    tab_selected: dark ? '#171519' : '#ffffff',
    tab_text: dark ? '#f2f0f8' : '#180e30',
    tab_line: 'transparent',
    toolbar_field: dark ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.4)',
    toolbar_field_text: dark ? '#e7e1f8' : '#3e315f',
    toolbar_field_border: dark ? '#3f3e42' : '#d6d5da',
    toolbar_field_focus: dark ? '#171519' : '#ffffff',
    toolbar_field_text_focus: dark ? '#e7e1f8' : '#3e315f',
    popup: dark ? '#171519' : '#ffffff',
    popup_text: dark ? '#f2f0f8' : '#180e30',
    popup_border: dark ? '#67666a' : '#d6d5da',
    button_background_hover: dark ? 'rgba(182, 170, 217, 0.25)' : 'rgba(117, 102, 159, 0.25)',
    button_background_active: dark ? 'rgba(182, 170, 217, 0.4)' : 'rgba(117, 102, 159, 0.4)',
  };
}

export const firefoxDefault = {
  id: 'default-theme@mozilla.org',
  name: 'Firefox Default',
  manifest: Object.fromEntries(
    [false, true].map((dark) => [
      dark ? 'dark_theme' : 'theme',
      {
        colors: firefoxDefaults(dark),
        images: {
          additional_backgrounds: [
            {
              'linear-gradient': `96deg, ${dark ? 'rgba(62, 49, 95, 0.5)' : 'rgba(234, 221, 255, 0.5)'} 39.84%, ${dark ? 'rgba(112, 28, 7, 0.5)' : 'rgba(255, 219, 197, 0.5)'} 101.72%`,
            },
          ],
        },
        properties: { backgrounds_area: 'window' },
      },
    ]),
  ),
};
