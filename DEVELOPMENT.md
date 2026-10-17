# Development

The tab list uses one layout, styled in `extension/tree.css`. Shared appearance tokens live in
`extension/colors.css`; the bottom bar, menus and dialogs live in `extension/sidebar.css`.
The sidebar, settings and activity page share this neutral light/dark palette.
Automatic uses the document's preferred colour scheme; Light and Dark are explicit overrides.
The retired theme source is ignored when loading existing preferences and omitted on the next
save. Custom folder and container colours remain explicit choices. Favicons come directly from Firefox.

Local folder and nested-tab folds use one height animation per branch in
`src/tree-motion.js`: 100 ms to open and 80 ms to close, regardless of tree size.
Reversals begin at the displayed height and shorten their duration to match the
remaining distance. Related parent/child animations settle before measurement;
unrelated branches can continue independently. There is no per-frame JavaScript
or per-row animation. Closing content becomes inert immediately. Background
updates, search, bulk folding, offscreen actions and reduced motion stay immediate.
Run `node scripts/test-tree-motion-ui.js` for interruption and accessibility checks.

`extension/settings.html` is the native Firefox options page. The Settings button
reuses one live page across windows, without navigating or reloading it, so its
section, scroll position and unsaved edits survive switching to another tab.
`src/internal-pages.js` launches it through the controller's serialized queue and
recreates it if closed. Settings and activity pages are omitted from Tabernacle's
tab tree, folder counts and recent activity, including recently closed tabs.
They still exist in Firefox's native tab strip; Firefox cannot hide an active tab.
New Settings documents claim the existing page before enabling editing, so opening
Preferences through Firefox also returns to the same view.
It shares the sidebar’s colour tokens and colour mode, with its layout in `settings.css`
and behaviour in `src/settings.js`. Appearance saves merge only edited fields in the
controller so simultaneous settings tabs preserve each other’s changes. Container forms
open in a modal without resizing the list, using the same choices and controller actions
as the contextual sidebar dialogs. Escape and Cancel return focus to the opening button.

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
closes, unpins and detaches remove their slots. Pin preferences and layouts are
omitted from version 1 folder backups.

The controller exposes `setGroupPin`, `revealGroup` and `enterGroup`. Pinned tab and
folder reordering uses `moveItem` with a `pins` destination. Snapshots include
`folderPins` and the resolved `pins` list. Revealing a folder never activates a tab
or records an opening; only a newly expanded target records expansion activity.
Run `node scripts/test-pinned-folders-ui.js` and
`node scripts/test-pinned-folders-firefox.js` for the new interactions and native
multi-window/session checks. Core behaviour is included in `npm test`.

## Domain filtering

`src/domain-filter.js` matches HTTP(S) hostnames, including subdomains. Hosts are case-insensitive,
normalised through URL parsing, and ignore a leading `www.` and trailing dot.
The menu uses the clicked host; other subdomains remain explicit (for example,
`music.youtube.com` filters that host and its subdomains).

The sidebar holds this temporary filter locally, renders all matching tabs in a flat
list, and hides the pin shelf and normal navigation/search while filtering.
`src/domain-header.js` shows the chosen tab's favicon and domain in a dedicated header.
`src/domain-title.js` resolves a site name from an exact host's open homepage title,
or a shared title suffix on at least two distinct pages with distinct titles. It excludes
generic/loading titles and child hosts. The name appears above a muted domain; missing
or ambiguous names retain the domain-only heading. Resolution uses existing tab data
without page requests or additional permissions. A resolved name lasts until the domain
view closes, even if its source tab closes.
The background wash favours the dominant coloured pixels, excluding transparent and
neutral pixels. For icons whose origin blocks canvas readback, samples are blended
directly into a display-only canvas; no pixel data is extracted and no host permission
or third-party favicon service is needed. Missing/broken icons use a globe and neutral
background. Late image events cannot recolour another domain. The wash adapts to dark
mode and is hidden in forced colours. The results toolbar shows a live count
and offers newest opened (default), recently viewed, oldest opened, natural title and
full tree order (pins first). Sorting changes only the projection; equal sort keys
retain tree order. The choice lasts for the sidebar session.
`openedAt` is captured at `onCreated` and persisted with tab membership. Existing tabs
without a known date follow dated tabs in tree order. Restores preserve recorded dates;
duplicates receive a new date. Viewing order uses Firefox's native `lastAccessed`.
Result titles wrap to at most three lines, with actions aligned to the first line.
The full title remains in the tooltip and accessible name. Ordinary tree/search rows
stay single-line. Rows expose their original folder in a tooltip and through Show in folder. Activating
a result passes `expandAncestors: false`; closing uses the single-tab action, even for
a parent. Close selection asks the live sidebar for its domain and sort,
including for native Firefox closes. It keeps Firefox's successor if still visible;
otherwise it selects the nearest remaining match above, then below. An empty list
keeps Firefox's choice. This temporary context is never stored. No fold or membership
changes are needed for this view. Dragging and fold
controls are disabled while filtering; explicit Move tab remains available.
The header's close button or Escape restores the prior scroll and selection.
Search remains a separate mode; Ctrl/Command K exits the domain view and opens ordinary
search. Domain tokens are no longer parsed in the search field.

