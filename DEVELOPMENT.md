# Development

The tab list uses one layout, styled in `extension/tree.css`. Shared appearance tokens live in
`extension/colors.css`; the bottom bar, menus and dialogs live in `extension/sidebar.css`.
The sidebar, settings and activity page share this Monochrome fallback palette. Its saved
theme source remains `tabernacle` for compatibility with existing preferences. Firefox palettes
come from `src/theme-palette.js`, including action, focus and default folder colours.
Primary actions use the theme’s popup highlight/text pair, or its popup text/background
when no highlight is supplied. Custom folder and container colours remain explicit choices.
Favicons come directly from Firefox.

In Follow Firefox, the sidebar continues the selected theme's frame colour across
the tab list and footer. The search and pins area starts at the system Canvas colour
(white in light appearance) and fades into the theme through the first two list rows,
softening the transition from Firefox's own header. The fade follows the actual header
height, including wrapped or hidden pins, and is disabled in forced colours.
Bundled themes add their leading gradient
stop as a flat overlay, including its original opacity; external themes use their
exposed frame colour. Theme and light/dark changes repaint this surface through
the existing theme observer. Controls keep their paired theme surfaces and text.

`extension/settings.html` is the native Firefox options page. The Settings button
reuses one live page across windows, without navigating or reloading it, so its
section, scroll position and unsaved edits survive switching to another tab.
`src/internal-pages.js` launches it through the controller's serialized queue and
recreates it if closed. Settings and activity pages are omitted from Tabernacle's
tab tree, folder counts and recent activity, including recently closed tabs.
They still exist in Firefox's native tab strip; Firefox cannot hide an active tab.
New Settings documents claim the existing page before enabling editing, so opening
Preferences through Firefox also returns to the same view.
It shares the sidebar’s colour tokens and theme observer, with its layout in `settings.css`
and behaviour in `src/settings.js`. Appearance saves merge only edited fields in the
controller so simultaneous settings tabs preserve each other’s changes. Container forms
use the same choices and controller actions as the contextual sidebar dialogs.

The Firefox add-on ID is `tabernacle@michaelprojects.com`, with saved data under `tabernacle.*`
keys.

## Folder backups

Settings → Backup and restore uses `src/settings-backup.js`, with portable parsing and
merge planning in `src/folder-backup.js`. The `tabernacle-folders` version 1 JSON format
stores an export date, ordered `folders` and referenced `containers`. Record IDs are
file-local references. A folder's omitted `container` means inheritance, `none` means
regular browsing, and any other value references a container definition. Unavailable
definitions carry `unavailable: true` and must be mapped during import. Files are limited
to 5 MB and 10,000 folders/containers.

The dedicated controller handles `getFolderBackupState`, `exportFolders`,
`previewFolderImport` and `importFolders` without tab snapshots or session repair.
The Settings page retains the backup, destination, preview fingerprint and operation
token, allowing imports after the MV3 background page unloads. Commit compares the
fingerprint against fresh folder/container state and returns a new preview if changed.
Folder additions and the latest import receipt are saved together; retrying that operation
returns its result without duplicating a destination folder. Pending moves must finish
through the sidebar before backup actions can run.

Run `npm run test:backup` for the Settings flow and `npm run test:backup:firefox` for
download/upload and persistence checks in an isolated native Firefox profile. Core
format, merge and failure tests are included in `npm test`.

## Pinned folders

`src/pinned-items.js` reconciles the mixed strip. The model's ordered `folderPins`
contains folder IDs and `open`/`reveal` actions; a window's `pinLayout` stores typed
folder IDs and durable tab `treeId` references. Folder slots follow shared folder
order, and tab slots follow native Firefox pinned order. New slots append. Missing
tab identities remain dormant during incremental session restoration; observed
closes, unpins and detaches remove their slots. Explicit rearrangement retains only
live pins. Pin preferences and layouts are omitted from version 1 folder backups.

The controller exposes `setGroupPin`, `movePinnedItem` and `revealGroup` alongside
the compatible `enterGroup` and `movePinnedTab` actions. Snapshots include
`folderPins` and the resolved `pins` list. Revealing a folder never activates a tab
or records an opening; only a newly expanded target records expansion activity.
Run `node scripts/test-pinned-folders-ui.js` and
`node scripts/test-pinned-folders-firefox.js` for the new interactions and native
multi-window/session checks. Core behaviour is included in `npm test`.

## Folder appearance