Run `node scripts/test-domain-filter-ui.js` for live updates, safe closing, keyboard
navigation, view restoration, favicon colours and narrow-panel/colour-mode checks, and
`node scripts/test-domain-filter-firefox.js` for native Firefox and window isolation.
Hostname, colour and ordering checks are included in `npm test`.

### YouTube enhancement

The model's `youtubeMode` boolean defaults to true when absent. `setYouTubeMode` saves
it through the existing serialised controller and notifies all windows. The Enhanced toggle
replaces the count only on supported YouTube domains, including when switched off.
The accessible status retains the result count. Domain navigation and sorting are unchanged.

`src/youtube.js` recognises video IDs from watch, Shorts, live, embed and short-link
URLs, ignoring tracking and timestamp parameters. `src/youtube-view.js` renders the
Continue watching layout, using an IntersectionObserver to load visible thumbnails
and check at most two loaded tabs concurrently every five seconds. Optional host
access is requested from the explicit Allow access button; without it, ordinary tab
data and thumbnails remain usable. `scripting.executeScript` only reads the isolated
DOM/video properties. It never activates, seeks, starts or loads a video. Discarded
tabs are never injected. Ad players and mismatched navigation IDs are rejected.
Live detection uses the media duration or the player's active live class, never
the hidden live badge that YouTube also includes in ordinary video players.

Public oEmbed metadata is cached by video ID with a bounded cache, failure backoff,
an eight-second timeout and credential/referrer-free requests. Observed positions
are cached separately per tab in `tabernacle.youtube.v1` session values, never shared
between duplicate tabs. Saved observations identify Last seen in their tooltip and
accessible progress label. Unknown progress and playback-state text are omitted;
known progress appears along the thumbnail's bottom edge with a position below the
title. Cached duration/channel metadata can be shared for the same video. Switching
off stops polling and aborts pending metadata fetches. Late results cannot update a
different video or the standard tree. The CSP permits metadata connections only to
`https://www.youtube.com`; no third-party metadata service or API key is used.

Titles omit YouTube's leading notification count and site suffix. Folder paths omit
the Home prefix, and Home alone stays in the row tooltip. Show in folder and Copy
link actions appear over the thumbnail on hover or keyboard focus (beneath it on
touch devices). Firefox 158's native Picture-in-Picture API was tested with a trusted
sidebar click in an isolated profile: `scripting.executeScript` does not transfer
user activation, so the player rejects the request. There is no PiP button until
Firefox supports this route; no browser preferences or privileged API workaround
are used.

The In progress and Duplicates filters are temporary projections. Their visible IDs
are passed to close selection, so sidebar and native closes use visible neighbours.
Run `node scripts/test-youtube-ui.js` for permission, layout, filters and persistence;
`node scripts/test-youtube-firefox.js` checks optional access, real media properties
and sleeping-tab/persistence behaviour in an isolated native Firefox profile. Its
tiny local silent WebM fixture replaces the body of a fresh public YouTube tab; it
never opens a personal profile. Pure parsing, caching and preference tests run in
`npm test`.

### Other site modes

`src/site-modes.js` recognises supported hostnames and routes and provides the small amount
of context available from URLs alone. The shared `src/site-view.js` keeps the existing flat
domain list, sort order, close behaviour, container/audio labels and folder tooltips. Its
Enhanced switch is saved per mode in `siteModes` through `setSiteMode`; absent preferences default on.
Google's shared host only offers Maps enhancement when the source tab is a Maps page. Non-map
results on that domain retain normal rows. Site families do not silently broaden the domain
filter to other hosts.

`src/site-reader.js` is a self-contained, isolated-world reader for Reddit (modern and old),
Hacker News, GitHub, Amazon, eBay, Etsy, Wikipedia, Google Docs/Sheets/Slides, Google Maps,
IMDb and Letterboxd. It uses targeted DOM fields and structured metadata, never page-world
application state. There are no account API calls. Detail rows are limited to two text lines
(each can wrap twice), plus a related-item label only when there are multiple matching tabs.
Preview images are used for products, articles, films and suitable Reddit posts. Maps use
the name/category/address; GitHub and documents use their existing favicon. No ratings,
review snippets, invented reading progress, shipping estimates or recommendation feeds.

`src/site-service.js` requests optional access only from the explicit Allow access button.
Shopping access is limited to the selected site's country domain; document access is limited
to docs.google.com; Maps requests the selected Google host and its www equivalent. HN adds
its official Firebase API as a credential-free, referrer-free fallback, with an eight-second
timeout. Other providers only read loaded tabs. Images omit referrers. All new host permissions
are optional. Supported country hosts are listed in `site-modes.js` and mirrored in the manifest.

The view checks visible rows with at most two concurrent reads. Successful reads are throttled
to 30 seconds. Failures retry after 15 seconds, doubling up to five minutes; switching the mode
off aborts fetches and invalidates pending results. URL checks before/after injection reject
navigation races. Permission revocation hides enriched observations. Cached data is per tab
and exact URL, persisted under `tabernacle.site-details.v1` with the tab's durable tree identity.
Discarded tabs use their own saved observation without injection; unknown fields remain blank.
Metadata tooltips include the observation time. Related-item labels never collapse or close tabs.

Run `node scripts/test-site-modes-ui.js` for all provider readers, missing/blocked data,
images with real favicon elements, 220/320/480px layouts, toggles, dark mode and forced colours.
Unit tests cover routing, identities, permission declarations, retries, sleeping tabs,
revocation, navigation races and preferences. `node scripts/check-site-modes-live.js` is an
opt-in network check in an isolated Firefox profile; it records actual retrieval and sidebar
screenshots under `test-results/site-modes/`. Pass provider names to narrow a rerun. It reports
unavailable/challenged pages separately from successful reads; deterministic fixtures are not
evidence of live website access.

## Moving tabs and folders

`src/move-plan.js` resolves drag and keyboard destinations to the same typed slot.
Tabs always go inside folders; their own rows offer before, inside and after.
Folder ordering remains separate from tab ordering. Move tab and Move folder use
a searchable folder tree with Home as its root and append to the selected folder.
Search retains matching folders' ancestors, without breadcrumbs or individual tabs.
The picker omits pin destinations and position controls; shortcut reordering uses drag.
Its shell uses `picker-dialog.css`; the scrollable tree uses `move-dialog.css`.

Container choosers share this shell, with a searchable single-selection list in
`src/container-picker.js` and `container-picker.css`. Filtering keeps the current
identity separate from the selected target and disables submission if that target
is hidden. Enter in search selects a result without submitting. New-container and
management detours retain selection; management also retains the search query.
Run `npm run test:containers` for search, keyboard, reopening, default-container,
management, narrow-panel and failure checks.

`src/pointer-move.js` captures the pointer on the persistent sidebar after 5px
of movement. It owns the floating preview, insertion marker, edge scrolling and
600ms hover navigation. Temporary expansion and scope changes are projected over
fresh snapshots and discarded on cancellation; they do not activate pages or
write folder activity. A successful move reveals and highlights its result.