Folders may store an optional `appearance` with independent `icon` and palette
`color` IDs. Colours inherit from the nearest ancestor with a custom colour, then
fall back to the effective container or the standard folder colour. An explicit
colour overrides inheritance for that folder and its subfolders; reset removes
the override. Inherited colours are resolved when rendered, so edits and moves
update descendants without copying colours into their saved appearance. Icons
apply only to that folder and fall back to the effective container or standard
folder icon. The catalogue and search keywords live in
`src/folder-appearance.js`; the picker uses bundled, licensed Acorn symbols followed
by custom A–Z and 0–9 symbols from `icons/ui/folder-icons.svg`. The final Letters &
numbers category includes all 36 characters; searching a character or its label
(such as "A" or "Number 7") finds that glyph directly. Asset provenance is recorded
in `icons/ui/NOTICE.txt`. Firefox container identities keep their native choices.

## Recent activity

The history button opens a compact popup spanning the sidebar's available width.
It starts on All each time and contains up to 50 recent viewed tabs, closed tabs and
opened or deliberately expanded folders, with one entry per folder using its latest
activity time. The filter bar above the list selects the latest 50 matching items
for Viewed, Closed or Folders. The list shows up to ten rows at once (fewer in short
windows) and scrolls while the heading, filters and More action stay visible. Opening
the popup by mouse or keyboard, or changing its filter, resets the list to the top.
Clicking an item switches to its tab, reopens it or enters its folder.

A subtle backdrop dims the sidebar above the bottom toolbar while the popup is
open. Only its opacity animates, with no blur or layout changes; reduced motion
disables the fade, and forced colours use a clear popup outline instead of shading.
The backdrop does not intercept pointer events, preserving click-away behaviour.

More opens `extension/activity.html` as a dedicated page hidden from Tabernacle's
tab list, reusing it in the same window without resetting filters or scroll position.
`recently-closed.js` and `recent-history.js` supply the popup; `activity-launcher.js`
opens the full page. Both screens use `activityEntries` in `recent-history.js` for
the same folder events and newest-first order; `activity-data.js` adds page details
and filters. Sorting uses the full millisecond timestamps before display labels or
the popup's 50-item limit. Equal timestamps preserve source order, including
Firefox's closed-session order and saved folder recency, without alphabetical
tie-breaking. An exact order between different event types with identical recorded
times is unavailable; their order is stable and consistent across both screens.

The page uses a single timeline, with the same live
controller messages as the sidebar. It excludes itself from activity and follows
the window it is in. Viewed tabs are currently open tabs; closed tabs come from
Firefox's session restore list. Folder activity merges the latest opening and
deliberate expansion per folder, with separate filters that use each event's own
time. Expansion timestamps are saved per window and bounded to 100 folders.