`moveItem` validates an expected placement against fresh state in the controller's
serialized queue. Version 2 move recovery journals membership changes, native
pin changes and affected layout slots; version 1 records remain readable.
Recovery patches only the fields or positions owned by the operation. The latest
receipt per window makes retries after a lost response idempotent. A failed
reveal is reported separately from a committed move and offers a Show retry.

Run `node scripts/test-drag-ui.js` for destination geometry, continuous hierarchy
navigation, cancellation, folder moves, colour modes and 100/500/1,000-tab scrolling.
`node scripts/test-move-dialog-ui.js` covers folder search, keyboard selection,
subtree moves, stale destinations, narrow layouts and light/dark/forced colours.
`node scripts/test-move-dialog-firefox.js` checks the picker in an isolated native sidebar.
The unit suite injects failures and restarts at compound-operation write boundaries.
`npm run test:firefox` also tests continuous dragging in Firefox's actual sidebar.
For a visible, isolated-profile check, run
`FIREFOX_DRAG_HEADED=1 node scripts/test-drag-firefox.js`; preview and result captures
are saved under `test-results/`. The temporary profile is removed on completion.

## Folder appearance

Folders may store an optional `appearance` with independent `icon` and palette
`color` IDs. Colours inherit from the nearest ancestor with a custom colour, then
fall back to the effective container or the standard folder colour. An explicit
colour overrides inheritance for that folder and its subfolders; reset removes
the override. Inherited colours are resolved when rendered, so edits and moves
update descendants without copying colours into their saved appearance. Icons
apply only to that folder and fall back to its explicitly assigned container's icon,
or the standard folder icon when its container is inherited. Custom icons override
either default. The catalogue and search keywords live in
`src/folder-appearance.js`; the picker uses bundled, licensed Acorn symbols followed
by custom A–Z and 0–9 symbols from `icons/ui/folder-icons.svg`. The final Letters &
numbers category includes all 36 characters; searching a character or its label
(such as "A" or "Number 7") finds that glyph directly. Asset provenance is recorded
in `icons/ui/NOTICE.txt`. Firefox container identities keep their native choices.

Connecting lines use a 1.5 px stroke and three hue-preserving shades from
`guideColors` in `src/appearance-colors.js`. The fade stops at the third visible
branch and resets when entering a folder. Folder lines follow the effective folder
colour; nested-tab lines follow their parent tab's container colour, with neutral
as the fallback. Children cannot recolour an ancestor's line. Text and icon shades
remain independent, and forced-colour mode uses the system's `GrayText` throughout.

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
GeckoDriver when needed. Both the Firefox integration and Chromium UI suites use
real pointer sequences through the shared drag controller, including on macOS.
Set `FIREFOX_BINARY` or `GECKODRIVER_BINARY` to use a specific local executable.

`node scripts/test-tab-close-firefox.js` checks the native Command+W/Ctrl+W close
path with animations enabled, alongside the sidebar close button, undo and immediate
Settings reopening. Firefox
can return an already invalidated tab ID from `tabs.query()` during its close
animation; failed session reads/writes therefore check that individual ID before
reporting an error and discard the stale native cache after confirming closure.
Internal-page opening also confirms failed IDs and skips closed candidates before
reusing a live page or creating a replacement, avoiding errors and duplicate pages.
Set `FIREFOX_CLOSE_HEADED=1` for a visible run. Evidence is saved in
`test-results/firefox-tab-close.json`.

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
fixtures in `preview/`. The neutral app icon source is
[`extension/icons/tabernacle.svg`](extension/icons/tabernacle.svg).
The add-on manifest and app pages use this vector so Firefox can render it sharply
at any display scale. It uses the toolbar's grey (`#5e5e5e`) and off-white
(`#fbfbfb`), with the two colours reversed in dark appearance. The SVG follows the
embedding page's colour scheme, including the saved Light/Dark setting.
PNGs retain the light variant for stores that cannot switch artwork with the theme.
They are rasterised directly from the vector at each target size: curves are
antialiased, with no extra resizing pass to soften the pixel-aligned straight edges.
Use `extension/icons/tabernacle-128.png` for the AMO listing upload. AMO generates
its own image sizes; uploading a larger master cannot force its pages to request
a Retina-sized image. Check the served image and display size after publication.
The transparent toolbar and Firefox sidebar symbols are generated by
[`scripts/toolbar-icon.js`](scripts/toolbar-icon.js). The SVG uses neutral
light/dark strokes selected by Firefox's browser appearance, independently of website
colour preferences and the sidebar's saved colour mode. No theme catalogue or installed
add-on inventory is used. `npm run test:toolbar:firefox` checks the painted toolbar pixels
in light and dark appearance, including Retina displays.
Run `npm run icons:generate` to regenerate the default toolbar SVG, PNG exports in `extension/icons/`,
[`assets/tabernacle-1024.png`](assets/tabernacle-1024.png), which the screenshot exporter uses,
and the large [`assets/tabernacle-4096.png`](assets/tabernacle-4096.png) master.
Use the SVG for the product website; keep the PNGs for raster-only consumers.
Build packages (`dist/`), test output (`test-results/`) and
design experiments (`output/`) are local, ignored files.

## Refreshing screenshots

After changing the UI, run:

```sh
npm run screenshots:refresh
```

This refreshes all seven promotional screenshots and their transparent `-ui` variants in
`assets/screenshots/`, in PNG and lossless WebP. It preserves the existing copy, rounded
corners and output widths used by the README and website. The fine lavender-grey frame
uses a light or dark shade to suit each screenshot. To inspect
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

Captures use the neutral appearance, with each shot's Light or Dark colour mode saved
explicitly. The runner verifies each scene's resolved appearance and records it in the report.
The Recent activity scene runs last, opening folders, viewing tabs and closing demo tabs
through Firefox and the extension. It captures the real popup and checks that all three
activity types appear in its first ten entries.
The fixture gives those records sample ages in minutes at the sidebar's snapshot API
boundary. The popup itself sorts them and formats the elapsed-time labels. This changes
only the isolated screenshot session's data, not the extension's UI or saved history.

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
bounds, transparent corners, the matching frame colour, lossless WebP pixels and that the UI
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

The command launches and cleans up its own headless Firefox process, temporary profile
and app-data directory. Your normal Firefox can stay open. `FIREFOX_BINARY` and
`GECKODRIVER_BINARY` override the installed binaries; GeckoDriver downloads on the first
run when needed. Set `FIREFOX_STRESS_SIZES=100,500,2000` to change the workload.

## Release QA

Run the complete gate before preparing a release:

```sh
npm run qa:release
npm run qa:release -- --stress
```

Both commands run formatting, lint, unit tests, all UI and native Firefox suites, and
an unsigned build. The second also runs the larger tab stress workload. They do not
change versions, commit, sign or publish anything. Each run writes a separate log for
each check and a machine-readable `results.json` under `test-results/release-qa/`.
The exit status is nonzero if any check fails; later suites still run to expose other
failures. Individual browser screenshots remain in `test-results/`.

The catalog in `scripts/qa-suites.js` also drives `test:ui` and `test:firefox`. A unit test
checks that every maintained browser suite is registered, so adding a test cannot
silently leave it outside release QA. Native integration suites and stress share
`scripts/firefox-session.js`; actual sidebar suites use `ScreenshotBrowser` for native
sidebar access. Both fixtures create and verify their own temporary Firefox profiles.
Playwright Chromium and Firefox must be installed before running browser checks.

## Refresh and folder indexing

`src/refresh-scheduler.js` coalesces notifications, filters window IDs and skips revisions
already included in a response. A new background generation resets revision comparison.
Only one refresh runs at a time. Settings and activity defer notification reads while
hidden; sidebar refreshes pause during pointer gestures and queued actions. Settings
merge incoming preferences around dirty fields, preserving unsaved edits.

`src/folder-index.js` builds folder lookup, child order, ancestor ranges and inherited
container/colour information once per render. The sidebar tree index and both folder
pickers share it. Indices are rebuilt from the current snapshot to avoid stale defaults
after in-place edits or moves. Traversal and picker construction are iterative. Folder
indexing supports deep inputs, but deeply nested sidebar DOM can still incur browser
layout costs; the index does not virtualise the sidebar.