Open `http://127.0.0.1:4173/extension/activity.html?demo&mockup` after `npm run preview`
to preview the timeline with sample activity. Run
`node scripts/test-activity-page-ui.js` for the page and launcher tests.
`node scripts/test-activity-firefox.js` verifies the same actions in an isolated
native Firefox profile.
The design follows Acorn's [in-content typography](https://acorn.firefox.com/latest/desktop/design-tokens/typography-Yo8yPRYS)
and [button guidance](https://acorn.firefox.com/latest/desktop/components/button-gsFv3Uj9),
with system fonts, existing Firefox icons, labelled actions and visible focus.

Use the Node.js version in `.nvmrc` and install the locked dependencies:

```sh
nvm use
npm ci
```

Run `npm run dev` to load the extension in a temporary Firefox profile, or `npm run preview`
to open a local development server at `http://127.0.0.1:4173`. The preview uses sample tabs
and an in-memory browser adapter shared by the tests.

```sh
npm run check
npx playwright install chromium
npm run test:ui
```

`check` runs formatting checks, JavaScript and extension linting, and the unit tests.
`test:ui` runs the sidebar and settings UI suites. `npm run test:settings` runs just
the settings suite. `npm run test:firefox` runs integration tests with
temporary Firefox profile and app-data directories; it requires Firefox and downloads
GeckoDriver when needed. On macOS, those integration tests dispatch HTML drag events
because Marionette can fail to complete pointer drags. The Chromium UI suites exercise
pointer dragging.
Set `FIREFOX_BINARY` or `GECKODRIVER_BINARY` to use a specific local executable.

## Release build

Keep the versions in `package.json`, `package-lock.json` and `extension/manifest.json`
in sync, run the checks above, then build:

```sh
npm run build
```

The build creates an unsigned `dist/tabernacle-<version>.zip` containing only `extension/`
contents and the root `LICENSE`. Tests, preview fixtures, development tools and master artwork
are excluded from the extension package. The build fails if the package and manifest
versions differ.

The repository keeps the maintained tests in `test/` and `scripts/test-*.js`, with shared
fixtures in `preview/`. The app icon source is
[`extension/icons/tabernacle-toolbar-full.svg`](extension/icons/tabernacle-toolbar-full.svg).
Firefox's toolbar, sidebar, add-on listings and the preview use this same full-canvas SVG.
Run `npm run icons:generate` to regenerate the PNG exports in `extension/icons/` and
[`assets/tabernacle-1024.png`](assets/tabernacle-1024.png), which the screenshot exporter uses.
Build packages (`dist/`), test output (`test-results/`) and
design experiments (`output/`) are local, ignored files.

## Refreshing screenshots

After changing the UI, run:

```sh
npm run screenshots:refresh
```

This refreshes all six promotional screenshots and their transparent `-ui` variants in
`assets/screenshots/`, in PNG and lossless WebP. It preserves the existing copy, rounded
corners, fine green border and output widths used by the README and website. To inspect
the result before replacing tracked images:

```sh
npm run screenshots:refresh -- --preview
```

Your normal Firefox can stay open and in use. The command launches its own headless
Firefox process with a new temporary profile and app-data directory. It never attaches
to an existing browser, uses the mouse or clipboard, or changes your personal tabs,
containers, extensions or settings. It quits its own browser and removes the temporary
profile when finished, including on failure. Firefox must be installed; GeckoDriver is
downloaded on the first run. `FIREFOX_BINARY` and `GECKODRIVER_BINARY` can override them.

The command installs the current `extension/` directory and captures its actual sidebar
through Firefox's native rendering API. It creates real tabs, containers and folder trees
using the shared demo setup. Page titles and original website favicons are saved in
[`assets/screenshots/screenshots.json`](assets/screenshots/screenshots.json) and
[`assets/screenshots/favicons/`](assets/screenshots/favicons/). WebDriver serves these demo
page responses at their original URLs, so captures do not depend on live websites,
cookie prompts or anti-bot pages. This fixtures website metadata, not the extension UI:
no extension markup, styles or rendering code are replaced.

Each run saves native 5× captures, exported 3× images, a contact sheet, promotional
previews, the measured crop configuration, a verification report and a GeckoDriver log
under `output/screenshots/run-*/`. The command prints the paths;
`output/screenshots/latest.json` points to the last successful run. These files are ignored
by Git. Crop bounds follow the elements specified by each shot's `framing` selectors, so
row-height changes are picked up automatically. A tall UI is fitted inside its promotional
composition; the standalone UI keeps its configured width. If content no longer fits the
sidebar, capture fails instead of silently cutting it off. Increase the fixture's window
and capture height or revise the scene if necessary.

Before publishing any images, the runner checks stable frames, source dimensions, crop
bounds, transparent corners, the green border, lossless WebP pixels and that the UI
interior matches the native capture after downsampling. It also rejects inputs edited
during capture. Failed captures or exports leave the current images in place. Captures
are repeatable with the same Firefox version, OS and installed fonts; platform or browser
updates can change text rendering. The native sidebar capture uses Firefox's internal
DevTools API, verified with Firefox 157, and may need adapting after a Firefox update.

The older manual tools remain available: `npm run screenshots:prepare` writes the demo
setup snippet to `output/promo/setup-console.js`, and `npm run screenshots:export --
<sources> <destination> [resolved-fixture.json]` exports existing 5× source captures.

## Stress testing

`npm run test:stress` exercises 100, 500 and 1,000 real Firefox tabs, including search,
nested branches, live page updates, containers, folder closure and extension reload.
It records diagnostic timings in `test-results/firefox-stress.json`; timings are not
machine-dependent pass thresholds. Most tabs stay unloaded, with up to 20 local pages
generating title updates.

Use a dedicated test profile. Close Firefox, then launch that profile with `--marionette`
and `--remote-allow-system-access`. On macOS, for example:

```sh
open -a Firefox --args -profile '/absolute/path/to/test-profile' --marionette --remote-allow-system-access
FIREFOX_STRESS_PROFILE='/absolute/path/to/test-profile' npm run test:stress
```

Find the actual profile directory in `about:support`; names in Firefox's newer profile
picker may differ from the legacy command-line names. The script verifies the directory
before installing the extension temporarily. It uses a separate test window and removes
its own folders, tabs and container afterward. Existing profile data is kept.
Set `FIREFOX_STRESS_SIZES=100,500,2000` to change the workload. Quit Firefox afterward to
end the automation session; the temporary extension installation ends at browser restart.
