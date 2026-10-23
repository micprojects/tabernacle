# Development

The tab list uses one layout, styled in `extension/tree.css`. Shared appearance tokens live in
`extension/colors.css`; the bottom bar, menus and dialogs live in `extension/sidebar.css`.
The sidebar, settings and activity page share this neutral light/dark palette.
Automatic uses the document's preferred colour scheme; Light and Dark are explicit overrides.
The retired theme source is ignored when loading existing preferences and omitted on the next
save. Custom folder and container colours remain explicit choices. Favicons come directly from Firefox.

Trees and filtered result lists over 100 rows use the local viewport renderer in `src/tree-viewport.js`.
`src/tree-geometry.js` builds one geometry record per logical row, including nested branch
endpoints, and finds the visible range with two binary searches. The renderer keeps the
existing adaptive buffers, bounded row reuse, ancestor and interaction ownership. Domain and
Saved search results use the same fixed tab heights; a Saved section heading occupies 34 px
without entering the keyboard row order. Empty search folders have no drop placeholder, since
dragging is disabled while filtering. Smaller lists use the full renderer. It observes
the scroll container directly, reads current scroll offsets for synchronous reveals/restores,
and disconnects its resize observer and events on disposal. There is no runtime virtualisation
dependency or duplicate measurement cache. The earlier TanStack experiments below are historical.
Tabernacle search and bulk actions use the complete logical result set. As in the main tree,
native Firefox Find cannot discover unmounted rows in large domain or Saved search results;
the native Find suite covers the full-renderer and extension-page fixtures.

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

## Experimental new tab page

The new tab page is experimental and is omitted from Settings navigation and the
public feature list. For development, open `settings.html#new-tab` (or
`settings.html?demo#new-tab` in the preview). The section is labelled experimental;
existing preferences, routing and the page's Customise action are preserved so
existing testers can still edit or disable it.

`extension/new-tab.html` uses the shared neutral palette and the current window's
controller snapshot. `src/new-tab-preferences.js` normalises the global `model.newTab`
preferences, defaults the master and weather switches off, and validates up to
60 HTTP(S) links. `setNewTab` merges only changed settings fields and persists them
atomically. `getNewTabState` returns window data and the global page preferences.
New tab pages remain ordinary tabs so links and web searches keep their folder
membership and container; closed copies of the page are excluded from recent history.

Firefox's manifest new-tab override is static, so the extension deliberately has
no `chrome_url_overrides` entry. `src/new-tab-routing.js` synchronously registers
listeners for newly created `about:newtab` tabs and redirects only while enabled.
It checks current navigation, private/discarded state and prior session membership
before replacing the initial history entry. Existing tabs, explicit blanks and other
extensions' overrides are left alone. Tabernacle's own new-tab and child-tab commands
create the page directly when enabled. Firefox cannot expose an empty, selected
address bar for a runtime redirect. Newly opened foreground pages therefore focus
their search field, or Customise when search is hidden. Background tabs and reloads
do not take focus. The address bar still shows the extension URL; ⌘L/Ctrl+L selects it.

The New tab section in Settings supports editable links, drag and keyboard reordering,
manual Save/Discard, visibility and appearance choices. `previewNewTab` passes an
unsaved draft via one-use `storage.session` data to a page with `?preview=…`; previewing
does not enable routing or fetch weather. Customise reuses the existing Settings page
and sends it to the New tab section without resetting unsaved edits. Search matches
open tabs and folders locally; form submission calls `browser.search.search` with
the current tab ID and no engine override. Obvious HTTP(S) website addresses navigate
in the same tab. Favicons reuse Firefox's known tab icons.

`src/new-tab-weather.js` requests only Open-Meteo's geocoding and forecast endpoints.
Both host access and Firefox's optional `locationInfo` data consent are requested
from the Find location click. There is no automatic geolocation. The selected town
and coordinates are stored locally; location lookups send the entered place name.
Forecasts require both saved switches and permission, omit credentials/referrers,
time out after eight seconds, share pending requests and cache readings in
`tabernacle.weather.v1` for 30 minutes. The page refreshes when visible; the background
has no polling timer. Failures back off for a minute and can display labelled stale
readings. Preference changes and permission revocation invalidate pending responses.
Attribution links identify Open-Meteo and GeoNames. The integration uses Open-Meteo's
[free non-commercial endpoint](https://open-meteo.com/en/terms); a commercial release
would need the appropriate provider licence and endpoint configuration.

Run `npm run test:new-tab` for editing, previews, local search, live preferences,
responsive layout and colour modes, or `npm run test:new-tab:firefox` for native
routing, focus, default-engine search, settings, weather permissions and containers
in an isolated temporary profile. Set `TABERNACLE_LIVE_WEATHER=1` for an additional
live lookup of the test city Manchester. Preference, routing, cancellation and cache
failure tests run with `npm test`.

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
and offers newest opened (default), recently viewed, least recently viewed, oldest opened, natural title and
full tree order (pins first). Sorting changes only the projection; equal sort keys
retain tree order. The choice lasts for the sidebar session.
`openedAt` is captured at `onCreated` and persisted with tab membership. Existing tabs
without a known date follow dated tabs in tree order. Restores preserve recorded dates;
duplicates receive a new date. Viewing order uses Firefox's native `lastAccessed`.
Result titles use the tree's single-line ellipsis and row controls, including the optional
website line. The full title remains in the tooltip and accessible name. Rows expose their
original folder in a tooltip and through Show in folder; least-recently-viewed results also
expose the last-viewed timestamp in the tooltip and accessible description. Activating
a result passes `expandAncestors: false`; closing uses the single-tab action, even for
a parent. Close selection asks the live sidebar for its domain and sort,
including for native Firefox closes. It keeps Firefox's successor if still visible;
otherwise it selects the nearest remaining match above, then below. An empty list
keeps Firefox's choice. This temporary context is never stored. No fold or membership
changes are needed for this view. Dragging and fold
controls are disabled while filtering; explicit Move tab remains available.
The header's close button or Escape restores the prior scroll and selection.
The compact domain search matches titles and source URLs with the current sort.
Site headings use the full domain collection so typing does not change them.
Ctrl/Command K focuses the current view's search (domain, Later or ordinary). Escape clears a populated, focused domain field
after dismissing menus/dialogs; the next Escape returns to folders. Domain tokens
are not parsed in ordinary search. A directory-origin route retains its selected
footer button and provides Back to Domains, restoring scroll and the selected row or
nearest survivor. Pins remain listed at one matching tab, including child hosts;
zero tabs hide the entry without clearing the pin.

Run `node scripts/test-domain-filter-ui.js` for live updates, safe closing, keyboard
navigation, view restoration, favicon colours and narrow-panel/colour-mode checks, and
`node scripts/test-domain-filter-firefox.js` for native Firefox and window isolation.
Hostname, colour and ordering checks are included in `npm test`.

Retired site-enhancement preferences and Hacker News routing are ignored on load
and omitted on subsequent saves. Every domain uses standard rows and its actual
source URLs.

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

The close button, middle-click and Close tab menu item use `closeTab` with
`promoteFirstChild`: the first child takes the parent's order and the remaining
children use it as their fallback parent. Saved
ancestry keeps the closed parent's identity ahead of that fallback, so Undo
reconnects the original tree. A shared preorder preserves sibling order after
promotion and restoration. Membership changes use the existing move recovery;
failed closes roll them back when the parent is still open. A separate Close tab
and nested tabs context-menu action confirms before closing the whole branch.
Native closes keep their existing behaviour.

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
Build packages (`dist/`), test output (`test-results/`) and design experiments
(`output/`) are local, ignored files. Put mockups and their supporting files in
`output/mockups/<topic-date>/`, and one-off scripts, notes and references in
`output/scratch/<task>/`. See [`AGENTS.md`](AGENTS.md) for repository housekeeping.

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

## Benchmark reports for posting

Use the project skill **tabernacle-benchmark** (for example, “Generate a benchmark
table against the latest release”), or run:

```sh
# Node 24 from .nvmrc. Latest stable release tag versus committed HEAD.
npm run benchmark:report

# Either side can be a tag, commit or branch.
npm run benchmark:report -- --baseline v0.2.0 --candidate HEAD

# Include uncommitted extension changes only when explicitly requested.
npm run benchmark:report -- --baseline v0.2.0 --working-tree
```

`benchmark:report` uses the existing bounded optimisation harness with `--report`:
five alternating comparison pairs and matching five-pair A/A calibration (created
first if needed). It defaults to **committed HEAD**, excluding dirty files. The
ordinary `benchmark:optim` command keeps its existing HEAD-versus-working-tree,
three-pair screening defaults. `--candidate REF` selects a committed candidate for
either command; it cannot be combined with `--working-tree`.

The default old version, `latest-release`, means the highest numeric stable local
tag matching `vMAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH`. Prereleases and unrelated
tags are excluded; tag creation dates and ancestry do not determine selection.
There is no implicit network fetch. Fetch missing release tags without forcing
replacements, or pass `--baseline REF`. No matching stable tag is an error, not a
fallback to HEAD. Both sides are exported without changing the checkout. Resolved
commit IDs and extension content hashes identify exactly what ran, even if a branch
or tag later moves. The same current harness, dependencies and runtime measure both
versions; incompatible historical revisions fail visibly instead of being patched.

Each fresh `test-results/memory/iteration/run-*/` directory contains `report.md`,
`report.html`, `report.json`, logs and frozen sources. `--output DIRECTORY` requires
a new directory and never replaces previous evidence. All benchmark modes now emit
Markdown. A stopped or calibration-only run also leaves its report at the run root;
setup errors can occur before reports exist. Exit 1 is failure; exit 2 is inconclusive.

The Markdown has four columns: **Metric | Old: ref (commit) | New: ref (commit) |
Difference**. Values are medians across runs. Differences use positive, whole-number
percentages and explicit direction: for example, `Improved 93% (28 ms less time)`
for a demonstrated reduction, or `33% more time (1.429 ms more time); Investigate
regression`. Inconclusive reductions keep their existing assessment. Timing
reductions describe less time, not percentage increases in speed/throughput.
Rounding affects presentation only: 0% and 100% can represent small nonzero changes
or remaining values, and assessments still use unrounded measurements. Percentages
for zero/negative baselines and absent comparisons are N/A. Raw JSON and the full
diagnostic HTML retain signed differences.

A five-row **Headline results** table precedes the detailed tables in completed
native comparisons. Its fixed measures are idle extension-process memory, sampled
peak memory, warm tab-data reply p95, folder-action sequence time and processor
time for that sequence. These are chosen for relevance, not by the size or direction
of a change; regressions, inconclusive changes and missing values remain visible.
Headline values use compact precision and common units on both sides; percentages
and assessments still come from the unrounded results. A nearby note counts all
Firefox and synthetic regression flags, including those outside the five rows,
and explains the scope of the measurements. Synthetic-only, pilot, calibration or
incomplete runs do not produce a native headline comparison.

The detailed fixed selection covers Firefox memory, response latency, timed UI sequences,
CPU time, payloads, DOM counts and lifecycle retention, then separate Node tables
for each synthetic size with heap, timings and session API counts. Additional
regression flags outside that selection are included automatically. Full metric
sets, ranges, samples and provenance remain in the HTML/JSON. Fixture correctness
rows are not substitutes for release or upgrade tests.

Include the report's machine/runtime/workload context and measurement notes when
posting. Its relative evidence links require accompanying files or updated links
at the destination. `--pilot` is candidate-only and supplies no paired comparison;
`--synthetic-only` supplies no Firefox evidence. Neither is a substitute for a
complete comparison report. Read the measurement limits below before interpreting
numbers. This command generates local artifacts; it does not publish them.

The discoverable skill is maintained in
[.agents/skills/tabernacle-benchmark/SKILL.md](.agents/skills/tabernacle-benchmark/SKILL.md).
Only that skill file is exempted from the agent-state Git ignore rules. Benchmark
tools live in `scripts/`; the skill delegates calculations and formatting to them.

## Optimisation benchmarks

**Use `npm run benchmark:optim` for routine performance and memory work.**
`benchmark:memory` and `benchmark:memory:firefox` are aliases for this same bounded
workflow. Larger native matrices and 60,000-tab runs are exceptions for a specific
capacity question, not the default way to assess an optimisation.

```sh
# Node 24 from .nvmrc; compare committed HEAD with the current working tree.
npm run benchmark:optim

# Establish five fresh A/A pairs once for the chosen baseline and harness.
npm run benchmark:optim -- --calibrate

# Confirm a promising change with five fresh alternating comparison pairs.
# This calibrates first if no matching recent A/A report exists.
npm run benchmark:optim -- --confirm

# An explicit older commit/tag can be the baseline.
npm run benchmark:optim -- --baseline v0.2.0 --confirm

# Fast controller-only screening. This produces NO Firefox memory evidence.
npm run benchmark:memory:synthetic

# One candidate smoke run: no comparison or performance verdict.
npm run benchmark:optim -- --pilot
```

The default screen uses **three alternating pairs**, each in a fresh process and
owned temporary Firefox profile. The workload is fixed, with no automatic ramp:

- Native Firefox: **1,000 discarded fixture tabs across two real sidebars**, plus
  the control/seed tab in each window. It measures enable/idle, warm messages,
  search, one live page generating six title changes, folder moves/nesting/folds,
  sidebar closure/reopening, three view cycles and final disable.
- Synthetic controller/transport: **100 / 1,000 / 10,000 tabs**, across 1 / 2 / 9
  windows, with two readers per window. These deterministic fixtures include
  hierarchy, folders, pins, containers, Saved for Later and opaque saved fields;
  phases cover cold/warm reads, metadata, creation/closure, readers and restart.
- Every real sidebar must match the complete authoritative IDs, titles, pins and
  row order, with three stable observations before memory collection and another
  verification afterwards. The observer uses one-shot frame messages and asserts
  that DevTools is detached; it does not depend on the old debugger startup path.
- Both legacy and incremental synthetic readers retain their displayed snapshot
  across collection. Comparing a retained incremental snapshot with a discarded
  legacy full reply would bias the memory result.

Reports live under `test-results/memory/iteration/run-*/`: `report.html` provides
charts and metric medians/ranges, `report.md` provides posting tables, and
`report.json` contains every sample, phase,
work count, source fingerprint, fixture fingerprint, runtime, machine and guard
observation. Native measurements include extension-process resident/unique memory,
heap allocation before and after GC/CC, the difference from the same profile with
Tabernacle disabled, process CPU time, reply latency/bytes, DOM counts and lifecycle
retention. One-second OS RSS samples capture an approximate extension-process peak;
the independent watchdog also records the aggregate owned-process peak.

Baseline and candidate sources are frozen before launch. `--baseline REF` defaults
to HEAD; the candidate includes tracked and non-ignored untracked extension files
from the working tree, including uncommitted changes. Ignored local files do not
enter the export. Fingerprints identify actual contents; a commit name alone does
not describe an uncommitted candidate. The harness is checked for changes during
measurement. Do not edit benchmark code or run other test loads concurrently.
`--output DIRECTORY` chooses a fresh evidence directory and refuses to overwrite an
existing directory. `--noise REPORT_JSON` supplies an explicit calibration.

A/A calibration contains **five complete same-source pairs**. It is cached for
24 hours only when baseline contents, harness/dependencies, fixture, Node/Firefox,
machine and native/synthetic mode match. Changing benchmark code invalidates the
cache. Screening without matching calibration still records useful raw measurements
and deterministic work counts, but labels timing/memory differences uncalibrated.
It never calls a three-pair screen a demonstrated improvement.

A promising timing/memory improvement must reduce the metric by more than 10% and
three times the full A/A range, with the same direction in every paired sample.
Five-pair confirmation is required before the report says “demonstrated improvement”.
Investigate regressions above both thresholds. Stable deterministic read/write/work
counts are assessed separately. Inspect all relevant metrics and run the affected
functional suites before keeping a change; an improvement in one metric does not
cancel a regression elsewhere. After five additional inconclusive pairs, record no
demonstrated improvement. There are no universal millisecond or RAM pass thresholds.

The iteration guard runs **outside the WebDriver queue**, requires normal macOS
pressure and at least 30% pressure-free memory, and stops at **4 GiB aggregate
owned-process RSS**, critical pressure, three readings below 20% pressure-free
memory, 60 seconds without progress or five minutes per worker. The entire command
has a 30-minute budget. One-second sampling permits a small overshoot. These limits
can only tighten the older 4 GiB/30-minute ceilings. Resource stops preserve partial
results, stop the batch and exit 2 (inconclusive); correctness failures exit 1. No
automatic retries, larger runs, app closures or raised limits are allowed.

The routine RSS cap was explicitly raised from 3 to 4 GiB following an operator-requested
review of the 16 GiB MacBook Air: approximately 7.9 GiB physically free, 80% reported
pressure-free memory and no swap in use. This matches, rather than raises, the existing
hard ceiling; pressure and time guards remain unchanged. Close unnecessary applications
before measurements and avoid memory-cleaning utilities during runs. This headroom does
not guarantee completion: resource stops remain inconclusive, not grounds for automatic
retries or further limit increases. The harness change invalidates previous A/A calibration.

Interpret the metrics separately. Node heap includes fixtures and readers and is
**not Firefox RAM**. The control extension keeps the shared extension process alive
for off/on/off attribution; its fixed overhead is included in absolute process RAM.
The first enabled idle memory sample precedes enabled GC/CC; later phases have
previous collections in their history. Collected heap measures retention, not
natural settled RAM. Whole-browser resident sums can double-count shared pages.
Neither sampled RSS peak is an exact allocation peak, and process CPU totals may
omit exited processes. UI settlement timings have a 200 ms stability-observation
floor. Mostly discarded tabs with fallback icons do not model heavy websites,
extensive favicons or an everyday profile full of other extensions.

The maintained native smoke suite `test-memory-benchmark-firefox` is registered in
the release QA catalogue (unsupported platforms report inconclusive, not passed); policy/report/watchdog/retention tests run in `npm test`.
This benchmark supplements the existing navigation, drag, Find, recovery, upgrade,
container and other regression suites. It does not replace them or prove capacity,
complete browser-restart persistence, hidden-window behaviour or leak freedom.

### Iteration harness validation, 18 October 2026

The first confirmation compared `v0.2.0` (`7058ca6`) with the unchanged `optim`
production source (`cd4ec8d`; extension fingerprint
`a01406a00c6e1f7ccdcf809c4577cd1b778db2646bed63ae6362bbbfb7d5668d`).
Ten A/A and ten A/B native samples all completed, alongside their synthetic cases.
Native workers took 30.7–33.3 seconds; the full calibration plus confirmation took
11 minutes 25 seconds. Aggregate owned RSS peaked at **2.44 GiB**, below the new
3 GiB limit, with pressure-free memory at least **53%**. This gives an expected
three-pair screen of roughly three to four minutes, or a much shorter synthetic-only
screen; calibration is reusable when its context matches.

The smaller fixture still detected meaningful differences: median added unforced
extension resident memory **99.04 → 58.03 MB**, added collected extension heap
**48.56 → 17.80 MB**, and warm snapshot replies **25 → 1 ms**. It also flagged
tradeoffs: closed-sidebar added collected heap **2.38 → 2.85 MB**, 100-record Node
cold reads **4.17 → 5.65 ms**, and 10,000-record retained Node heap **55.05 → 63.15 MB**.
These validate that the harness exposes both gains and costs; they are not new
production changes or a blanket regression pass for the branch. MB here is decimal.

Evidence: `test-results/memory/iteration/run-rlC803/report.html` and `report.json`,
with all five A/A pairs under `calibration/`. Harness fingerprint:
`b7d184b6ab9231ee0d2a18b6a365ef58b12dc4a5e2e57205e2cb69c39ee4fa95`.
The registered native smoke suite also passed in 32.6 seconds, and the default
three-pair synthetic-only screen completed in 8.9 seconds. `npm run check` passed
542 tests plus formatting and lint. The generated report passed desktop/mobile
layout and data-label checks. No 60,000-tab benchmark or native capacity ramp was
needed for this validation.

### Allocation and retention follow-up, 18 October 2026

Three small changes were retained independently on `optim`, using Node 24.19.0,
Firefox 158.0, fresh matching five-pair A/A calibration and five comparison pairs
for each immediate baseline. The established iteration workload and guards were
unchanged. Counts below come from five alternating targeted probe pairs; they do
not describe all allocations or Firefox RAM.

| Change (baseline → retained commit)                      | Supported benefit                                                                                                                                                                                                                   | Limits and regression review                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity comparison shortcut (`60213f4` → `4a1fb1f`)     | Presenting 1,000 unchanged containerless rows in a fresh array: 2,000 comparison WeakMaps → 0.                                                                                                                                      | No demonstrated native timing/memory change. Closed-sidebar CPU 9.62 → 12.63 ms remained within the 4.22 ms A/A range.                                                                |
| Share native position indexes (`4a1fb1f` → `f664bb1`)    | Two cold window reads with 1,000 tabs: four duplicate controller maps / 2,000 inserted entries → zero. Node create/close sampled heap 27.03 → 18.09 MB met confirmation thresholds.                                                 | Native RAM/timing unchanged within calibration. Node 10k retained cold heap 63.15 → 62.63 MB and reader-closed heap 44.00 → 43.48 MB were smaller but below the 10% memory criterion. |
| Release obsolete close snapshots (`f664bb1` → `a64f02e`) | After a fresh state and completed correction, one obsolete transition snapshot and its N-entry tab array → zero, at 100/1,000/10,000 tabs; WeakRef collection confirmed release in both close event orders and ordinary activation. | No demonstrated Firefox RAM/timing change. An initial warm-reply p95 review flag (1 → 2 ms) did not repeat in five additional pairs: every baseline/candidate p95 was 2 ms.           |

All relevant metrics were reviewed, including reader closure, view cycles, final
disable and controller disposal. No material regression remained after the bounded
follow-up. Close cleanup's closed-sidebar collected added heap was 2.863 → 2.877 MB
initially and 2.849 → 2.848 MB in the follow-up, illustrating why the targeted retention
benefit must not be presented as demonstrated native RAM savings. Small-session cold
reads remained around 5.6–5.8 ms. These changes do not resolve or fully explain the
earlier published-to-branch tradeoffs; index sharing only trims part of the synthetic
retained-heap increase. MB is decimal; sampled Node heap is not an exact peak.

Each retained change passed `npm run check` (543, 545 and 548 tests respectively)
and its affected registered UI/native suites. Coverage included metadata refresh,
ordering/filtering, dragging, containers, disposal, close/undo, keyboard navigation,
native Find and published-version upgrade with interrupted move/retry and delayed
restore. Upgrade/reload coverage does not prove a complete Firefox restart. An
initial core QA run mistakenly used the scratch runner's 3 GiB benchmark cap and
stopped inconclusively; the user authorised the documented 4 GiB functional QA guard,
and core QA passed at that limit. Iteration benchmarks stayed at 3 GiB throughout.

Rejected after inspection, without new benchmark claims: sharing writable reader
arrays would alias older snapshots; clearing all close-selection state when a
sidebar closes would lose state needed by native close behaviour. Broader snapshot
ownership changes need a separate design. Do not repeat the earlier discarded
viewport, lazy-favicon or eager-projection experiments without new evidence.

Evidence is under `test-results/memory/optim-2026-10-18/`: `identity-resume-confirm/`,
`index-confirm/`, `close-confirm/` and `close-followup/` contain reports; their matching
calibrations are recorded in each report. `identity-counts.json`, `index-counts.json`
and `close-counts.json` contain targeted probes. The `identity-*`, `index-*` and
`close-*` check logs and suite reports preserve functional results. Investigation
notes and probe sources remain in `output/scratch/optim/iteration-2026-10-18/`.

## Exceptional stress testing

Use these commands only when investigating a specific high-capacity question or
when explicitly doing the broader stress/release checks. Routine optimisation uses
the iteration benchmark above. The low-level legacy scripts also require `--stress`
so directly invoking an old command cannot silently start 60,000 tabs.

```sh
# Synthetic capacity fixture: 60,000 tabs, 28 windows, two readers per window.
npm run benchmark:memory:stress

# Older extended native harness: starts at 100 tabs, never at 60,000.
npm run benchmark:memory:firefox:stress
npm run benchmark:memory:firefox:stress -- --tabs 1000 --windows 2
```

The legacy commands accept `--source-root PATH --baseline-root PATH --pairs 5` and
`--variation-baseline PATH`. Their different workload and debugger observer need
their own A/A evidence; never mix them with iteration results. Native capacity work
ramps through 100 / 1,000 / 5,000 / 10,000 before any larger run, stopping when a
guard fires. It retains the existing **4 GiB**, normal-pressure/30%-free preflight,
20%-free sustained stop, 60-second no-progress, ten-minute stage and thirty-minute
run limits. Larger runs are not evidence that Firefox supports 60,000 tabs. Keep
experiments under `output/scratch/optim/` and measurements under
`test-results/memory/`; record resource-limited stages as inconclusive.

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

For memory work on macOS, use
`TABERNACLE_MEMORY_GUARD=1 npm run qa:release -- --stress`. Each native suite waits
up to two minutes for normal pressure before its own fresh watchdog check. A
resource stop is recorded as inconclusive and leaves the overall gate nonzero;
it is never counted as a pass. Per-suite guard reports accompany the logs, and
the QA report records the extension source fingerprint. The ordinary command
keeps its portable behaviour on other platforms.

The catalog in `scripts/qa-suites.js` also drives `test:ui` and `test:firefox`. A unit test
checks that every maintained browser suite is registered, so adding a test cannot
silently leave it outside release QA. Native integration suites and stress share
`scripts/firefox-session.js`; actual sidebar suites use `ScreenshotBrowser` for native
sidebar access. Both fixtures create and verify their own temporary Firefox profiles.
Playwright Chromium and Firefox must be installed before running browser checks.

`node scripts/test-upgrade-firefox.js` installs the published `v0.2.0` tag into an
owned temporary profile, creates real saved state, then replaces it with the
same-ID candidate without uninstalling or changing tracked versions. It verifies
installed resource hashes, hierarchy, durable identities, containers, mixed pins,
opaque saved fields, interrupted move recovery and delayed tab restoration.
Evidence is saved under `test-results/memory/upgrade-*/`. Replacement and repeated
extension reloads do not prove persistence across a complete Firefox restart;
the report keeps that coverage boundary explicit.

## Saved for Later

`src/later-view.js` owns the dedicated sidebar view, with `later.css` for its layout.
`src/later.js` searches native tab titles and source URLs, then sorts by the session
membership’s `savedForLaterAt` timestamp. Compact 30 px rows show a favicon and a
single-line ellipsised title, with the full title and URL in a tooltip. Search, sorting, keyboard
navigation and return/close actions operate on the current window’s saved tabs.
The view does not read page contents, cache previews or request host access.

Saving changes only `savedForLaterAt`. Folder, durable ancestry, order, native pinning
and containers remain intact. The resolved tree skips saved parents so their children
remain accessible. Saved tabs are excluded from ordinary tree/domain projections and
folder copy/close actions. Folder duplicate review includes saved items. Clearing the timestamp restores the original placement where it
still exists. Session restoration keeps saved membership; duplicated tabs clear it.

`test/later.test.js`, `scripts/test-later-ui.js` and `scripts/test-later-firefox.js`
cover persistence, restoration, folder deletion, search, close selection, keyboard
navigation, narrow layouts, colour modes and real Firefox tab/container behaviour.

### Search and collection actions

`src/tab-source.js` shares original-URL matching across tree search, domain search
and saved results. It unwraps Firefox’s native `about:reader` addresses for URL
identity without controlling Reader View or accessing page contents. `src/tab-collection.js` derives folder-scoped saved search,
duplicate keys, keeper suggestions, reviewed target identities and search close order.
Saved results stay outside `createTreeIndex`; ordinary search appends a labelled
projection with folder paths. Returning a saved item retains its view and query,
and Later retains scroll and sort. The confirmation's Show in folder action is the explicit navigation route.
Folder collection and scoped Saved matching reuse the current tree's folder index.
Duplicate review builds an index per refresh for scope checks and labels; folder
batches build one per operation inside the controller queue. These operations add no
cross-snapshot cache; live membership/keeper validation remains before every write.

`src/tab-batch.js` runs inside the controller's serialised request queue. The internal
`saveTabsForLater`, `undoSaveTabsForLater`, `closeTabSet` and `closeDuplicateTabs`
actions return a refreshed snapshot with `batchResult.completed`, `skipped`, `failed`
and guarded `undo` targets. Every reviewed target captures the native ID, durable
identity, source URL, folder, container and saved timestamp. Membership/window/URL
and collection scope are rechecked before each write. Reviewed closes check native
selection for every target; only an active target needs the full before/after
selection state. Inactive closes avoid rebuilding the window between removals.
Both paths still validate immediately before removal, including after collecting
active-close selection state. Query changes and missing duplicate keepers can skip
stale targets. Validation uses native tabs and saved memberships.

Batch timestamps descend in displayed order, newer than prior saves. Undo clears
only the recorded saved memberships and timestamps; native tabs, containers, pins,
page state and placement stay intact. Batches never discover new targets.
Unselected descendants survive closure; ordinary single-tab promotion is unchanged.

`src/collection-dialogs.js` reuses the existing modal shell. Exact duplicate groups
use the full HTTP(S) source URL plus container, keeping parameters and fragments.
Protected copies start unselected; other groups retain the newest viewed copy, with
native order resolving ties and missing times. Review selections only lose invalid
candidates during refresh, never gain new tabs. The submit action requires a keeper
per group, and the controller revalidates a reviewed keeper before each close.
All queries, directory origins and review selections remain temporary.

`test/tab-collection.test.js` covers projection ordering, Reader URLs, exact duplicate
keys, protected keepers, stale targets, partial failure and guarded undo. The registered
`scripts/test-tab-collection-ui.js` covers combined flows, stable review, keyboard
focus, all colour modes at 220/320/480px and offscreen batches. Its Firefox counterpart
covers native saved-result close selection, containers and session restoration.

## Snapshot and cache contracts

Controller requests share one serial queue. Membership loading uses an ordered,
settled pool of 32 reads; failures still wait for outstanding work before the queue
advances. Existing repair batching, closure verification and recovery own writes.
Native window caches coalesce allowlisted metadata patches until read, preserving
earlier arrays. Structural tokens survive those patches but change for navigation,
structural events, unknown properties and explicit native writes. Membership epochs
are scoped to known windows; unknown ownership invalidates conservatively. Folder
resolution depends on valid folder IDs, independently of unrelated preferences.
Forward and reverse identity indexes publish after reads and repairs settle, with
global duplicate checks and retries for stale structural reads.

`controller.request()` returns detached, writable results. The background alone
chooses `requestForTransport()`, which shares immutable plain presentation records
through the same handlers and queue; Firefox messaging supplies the receiving copy.
Frontend message fields cannot change the in-process request contract. Unknown
nested native values are preserved. Structured-clone types that cannot be safely
shared as immutable records take a detached, uncached fallback instead.
Resolved and close-selection caches reuse owned immutable presentation rows, avoiding
a second complete set of derived records. Adoption never mutates borrowed arrays
or revives an invalidated request cache. Owned records must not become cache keys
pointing to newer versions: holding an old snapshot must not retain a chain of
subsequent container updates.

The optional snapshot protocol keeps its token envelope and full-response fallback.
Sidebar, Activity and New Tab readers can consume deltas, while legacy callers
receive full replies. Each retained base holds only window ID, generation, tabs and
last-used time. The encoder caps retention at 128 bases and 250,000 tab references,
evicts oldest entries first and expires five-minute idle entries on later activity.
These are reference limits, not RAM limits; no timer or persistent connection is
added. Window removal releases owned temporary state, preserving records belonging
to surviving windows. Controller disposal waits for queued work and clears owned
maps; late completions cannot repopulate disposed caches.

## Refresh and folder indexing

`src/refresh-scheduler.js` coalesces notifications, filters window IDs and skips revisions
already included in a response. A new background generation resets revision comparison.
Only one refresh runs at a time. Settings, Activity, New Tab and sidebar notification
reads defer while the document is hidden. A visible but unfocused sidebar still
refreshes. Sidebar refreshes also pause during pointer gestures and queued actions.
Visibility restoration catches up from current state; explicit actions and recovery
reads still complete. Hidden or pending-render sidebar close-selection responses
supply query, scope and sort without stale displayed IDs. These responses must never
request another controller snapshot: the controller is already waiting for them
inside its serial queue. Settings merge preferences around dirty fields, preserving
unsaved edits.

`src/folder-index.js` builds folder lookup, child order, ancestor ranges and inherited
container/colour information once per render. The sidebar tree index and both folder
pickers share it. Indices are rebuilt from the current snapshot to avoid stale defaults
after in-place edits or moves. Traversal and picker construction are iterative. Folder
indexing supports deep inputs, but deeply nested sidebar DOM can still incur browser
layout costs; the index does not virtualise the sidebar.

`src/tree-projection.js` describes the complete scoped hierarchy separately from
visible navigation. Folded descendants remain addressable without keeping a record
for every hidden row. Established search, domain and Saved for Later helpers remain
authoritative for ordering and collection actions; the controller revalidates action
targets. The renderer exposes update, ensure-visible, capture/restore, suspend and
dispose operations. It retains the existing row builders, nested wrappers and motion
reconciliation, with every currently visible logical row mounted even below the
viewport so native Firefox Find can discover it. Sidebar restoration uses scroll
anchors only; pane callers own focus, including `restoreFocus: false`.

Opening Later or Domains releases the inactive tree's rows, wrappers and indexes.
Closing either pane releases its derived rows and state. Returning rebuilds from
current data and restores scalar keys, query, sort and scroll references. Activity
and New Tab also release hidden results and snapshot bases, except while a
noncollapsed native Find or user selection intersects the results. This exception
keeps selected text connected; page disposal always clears derived state. Generation
checks reject late results, while already-started operations finish their established
recovery and result handling.

Tree, Later and Domains delegate suitable row interactions from persistent roots
using stable IDs and current containment checks. Pointer capture and continuous
gesture handlers keep their established ownership; favicon error handlers remain
per image. New Tab builds one requested-hostname icon lookup per render, preserving
the first matching tab even if it has no favicon.

The shared modal clears callbacks, captured context and child content on closure.
An in-flight submit owns its completion callback and disabled-control batch: a late
old response cannot close, disable or refocus a replacement modal. Failed submissions
retain their action for retry; page disposal blocks later UI continuation.

## Optimisation results: 17 October 2026

The `optim` programme starts at `9aabf41`. The final production commit is `9b2bcbc`;
its 111-file extension fingerprint is
`091427df671e32eb8611588b36c52bad9d6d8cac9aec61387bcd8f78d781e0b6`.
The opening branch fingerprint is
`2ae1a37d49a66ab7d3082b0fb672f40f84e0b89843cb351c3a36f0ec82ade9d1`;
the separately extracted published `v0.2.0` (`7058ca6`) fingerprint is
`1987f5d8d1771564aeb2eee6af2819d00de209095329759360d63650c722c3d1`.
The version, add-on identity, permissions, storage keys and saved formats are
unchanged. These are local development results, not a capacity or release promise.
These raw-export fingerprints include the ignored `extension/.DS_Store` present
in the frozen local sources; a clean Git checkout need not reproduce the same
raw-directory hash. The file remains untracked and is not a shipped asset.

Measurements used Node 24.19.0, Firefox 158, an eight-core Apple M1 with 16 GiB RAM
and Darwin 27.0.0. Synthetic fixtures use seed 17. Reports record exact source,
fixture, runtime, machine and harness fingerprints. Five fresh alternating pairs
follow five fresh matching A/A pairs. Review thresholds remain both 10% and three
times the matching baseline range; an absence of flags does not mean zero cost.

### Synthetic results

The final matrix passed 17 scenarios spanning 100, 1,000, 5,000, 10,000 and 60,000
tabs; 1/2/8/9/28 windows or readers; multiple readers per window; flat, realistic,
deep-tab and deep-folder shapes; pins, containers and Saved for Later. Hard
assertions cover complete collection sets, durable model/membership preservation,
32 concurrent membership reads, zero warm reads, bounded transfer retention,
restart fallback and empty owned caches after disposal. Separate unit and browser
suites cover exact hierarchy/order, repair, recovery, concurrent events, rejected
operations and upgrade behaviour.

The five sizes each have a completed A/A and opening-branch comparison. A separate
1,000-tab published-tag A/A/comparison brings the total to 120 fresh measurement
workers, plus 17 matrix workers. No final opening-branch comparison from 1,000
through 60,000 tabs crossed both review thresholds. All individual samples,
ranges and flags remain in
`test-results/memory/final-synthetic-2026-10-17T16-51-56.817Z-ZqgOZ4/`.
Its `compact-results.json` contains every phase, and `summary.json` preserves
source/harness identities and guards. This directory and other raw reports are
local ignored evidence, not files distributed with the extension.

At 60,000 tabs across 28 windows, with two readers per window, median timings and
five-sample ranges were:

| Phase              | Opening branch, ms [min, max] | Final candidate, ms [min, max] |
| ------------------ | ----------------------------: | -----------------------------: |
| Initial readers    | 2,042.23 [2,029.46, 2,216.53] |  1,701.49 [1,688.82, 1,739.07] |
| Unchanged readers  |       772.73 [747.91, 803.44] |           49.28 [47.29, 53.01] |
| Metadata burst     |       799.36 [786.49, 814.02] |           54.46 [53.92, 63.83] |
| Create/close burst | 1,523.67 [1,505.62, 1,578.81] |      889.78 [830.43, 1,204.30] |
| Reopened readers   |       756.76 [751.81, 796.15] |        796.06 [775.96, 841.69] |
| Background restart | 1,928.72 [1,913.49, 1,949.48] |  1,733.70 [1,688.13, 1,756.01] |

These timings include fixture validation, JSON byte estimation and simulated
`structuredClone` messaging. They do not measure Firefox IPC or DOM rendering.
Peak concurrent membership reads fell from 60,000 to 32. All 56 unchanged second
replies were deltas, reducing estimated JSON bytes from 84,721,365 to 101,234 in
every pair. The matrix retained 56 bases/120,000 references, then 112/240,000 after
reader resets, within the unchanged 128/250,000 limits.

Whole-process retained Node heap after requested GC increased at this size:
initial readers 312.37 [312.29, 312.94] to 324.69 [324.64, 324.77] MiB (+3.94%);
closed readers 199.40 [199.33, 199.97] to 215.79 [215.75, 215.88] MiB (+8.22%).
Sharing resolved records removed roughly 18 MB from the preceding candidate and
resolved its three cumulative heap flags, but does not establish lower retained
heap than the opening branch. The cold-phase sampled maximum also increased,
434.14 [428.15, 442.04] to 450.21 [447.12, 450.37] MiB (+3.70%). The all-phase
sampled maximum fell from 962.57 [909.10, 962.66] to 649.19 [648.89, 649.71] MiB
(−32.56%). That last result is neither a startup reduction nor an exact peak.
`final-counters-and-peaks.json` preserves the separate measurements.

The initial 100-tab cold comparison flagged 5.1113 to 6.2936 ms (+23.13%) against
the A/A range of 0.349124 ms. Exactly five additional pairs using that same A/A
gave 5.5462 to 5.8623 ms (+5.70%), below both thresholds. All ten comparison pairs
and the original A/A remain in `cold-100-repeatability.json`; no outliers were
removed or replacement noise estimate used. The beyond-noise regression did not
consistently repeat. Small-session cold-start timing remains inconclusive, with
no claimed improvement.

Seven retained-heap flags remain in the published-tag comparison. Historical
attribution in `release-attribution.json` shows that most of the increase predates
this programme: at 1,000 tabs, cold retained heap is 9.13 MB for the published tag,
12.17 MB for the opening branch and 11.84 MB for the candidate. Closed-reader heap
is 9.51/10.64/10.76 MB respectively. This triangulates separate paired runs, not a
fresh direct published-to-opening measurement. The release flags are preserved;
the programme does not claim lower retained heap than the published extension.

### Native memory results at programme completion

Five A/A pairs and five alternating opening-branch/candidate pairs completed in
Firefox 158 at 100 fixture tabs across two actual sidebar windows (102 native tabs
including control tabs). The settlement harness fingerprint was
`25a744fba5589f3addf3bf7d3fa9b5ecfa07be2d27c0553da123039b8219bc37`.
All 260 recorded phases passed, including authoritative tab IDs, row order, titles
and pins, search, title bursts, visible unfocused and minimised windows, closing and
reopening sidebars, and membership preservation after extension reload. None of
the original elapsed/collected-resident metrics crossed both review thresholds;
no total Firefox resident-memory improvement was demonstrated. The follow-up below
also examines process heap and pre-collection costs in these preserved reports.

Selected collected Firefox resident sums, in decimal MB, were:

| Phase             | Opening branch median [min, max] | Final candidate median [min, max] | A/A range |
| ----------------- | -------------------------------: | --------------------------------: | --------: |
| Warm snapshots    |    1,532.43 [1,530.28, 1,534.49] |     1,534.28 [1,533.72, 1,582.50] |     90.06 |
| Live title burst  |    2,377.30 [2,340.65, 2,379.79] |     2,377.24 [2,343.50, 2,379.33] |    117.51 |
| Sidebars closed   |    1,546.45 [1,511.74, 1,551.07] |     1,546.50 [1,511.21, 1,549.89] |    119.78 |
| Sidebars reopened |    1,562.08 [1,522.19, 1,610.29] |     1,560.72 [1,525.47, 1,561.95] |    117.70 |

These sums cover isolated Firefox processes, not just extension ownership.
Maximum watchdog-owned process RSS across the completed runs was 3,140,780,032
bytes; minimum pressure-free memory was 46%. DevTools attachment also affects
natural background sleeping. All phase durations, resident samples, ranges,
original A/A variation and guard records are retained under
`test-results/memory/final-native-v2-nZDx0S/`; `compact-results.json` indexes them.

The 1,000-tab/two-window pilot stopped at DevTools connection during launch after
63.224 seconds, with 60 seconds without reported progress. It created **zero**
fixture tabs and produced no measurement phases. Peak owned RSS was 2,164,031,488
bytes and pressure-free memory 48%, so the 4 GiB cap was not responsible. The ramp
stopped without retry or changed limits. At programme completion, native memory at
1,000/5,000/10,000 and larger sizes remained unmeasured; this startup stall
establishes no tab capacity limit. Earlier startup stalls and partial reports remain
inconclusive. The separately requested follow-up resumed testing as described below.

### Native memory follow-up, 17 October 2026

**There is a repeatable reduction in retained extension-process heap after closing
sidebars and forcing collection, but no demonstrated reduction in total Firefox
resident memory.** The fresh 1,000-tab/two-window comparison completed. The next
5,000-tab/eight-window pilot reached the unchanged 4 GiB guard, stopping the ramp.
The extension source remains `091427df…`; this follow-up changed only test logging
and documentation.

Commit `8ee17dd` splits the existing `CommandsFactory.forAddon` and
`targetCommand.startListening` awaits with a completed-stage log. Inspection of the
installed Firefox 158 sources traced the first wait through local client creation,
the add-on descriptor, a hidden fallback browser and its navigation; the second
wait covers target/resource listeners. The old logs cannot identify which wait
stalled. The fallback listener is installed before navigation, so inspection did
not demonstrate a listener-after-navigation race. No root cause or fix is claimed.
All 32 fresh follow-up launches connected: ten launch-only probes, one 1,000-tab
pilot, twenty paired workers and the later resource-limited 5,000-tab pilot. No
retries, polling heartbeats, longer timeouts or replacement DevTools target were
introduced. A future recurrence can now distinguish the two waits. Source excerpts,
module hashes and a deeper diagnostic field map are retained under
`output/scratch/optim/devtools-startup/`.

The extra WebDriver round trip changes the harness fingerprint to
`c1c739cd66493949a798875cddb6f176d313b5faa6b60902c136acab99187e86`, so the 1,000-tab
comparison uses fresh five-pair A/A variation and five alternating
opening-branch/candidate pairs. All twenty workers completed all thirteen phases;
native IDs, titles, pin and row order, visibility, search, close/reopen and reload
checks passed. Maximum watchdog-owned RSS was 3,424,387,072 bytes (3.19 GiB), and
minimum pressure-free memory was 45%. Runtime, machine and fixture were Firefox
158.0, Node 24.19.0, Apple M1/eight cores/16 GiB, Darwin 27 and seed 17. The baseline
was the opening branch `9aabf41`, not the published tag.

Selected results use decimal MB and medians [minimum, maximum]. A/A variation is
the full observed range for the same phase, collection state and metric:

| Phase and metric                                          |                   Opening branch |                        Candidate | A/A range | Interpretation                                                   |
| --------------------------------------------------------- | -------------------------------: | -------------------------------: | --------: | ---------------------------------------------------------------- |
| Warm, collected total Firefox resident                    | 1,735.295 [1,705.181, 1,763.017] | 1,734.836 [1,704.002, 1,753.121] |    76.399 | No demonstrated improvement                                      |
| Warm, collected extension-process heap                    |       107.064 [106.829, 107.532] |       105.995 [105.777, 106.097] |     0.994 | Difference below 3× A/A range                                    |
| Closed, before current collection, extension-process heap |          50.570 [50.443, 50.619] |          54.371 [54.186, 54.786] |     0.457 | **+3.800 MB (+7.51%); higher in all five pairs**                 |
| Closed, collected extension-process heap                  |          32.464 [32.331, 32.510] |          18.451 [18.304, 18.525] |     0.524 | **−14.013 MB (−43.16%); lower in all five pairs, beyond 3× A/A** |
| Closed, collected partial DOM/style reporters             |          10.703 [10.703, 10.703] |             0.595 [0.595, 0.595] |     0.000 | −10.107 MB (−94.44%); lower in all five pairs                    |
| Closed, collected total Firefox resident                  | 1,645.937 [1,563.263, 1,686.209] | 1,636.696 [1,541.423, 1,664.418] |   122.716 | No demonstrated improvement                                      |

No new 1,000-tab metric crossed both regression thresholds (>10% and >3× A/A),
but the pre-collection heap cost is real and must not be hidden by that threshold.
Retrospective analysis of the preserved 100-tab reports found the same approximate
absolute cost: closed-sidebar pre-collection heap increased 20.151 → 24.005 MB
(+19.12%, A/A 0.463 MB); reported explicit categories increased 29.753 → 34.013 MB
(+14.32%, A/A 0.293 MB). Both cross the thresholds at that size and remain recorded.
This analysis does not establish their allocation source or resolve those flags.

The 5,000-tab/eight-window pilot connected DevTools in its 2.557-second launch and
created all 5,000 discarded fixture tabs. It stopped during membership seeding,
before populated-sidebar settlement or memory comparison, after 106.383 seconds.
The first over-limit sample was 4,373,463,040 bytes (4.07 GiB); minimum pressure-free
memory remained 42%. The one-second watchdog sampling explains the small cap
overshoot. Its teardown connection error followed the guard termination, not a
startup stall. The owned processes were cleaned up. This is a **resource-limited,
inconclusive run**, not a comparison or correctness failure. No further 5,000-tab
pairs or 10,000/20,000/40,000/60,000-tab native runs were attempted after that stop.

All reports, individual samples and the separately audited process summary are in
`test-results/memory/devtools-startup/`; `report.md` provides the evidence index.
The frozen offline analysis script SHA-256 is
`9cd108964f629eae3be28479aa8fa99878ba3bd331d2fd3120bc1b7ba32ca35f`.
It checks exact source/harness/runtime/fixture matches and one-to-one process PID
coverage before summing resident reporters. Partial DOM/style categories and heap
overlap; do not add them. Extension-process measurements include Firefox/DevTools
overhead and all extension documents, not exclusively Tabernacle-owned bytes.
Resident sums may include shared pages. Reported explicit categories omit the
computed `heap-unclassified` value and are not complete about:memory explicit usage.
Before-collection means before the current phase's collection, after any earlier
phase collections; these are not untouched natural-lifetime measurements. The
headless, discarded-tab/actual-sidebar fixture and attached DevTools do not prove
natural desktop background sleeping or loaded-page memory. Whole-run sampled RSS
includes Node/geckodriver and is neither an exact peak nor a startup-only measure.

`npm run check` passed all 529 tests after the logging change; the completed native
follow-up validates the same helper. Production bytes remain those of the passing
57/57 final release QA below. No new production change or publication was made.

### Main-versus-optim decision report

The subsequent branch comparison verified every tracked extension file on local
`main` (`9aabf41`) against the frozen opening baseline: all 106 matched byte for
byte. The assessed `optim` HEAD was `be10def`, with the unchanged `091427df…`
extension fingerprint. The earlier completed paired results therefore compare
these exact branches. They are reused with their original matching A/A sets,
runtime/source hashes and samples, not presented as newly completed runs.

The illustrated report is `test-results/memory/main-vs-optim/report.html`, with
standalone PNG/SVG charts and validated samples in `decision-data.json`. At 100
tabs/two open sidebars after collection, main/optim extension-process allocated
heap is 29.64/29.68 MB and unique resident memory 73.55/75.66 MB. At 1,000 tabs the
corresponding values are 107.06/105.99 MB and 181.49/177.70 MB. These are process
footprints including Firefox/DevTools overhead, not exclusive add-on allocations;
the metrics overlap and must not be added. No completed no-extension control
establishes the exact RAM cost of installing Tabernacle.

Per-run medians of the four subsequent native snapshot replies are 1 → 1 ms at
100 tabs and 3 → 1 ms at 1,000 tabs. First full replies are 6 → 6 ms and 34 → 33 ms.
The latter differences and search-with-settlement differences are within noise.
Native timers have coarse resolution. Synthetic warm work across all readers is
roughly 11–16 times faster at 5,000–60,000 tabs, but the 100-tab saving is only
0.42 ms. These ratios are not whole-browser speedups.

The new 100-tab A/A attempt completed seven workers, then stalled in
`CommandsFactory.forAddon` on main before target listeners or fixture creation.
The unchanged no-progress guard stopped it after 63.286 seconds; peak owned RSS
was 2,187,870,208 bytes, minimum pressure-free memory 44%. This incomplete batch
is preserved and not scored. A separate diagnostic, collecting UUID-matched
explicit reporter leaves in owned synthetic profiles, completed main/100 tabs:
17.41 MB after collection with sidebars open, including 15.85 MB in sidebar paths
and 1.14 MB in background paths. This is only a reported subset. Its optim/100
launch stalled at the same boundary and stopped after 63.272 seconds with zero
fixture tabs; no paired attribution or 1,000-tab attribution result is claimed.
No guard was changed, no incomplete batch was retried, and no larger native run
was restarted. Owned browser processes were verified to have exited.

The recommendation is to retain the branch as the base for focused investigation:
large-session repeated work and closed-view cleanup are useful improvements, while
open-view RAM is not demonstrably reduced. The approximately 3.8 MB pre-collection
closure cost remains unresolved, including its 100-tab regression flag. The next
memory target should follow measured live-sidebar and JavaScript allocation
ownership. The report's good/poor assessments concern these specific goals; no
competing extension or universal memory threshold was benchmarked. The production
source and prior functional QA remain unchanged.

### View and lifecycle evidence

Adjacent-source five-pair checks measured the intended work reductions. These
counts establish reduced ownership or work, not equivalent RAM savings:

| Change                                            | Before → after                                                       | Local evidence under `test-results/memory/`                 |
| ------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Coalesced metadata                                | 4,000 array copies → 1 on the next read                              | `metadata-before-{1..5}.json`, `metadata-after-{1..5}.json` |
| Inactive tree / closed pane                       | 9 → 0 / 3 → 0 retained rows; tree restores 9                         | `ui-lifecycle-counts/report.json`                           |
| Hidden notification reads                         | 1 → 0; exactly one catch-up; visible unfocused still refreshes       | `ui-visibility-counts/report.json`                          |
| Tree / Later / Domains row interaction listeners  | 81/21/6 → 0; persistent root additions 6 → 19 remain stable          | `ui-listener-counts/report.json`                            |
| Pointer disposal                                  | Pending frame, timer and 11 listeners → 0, no late callbacks         | `pointer-disposal-counts.json`                              |
| Closed dialog captured targets                    | 60,000 → 0 callable targets                                          | `dialog-retention-current.json`                             |
| Favourite hostname lookups, 60 links / 1,000 tabs | 116,460 → 1,060 for late matches; 120,000 → 1,060 for absent matches | `icon-index/step13-final-source-five-pairs.json`            |

Per-image fallback listeners and some specialised controls remain intentionally
local. Activity/New Tab keep hidden rows when native Find or user selection needs
connected text, then clear them on page disposal. Native Find checks preserve the
existing behaviour; an existing New Tab first-Find-Again ordering limitation was
reproduced in both sources and is not claimed fixed.

The complete logical projection retained full rendering. Its compact version
passed five renderer pairs and matching A/A checks at 1,000 rows without crossing
both thresholds: cold synchronous rendering 101.2 → 103.2 ms, collected Chromium
V8 isolate heap 3,529,648 → 3,830,588 bytes (+8.53%). This is accepted overhead for
the requested separation of actions from rendering, not a memory saving. The heap
measure excludes native DOM allocation. Full results and ranges are under
`renderer-step14-compact-2026-10-17T15-55-14.234Z/`; the earlier, more expensive
projection was discarded.

Viewport rendering was rejected at its compatibility prerequisite. In an actual
Firefox sidebar with 1,000 injected logical rows, mounting only 30 rows gave zero
native Find matches for the last row; full DOM gave one. The experiment did not
create 1,000 native tabs or establish a 5,000-row memory reduction. Full rendering
remains shipped, with no user-facing mode or cap. Evidence:
`native-viewport-find-1000.json`.

Lazy/async favicon hints were also rejected. Ready offscreen icons fell from 164
to 1–8, but after-scroll readiness rose from 9 to 33 ms, exceeding both thresholds
against the matching 3 ms A/A range. Existing supplied icons and fallback behaviour
remain; only the favourite hostname index shipped. `native-favicon-final.json`
and `native-favicon-aa-retry.json` preserve the samples. Data-URL fixtures establish
no network saving.

### Final regression gate

`TABERNACLE_MEMORY_GUARD=1 npm run qa:release -- --stress` passed **57/57** checks
on the final `091427df…` source: formatting/lint and 529 unit tests, all 39 UI
suites, all 15 native Firefox suites, the native stress workload and an unsigned
build. The report is
`test-results/release-qa/2026-10-17T17-06-48.888Z/results.json` with individual
logs and guards alongside it. The source fingerprint was unchanged afterwards.
All 16 guarded native/stress suites completed, with maximum owned-process RSS
3,709,485,056 bytes and minimum pressure-free memory 44%.

The stress suite passed at 100/500/1,000 real tabs, including a depth-30 branch,
20 live update-generating pages, search, containers, close operations and extension
reload. This functional stress gate does not replace the interrupted multi-window
native memory ramp or establish a supported 60,000-tab capacity.

The final upgrade suite verified installed published-tag and candidate resources,
same-ID/same-version replacement, organisation, opaque sentinels, delayed native
restore and interrupted recovery before and after further operations/reloads.
Its report is `test-results/memory/upgrade-2026-10-17T17-09-41.360Z/results.json`.
Temporary replacement and extension reload do **not** prove persistence across a
complete Firefox restart. No version bump, signing, publication, push or merge
was performed.

### Further allocation experiments

The follow-up starts from `a8d6451` (extension source `e8d7f504…`) and excludes
experimental New Tab work. Experiments and individual samples are retained under
`output/scratch/optim/fundamentals/` and `test-results/memory/fundamentals/`.

Metadata refresh now compares the saved layout and metadata values directly.
A single changed title allocates one new comparison array, instead of two arrays
per tab: 2,000 → 1 at 1,000 tabs and 10,000 → 1 at 5,000. Saved values remain
independent of incoming object mutation; layout changes still trigger full
rendering. The registered performance UI suite checks allocation counts, unchanged
refreshes, in-place changes, focus and parity with full rendering.

Five fresh A/A pairs and five alternating baseline/candidate pairs completed in
actual Firefox sidebars at 100, 1,000 and 5,000 injected logical rows. These isolate
rendering; they do **not** represent that many real Firefox tabs. Runtime was
Firefox 158.0, Node 24.19.0, Apple M1/eight cores/16 GiB and Darwin 27. The frozen
candidate source was `3185d945…`; the diagnostic harness was `1cbf3830…`.
Median per-run average title-update times were 0.5625 → 0.5000 ms,
5.4500 → 4.9875 ms and 26.5875 → 24.7875 ms. Their corresponding A/A ranges were
0.8125, 0.4625 and 1.1500 ms. None exceeds the conservative three-range threshold;
**the acceptance evidence is fewer allocations, not a demonstrated timing or
Firefox RAM reduction**. No measured ordinary-workload metric crossed both
regression thresholds. At 5,000 rows, collected extension-process heap was
183.846 → 183.649 MB and total Firefox resident sums 1,507.312 → 1,504.723 MB,
both within noise. Raw samples, medians and ranges are in
`metadata-native-summary.json`. Peak owned RSS across these twenty workers was
2.08 GiB; minimum pressure-free memory was 43%. Safety limits were unchanged.

A separate ten-launch startup trace decomposed the existing DevTools attachment
without changing its target or raising timeouts. Those launches and the twenty
paired workers completed. The intermittent startup stall has **no demonstrated
root cause or fix**; the ignored trace captures the blocked internal boundary if
it recurs. It does not send progress heartbeats. No Firefox instrumentation ships
in the extension.

Removing all unused row-cache entries was rejected: preliminary five-pair
Chromium comparisons reduced folded heap by 2.3%/10.3% at 100/1,000 rows, but
repeated unfolding slowed 73.1%/76.7%, beyond the ordinary-use regression gate.
The existing row cache remains. These preliminary reports lack an explicit
Chromium runtime version and are not native Firefox memory evidence.

Activity enrichment now modifies the fresh records created for that call, rather
than copying them all again. It removes one additional object per item and a
second result array; it still preserves source data and opaque fields. A frozen
source/independent-return regression test accompanies the existing activity,
filtering, ordering, restoration and reload coverage.

Five fresh Firefox A/A and five A/B pairs used the actual Activity page through
ordinary WebDriver, without DevTools, for pure data projection at 100, 1,000,
5,000, 10,000 and 60,000 synthetic records. Full output hashes matched at every
size. At 60,000 records, per-run median time fell 125.5 → 117.0 ms, but the A/A
range was 9.0 ms: no timing gain beyond the conservative threshold is claimed.
No ordinary-workload regression crossed both thresholds. The frozen candidate
was `99b6c891…`; `activity-webdriver-summary.json` records all samples and ranges.
The matching Node 24 five-pair experiment showed a sampled peak heap increment of
455.46 → 250.43 MB during repeated 60,000-record projections (−45.0%; A/A range
48.85 MB), and average projection time 43.98 → 34.59 ms. This is transient **Node
allocation evidence, not Firefox resident memory**. Final record contents and
count are unchanged. The object-copy reduction is the cross-runtime acceptance
criterion; `activity-node-summary.json` preserves the Node results.

The first DevTools-based Activity A/A attempt stopped on its second launch at the
unchanged 60-second watchdog. Its captured trace confirms client and descriptor
completion; the fallback browser was connected, fully loaded at the expected URL
and no longer loading, while watcher creation remained pending. This narrows the
wait but does not establish why the location listener failed to settle. That run
remains inconclusive in `activity-firefox-aa.json`; fresh WebDriver measurements
use a different harness and do not reuse its samples.

The Recent Activity popup now selects native references before producing its
existing 50-item preview. It copies and parses URLs only for the newest eligible
tabs and closures, then merges them with folder activity using the original
ordering. Full Activity, search, saved records and action targets are unchanged.
The registered history tests compare bounded and full results across filters,
tied/invalid timestamps, privacy and opaque fields; they assert that a
1,000-tab preview copies 50 records while full history still returns all 1,000.
The existing popup UI suite covers the 50-item order, scrolling, filtering, focus
and restore actions.

Five fresh A/A and five alternating A/B pairs completed in both Node and Firefox
at 100/1,000/5,000/10,000/60,000 synthetic records. In Firefox, medians of per-run
average projection time changed as follows (20 observations per run):

| Records |    Before |    After | Change | A/A range |
| ------: | --------: | -------: | -----: | --------: |
|     100 |   0.30 ms |  0.10 ms | −66.7% |   0.45 ms |
|   1,000 |   2.15 ms |  0.40 ms | −81.4% |   0.30 ms |
|   5,000 |  11.75 ms |  1.70 ms | −85.5% |   1.10 ms |
|  10,000 |  20.80 ms |  3.25 ms | −84.4% |   2.10 ms |
|  60,000 | 157.45 ms | 22.80 ms | −85.5% |   4.40 ms |

The improvement exceeds three times the full A/A range at every size from 1,000
upwards; the 100-record result is below noise. No metric crosses the ordinary-use
regression gate. These are **data-projection times, not complete popup-opening
latency or native-tab capacity**. Exact output hashes match across all Firefox
runs. The Node comparison also shows lower sampled temporary heap increments:
4.23 → 2.51 MB at 1,000 records and 119.73 → 47.22 MB at 60,000, both beyond the
noise threshold. It does not demonstrate lower settled Firefox RAM. Reports with
individual samples, medians, ranges and source hashes are
`preview-webdriver-summary.json` and `preview-node-summary.json`.

Repeated row icons are now shared CSS mask images: the 12px close glyph and the
16px fallback globe. Their original Acorn paths, view boxes and fill/clip rules
are preserved and checked against the canonical sprite. Firefox-supplied favicons
still use the existing image and tint behaviour. Failed icons switch to the same
globe; labels, button targets, focus and full row rendering remain intact. This
removes two DOM elements per close glyph and two per fallback globe, without
virtualising text or changing native Find.

Fresh actual-sidebar measurements compare the round's starting source `e8d7f504…`
with the frozen combined candidate `099210a2…`, including the three preceding improvements.
There are five A/A pairs and five A/B pairs for each icon workload, at 100, 1,000
and 5,000 logical rows. Every row remains mounted in the expanded samples.
Collected **extension-process heap**, in decimal MB, is:

| Icon workload       |  Rows |  Before |  After | Change | A/A range |
| :------------------ | ----: | ------: | -----: | -----: | --------: |
| Missing site icons  |   100 |  19.308 | 16.993 | −12.0% |     0.040 |
| Missing site icons  | 1,000 |  49.947 | 26.520 | −46.9% |     0.123 |
| Missing site icons  | 5,000 | 183.603 | 66.798 | −63.6% |     0.317 |
| Supplied site icons |   100 |  18.322 | 17.252 |  −5.8% |     0.511 |
| Supplied site icons | 1,000 |  39.970 | 28.848 | −27.8% |     0.594 |
| Supplied site icons | 5,000 | 133.054 | 77.469 | −41.8% |     0.671 |

All reductions exceed three times A/A variation except the 100-row supplied-icon
case. At 5,000 rows, repeated unfolding improved 224 → 70 ms with missing icons
and 219.5 → 153 ms with supplied icons, both beyond variation. No ordinary metric
crossed both regression thresholds. These fixtures isolate renderer overhead:
**they do not contain 5,000 real Firefox tabs or measure complete extension memory
for such a session**. Real sessions add background/controller state, native tabs,
web pages and their images. The supplied-icon fixture shares one small image;
it is not a model of every site's decoded-image cost.

Whole-Firefox collected resident sums while expanded decreased by about 105 MB
and 51 MB respectively, but remained within the conservative noise threshold.
After folding, their decreases of 52.6 MB and 28.8 MB did exceed that threshold
(A/A ranges 10.8 MB and 8.1 MB). A 64% extension-process heap reduction must not be
reported as a 64% reduction in Firefox's total RAM. All samples, medians, ranges,
latencies and source hashes are in `rows-final-summary.json` and
`supplied-icons-summary.json`; the watchdog peak across these forty workers was
below 2.1 GiB, with pressure-free memory at least 45%.

For these one-sidebar experiments the ignored diagnostic harness targets the
actual existing sidebar by its browser ID, avoiding the unrelated DevTools
fallback document. It asserts that the target does not change and closes the
owned profile after every worker. Both workloads have fresh matching A/A data;
they do not reuse measurements from the add-on-wide attachment harness. This is
an experimental measurement harness, not a claimed fix to the general DevTools
startup stall. Real native tab integration continues to use the registered QA
suites and their existing harness.

A close-only mask prototype already reduced 5,000-row extension heap by 30.4%.
An alternative using direct inline SVG paths for close/globe reduced it by about
16%, so it was not promoted. The combined masks provide the larger saving while
retaining complete rendered collections. The viewport-rendering decision remains
unchanged: keep full rendering and native Find compatibility.

The icon change passed 533 unit tests, 13 affected UI suites and five registered
native suites before commit. Native light, dark and forced-colour comparisons
checked supplied, missing and failed icons with container tint. Controls, icon
sizes and inherited colours matched. Actual 1× and Retina 2× rendering differed
only slightly in pixel values (maximum channel difference 7/255); an artificial
2× capture of a 1× surface was also retained but is not Retina rendering. The
registered tint test now checks painted fallback pixels and forced-colour
contrast, and the existing disclosure test still clicks the fallback to fold and
unfold its parent. Visual evidence is under `native-icons-visual-1x/` and
`native-icons-visual-retina/`.

### Native ramp after the follow-up

The committed candidate `0391890` has extension source fingerprint
`81a823682681decc2fc639a4a28366ca5d3531eacd6c616464ccdea5135c45e8`.
Its differences from the paired renderer candidate `099210a2…` are formatting
and the icon attribution notice; executable behaviour and icon geometry are
unchanged. Fresh real-tab pilots use the maintained native harness and the same
memory-pressure, RSS and time limits. These are **single candidate runs**, not
paired evidence of a performance change.

The 100- and 1,000-tab fixtures, each across two windows, completed all thirteen
stages. They verify authoritative sidebar contents, search, live title updates,
visible unfocused and minimised windows, closing/reopening sidebars and extension
reload. Warm-checkpoint measurements are below; MB is decimal and GiB is binary.
Fixture sizes exclude the initial blank tab in each window.

| Fixture tabs | Collected extension heap | Extension resident-unique | Whole-Firefox resident sum | Peak owned RSS |
| -----------: | -----------------------: | ------------------------: | -------------------------: | -------------: |
|          100 |                 27.45 MB |                  73.14 MB |                1,529.14 MB |      2.915 GiB |
|        1,000 |                 83.30 MB |                 150.73 MB |                1,724.33 MB |      3.145 GiB |

The extension process includes Firefox runtime and diagnostic overhead. Its heap
is not its total RAM, and its resident memory is not a measurement of the marginal
cost of Tabernacle alone. Process resident sums can count shared pages more than
once; they must not be added to heap or OS RSS. With both sidebars closed, collected
extension heap fell to 13.84 MB and 18.38 MB respectively. Minimum pressure-free
memory remained 47% in both pilots. The raw reports are `real-100.json` and
`real-1000.json` under `test-results/memory/fundamentals/`.

The 5,000-tab/eight-window pilot created all fixture tabs, then reached the 4 GiB
RSS guard at the beginning of membership seeding. The sampled peak was 4.113 GiB
and minimum pressure-free memory 43%; the external watchdog terminated its owned
processes. This remains **inconclusive**, with no settled 5,000-tab sample and no
10,000–60,000 native runs. No cap was raised, and this workload was not retried. The
renderer improvement has not demonstrated that the larger native fixture fits
this machine's safety budget. Evidence is preserved in `real-5000.json`.

Temporary-extension replacement and extension reload still do not establish
persistence through a complete Firefox restart.

The first final release-QA run, `2026-10-17T23-36-45.561Z`, passed 56 of 57 checks.
`test-later-firefox` stopped at the 60-second watchdog while attaching DevTools,
before its test assertions. Pressure remained normal (at least 46% pressure-free),
and peak owned RSS was 2.04 GiB. This check is retained as inconclusive, not passed.
The unchanged Saved for Later assertions subsequently passed in a single run with
the ignored startup trace: save, child promotion, containers, search, sidebar
reload, return and close. That diagnostic is recorded in `later-traced.json`;
it does not establish a root cause or general fix for the intermittent attachment
stall. The registered harness and safety limits remain unchanged.

The final registered confirmation, `2026-10-17T23-47-32.138Z`, passed **57/57**
checks with `TABERNACLE_MEMORY_GUARD=1 npm run qa:release -- --stress`: formatting,
lint, all 533 unit tests, 39 UI suites, 15 native suites, stress and build. The
report is `test-results/release-qa/2026-10-17T23-47-32.138Z/results.json`, tied to
the extension source fingerprint above. Native QA peak owned RSS was 3.757 GiB;
minimum pressure-free memory was 45%. Published-version upgrade and recovery
checks passed within the documented reload boundary. The earlier inconclusive
run remains available alongside this successful confirmation. No version,
identity, permissions or stored formats changed, and nothing was pushed, signed
or published.

## Independent audio refresh experiment (2026-10-18)

The independent performance programme started from
`e368761dfd9e83de71c9142b43094ce7d2962a64`. The retained audio candidate was written
from Tabernacle's existing view/index architecture; no Tree Style Tab or Sidebery
source, tests or dependencies were copied.

Audio-only refreshes update affected tab/folder ancestor summaries and rows instead
of rebuilding the whole tree. All paths/counts are validated before publishing a
summary change. Topology, activation, search, domain views and active gestures or
motion retain the full-render fallback. No storage format, transport, browser-cache
or live-page lifecycle changes are included.

Five fresh alternating Firefox 158.0 pairs at 1,000 native tabs measured extension
process CPU for 90 mute transitions: **838.375 ms → 505.586 ms (39.7% less CPU)**,
with improvement in every pair. The matching five-pair A/A range was 35.725 ms;
the 332.789 ms reduction exceeds both 10% and three times that range (107.174 ms).
The fixture uses one real sidebar, three preloaded local pages, discarded fixture
tabs and one control/seed tab. It checks mute/DOM agreement, identities, ordering,
active state and no live-page reloads. Audible ancestor counts are covered by
functional parity tests; this workload does not measure media decoding. The
100-tab CPU result and DOM/next-frame timings did not clear the noise gate.

The standard three-pair screen and five-pair confirmation covered 1,000 native tabs
across two sidebars and the existing 100/1,000/10,000 synthetic cases: no calibrated
regression flags among 292 metrics. Sparse metadata screening also had no flags.
A small consistent adverse observation remains visible: collected Firefox heap
after view cycles was 28,864 bytes higher (0.107%), within its 426,512-byte A/A range.
The source adds no retained per-record collection; this is not a demonstrated
memory regression or benefit. Small synthetic heap increases are separate Node
measurements, not Firefox RAM. DOM/next-frame observations are not exact paint.

Formatting, lint and 568 unit tests passed, plus 18 affected UI and seven native
Firefox suites, including direct sidebar Finder and the extension-page Find bar.
The tested production fingerprint is
`a5a8659f07324138e6c5e6cf988db671813ce1a41f1034373cdcdd7364e0180b`.
The unchanged 3 GiB benchmark and existing functional guards were retained.

Evidence is under `test-results/memory/independent-performance/`: `exp2b-final-aa/`,
`exp2b-final-confirm/`, `exp2b-standard-screen/`, `exp2b-standard-confirm/`,
`exp2b-metadata-screen/`, `exp2b-functional/`, `exp2b-check-final.log` and
`exp2b-precommit-proof.json`. Earlier diagnostic reports remain separate; two
whitespace-only lint fixes prompted fresh matching targeted calibration and
confirmation. The production candidate did not change between those runs.

The reusable targeted runner is `scripts/benchmarks/audio/audio-runner.mjs`, with
`screen|calibrate|confirm OUTPUT [BASELINE=HEAD] [NOISE_REPORT]`. Confirmation needs
a matching, complete five-pair A/A report no older than 24 hours. It freezes and
fingerprints sources, diagnostics, fixture, dependencies and runtime, fixes native
workloads at 100/1,000 tabs, and stops the batch on resource limits or failures.
Routine regression measurements still use `npm run benchmark:optim`.

## Independent action response experiment (2026-10-18)

Sidebar actions now negotiate optional snapshot protocol 2 and use the existing
reader base to receive changed tab records. The background remains authoritative;
full responses cover invalid bases, changed tab order, window/generation changes
and unsupported callers. The envelope has an explicit `snapshotProtocol` marker,
so ordinary action results such as folder-import previews keep their own tokens.
Receipts, errors and extra result fields survive decoding. Recovery requests a
fresh snapshot and never repeats the action. No stored formats, identifiers,
permissions, browser-tab unloading or upstream code are involved.

The baseline is the accepted audio commit
`e4fa2ffd1bc873f9f13bc8bda181a92e02d950b5`; the tested production fingerprint is
`8a6e1af740975e318223b9908437e2bdfc802da459cbac2efe26b5053617cb04`.
A fixed native Firefox 158.0 workload uses 100/1,000 tabs plus one seed tab, one
sidebar, three preloaded local pages, nine warmup actions and 90 `muteTab` actions.
An identical test-only hook calls each version's actual sidebar request function.
Each response, DOM convergence, final native state, identities and live-page
preservation are checked. The runner fingerprints original and instrumented
sources separately, plus diagnostics, fixtures, dependencies and runtime.

Five fresh alternating pairs at 1,000 tabs measured **action-response-and-decode
p95 of 76 ms → 32 ms (57.9% lower)**. Every pair improved. The 44 ms reduction
exceeds 10% and three times the matching five-pair A/A range of 4 ms. Extension
process CPU for the same sequence fell **5,982.189 ms → 1,935.012 ms (67.7%)**,
with improvement in every pair and a 265.448 ms A/A range. These are targeted
request/sequence measurements, not general browser speed or exact screen-paint
latency. The 100-tab response p95 and peak owned-process RSS did not clear the
acceptance gate; no Firefox RAM reduction is claimed.

The corrected candidate's standard three-pair screen and five-pair confirmation
covered 1,000 native tabs/two sidebars and 100/1,000/10,000 synthetic tabs, with
**no calibrated regression flags among 292 metrics**. The screen's consistent
uncollected closed-sidebar heap increase did not persist: confirmation medians
were 55.364 → 53.168 MB. Collected heap was 18,080 bytes higher (0.159%), within a
532,752-byte A/A range and not higher in every pair. Consistent Firefox adverse
observations remained only in the pre-install disabled baseline (browser CPU
+49.652 ms, resident +1 MiB and unique resident +688 KiB), all within A/A ranges.
These are preserved in the report and cannot be attributed to installed candidate
code. Synthetic cold-reader time increased by 0.073 ms at 100 tabs and 4.305 ms at
10,000 tabs (1.29%/1.79%, within A/A ranges). Small synthetic heap increases were
at most 40,984 bytes across the fixed sizes; the reader adds bounded functions
and validation, not another per-tab state store. Node heap is not Firefox RAM.

Formatting, lint and 587 unit tests passed, together with all 39 registered UI
and 16 native Firefox suites, including upgrade/recovery, multiple windows,
direct sidebar Finder, extension-page Find, dragging and lifecycle disposal.
The UI transport fixture now models negotiated action responses without weakening
its delta/row-identity assertions. The native collection fixture waits for a new
sidebar document before checking reload persistence; its old wait could match
rows before the scheduled reload. All existing data assertions remain in place.
Tests also cover a real lost move reply and durable receipt after restart,
non-snapshot import previews, malformed deltas and bounded response retention.

Evidence under `test-results/memory/independent-performance/` includes
`exp4-aa/`, `exp4-marked-screen/`, `exp4-marked-confirm/`,
`exp4-marked-standard-screen/`, `exp4-marked-standard-confirm/`,
`exp4-marked-functional*/`, `exp4-marked-check.log` and `exp4-precommit-proof.json`.
The earlier unmarked-envelope prototype was corrected before acceptance; its
`exp4-screen/`, `exp4-confirm/` and `exp4-standard-*/` samples are separate and do
not confirm this candidate. Matching A/A calibration was reusable because its
baseline, diagnostic, runtime and fixture remained identical and within 24 hours.
The reusable runner is `scripts/benchmarks/action-response/action-response-runner.mjs`
with the same bounded `screen|calibrate|confirm` interface as the audio runner.
The 3 GiB benchmark, pressure, progress and time limits remain unchanged.

## Independent performance programme decisions (2026-10-18)

The programme began at `e368761dfd9e83de71c9142b43094ce7d2962a64` on
`codex/independent-performance-experiments`. Implementations were written from
behavioural hypotheses and this repository's architecture. No Tree Style Tab or
Sidebery code, tests, templates or dependencies were incorporated. Accepted changes
were committed sequentially; every rejected production prototype was removed.
The retained optimisations are:

- `e4fa2ff` — audio-only sidebar refreshes: 39.7% lower Firefox extension CPU in the
  confirmed 1,000-tab mute sequence.
- `9e6f784` — incremental sidebar action responses: response-and-decode p95 fell
  from 76 to 32 ms (57.9%) in the confirmed 1,000-tab action sequence. CPU for that
  sequence fell 67.7%.

Both primary metrics exceeded 10% and three times the full matching five-pair A/A
range, with improvement in every confirmation pair. Their separate evidence and
regression reviews are above. These are workload-specific Firefox measurements,
not general browser speed, screen-paint latency, battery-life or RAM claims.
The retained extension fingerprint is
`8a6e1af740975e318223b9908437e2bdfc802da459cbac2efe26b5053617cb04`.

| Finding                                      | Decision                                             | Evidence and reason                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Individual row child patches              | No demonstrated improvement                          | CPU fell 15.7% in the screen, but the 119 ms reduction did not exceed the 142.9 ms noise gate. Find-compatible text edits and parity checks passed.                                                                                                           |
| 2a. Targeted activation                      | No demonstrated improvement under the retention gate | Confirmed DOM-highlight p95 improved 38%; the allowed five follow-up pairs did not resolve adverse click/closed-sidebar CPU observations. The latter remained within calibration noise, not a proven regression. Candidate discarded.                         |
| 2b. Targeted audio                           | Accepted                                             | `e4fa2ff`; confirmed Firefox CPU gain, relevant functional suites and standard regression gate passed.                                                                                                                                                        |
| 3. Changed IDs through refreshes             | No demonstrated improvement                          | Native sparse-title CPU fell 4.0% in the screen, with one adverse pair; below the primary gate. A native probe verified that the proposed deltas actually carried the eight changed IDs.                                                                      |
| 4. Incremental action responses              | Accepted                                             | `9e6f784`; confirmed response p95 gain, all registered UI/native suites and standard regression gate passed.                                                                                                                                                  |
| 5. Incremental search                        | No demonstrated improvement                          | Cached normalised text and narrowing of actual matches passed parity. Screened query-to-correct-DOM p95 was 33 → 36 ms at 1,000 tabs; no primary benefit.                                                                                                     |
| 6a. Completed-operation notification batches | Inconclusive                                         | Before production changes, the two-sidebar structural baseline reached the unchanged 3 GiB owned-process limit at 1,000 tabs. Batch stopped without retry or raised limits. Existing 16 ms notification coalescing and serialised reads remain.               |
| 6b. Structural transport deltas              | No demonstrated improvement                          | Optional protocol 3 passed targeted parity, but screened burst p95 improved only 4.5%, with one adverse pair. The 35.3% CPU reduction is an uncalibrated secondary observation, not a substitute for the declared metric.                                     |
| 7. Flat sibling rows                         | Incompatible prototype                               | Folding removed outgoing child rows immediately and left focus on the document body. The baseline retained inert outgoing rows and focused their parent. Nested animation cancellation also failed. No performance claim.                                     |
| 8. Full-text presentation pooling            | Incompatible prototype                               | All row text remained connected; 100-tab native Finder discovery, highlighting, Find Again and last-row scrolling passed. Complete controls did not: 24–25 close controls remained versus 101 in the baseline. No heap comparison.                            |
| 9. Validated cold-start cache                | Inconclusive; deferred                               | Installed Firefox 158 rejected persistent installation of the exact unsigned baseline with `ERROR_SIGNEDSTATE_REQUIRED`. Genuine browser-restart profiling and validation were unavailable. No cache was implemented; extension reloads were not substituted. |
| 10. Unused derived-state release             | No demonstrated improvement                          | Token-specific reader cleanup reduced retained response bases from nine to one after the final reopen, but collected closed-view Firefox heap fell only 1.6%, not in every screen pair. Faster screened reopening was secondary and uncalibrated.             |

The 1,000-tab pooling diagnostic initially consumed an interim zero match count.
A baseline-only follow-up reported a found result with `total: -1, limit: 1000`;
the diagnostic's exact-count assertion was unsuitable at Firefox's cap. No
1,000-tab pooling parity pass or baseline Finder defect is claimed. The separate
100-tab control-semantics failure was sufficient to reject the prototype. Direct
sidebar Finder and the normal extension-page Find bar remain distinct tests.

Previously implemented or disproven approaches were also audited: generic event
coalescing, unchanged-write suppression, bounded reads, hidden-view release,
shared SVG sprites and close/globe masks already exist. Wholesale row-cache
eviction, viewport-only rows and lazy favicon hints retain their earlier adverse
evidence; none was reintroduced. No live page was unloaded by retained code.

The local ledger, predeclared hypotheses and exact rejected prototypes are in
`output/scratch/independent-performance/`. Raw evidence is in
`test-results/memory/independent-performance/`: `exp5-*`, `exp6a-pilot/`,
`exp6b-*`, `exp7-*`, `exp8-*`, `exp9-persistent-prerequisite/` and `exp10-*`,
alongside the earlier experiment reports. These ignored artefacts are not shipped.
Screen-only differences are uncalibrated observations. Resource stops are
inconclusive. Node heap and work counts are kept separate from Firefox claims.

Final guarded `qa:release -- --stress` verification completed with **57 of 58
checks passed**, including all 39 UI suites, 15 native suites, the documented
100/500/1,000-tab functional stress workload and the unsigned local build. The
remaining native collection suite was **inconclusive**: its 60-second no-progress
guard stopped it while connecting DevTools, with peak owned RSS 2.02 GiB and
pressure-free memory at least 70%. It had passed against the same retained
production code before experiment 4 was committed. This final stop is neither a
functional pass nor evidence of a product regression. No automatic retry was run.
The full final regression gate therefore remains unconfirmed. Evidence:
`test-results/release-qa/2026-10-18T20-15-53.659Z/results.json` and its collection
log/guard report.

The old QA runner continued later suites after that inconclusive result. The
follow-up correction now stops the batch and records the remaining suites without
running them. Formatting, lint and all 589 unit tests passed, including explicit
guard-stop and ordinary-failure batch tests. No native suite was rerun for this
tooling-only correction. Extension sources and benchmark limits are unchanged.

The maintained `benchmark:report` workflow separately compares committed final
HEAD against `e368761` in five alternating pairs. This is the planned cumulative
workload, not a retry of the stopped collection suite.
The cumulative report is reserved under
`test-results/memory/independent-performance/cumulative-final/`; its generated
headline, detail and regression tables remain authoritative, including adverse
results. This programme makes no version, signing, publishing or support-policy
change and does not run the exceptional 60,000-tab matrix.

## Committed folder index: 19 October 2026

Controller folder lookups use an index published with each successfully committed
model; mutable transaction copies retain fresh scans. Stored formats and public
snapshots are unchanged. Against `3919309`, Node 24.19.0 / Firefox 158.0 native
confirmation measured **54.7% lower extension CPU** (3,171.9 to 1,437.5 ms) for
90 navigation actions after nine warmups in the explicitly folder-heavy fixture
of 1,000 folders and 1,000 tabs. All five pairs improved; the 1,734.4 ms reduction
exceeded three times the matching five-pair A/A range (662.5 ms). Correct-DOM p95
fell from 40 to 21 ms. The 100-folder CPU change did not meet the improvement gate.

The maintained benchmark completed three screening pairs, then five matching A/A
and five A/B pairs with 1,000 native tabs across two sidebars and the standard
100/1,000/10,000 synthetic cases. No calibrated regression was found among 292
metrics. Natural extension resident memory changed +0.03%, added collected
extension heap -0.09%, total Firefox resident memory +0.31%, and sampled extension
RSS peak +1.02%; none establishes a memory change. Reopening and lifecycle heap
also remained within calibration. Disable-phase extension CPU rose 5.2 ms (10.4%)
in the median, inconsistently across pairs and inside the 17.0 ms A/A range.

Validation passed `npm run check` (611 tests) and 23 affected UI/native suite runs,
including folders, containers, settings, backup, mixed pins, multiple windows,
Sidebar, Activity, New Tab, drag and native Find. Coverage includes failed reads
and writes, invalid data, recovery retries, retained/writable snapshots and cache
disposal. The published v0.2.0 upgrade and extension reload checks passed; these
are not complete browser-restart coverage. Tested extension fingerprint:
`a0ce133d0ae6536489aa3777f820d0181f1e852776a6100fa3bd99ba3ab133e5`.

Local evidence: `test-results/memory/performance-redesign/2a-confirm/`,
`2a-calibration/`, `2a-maintained-confirm/` and the `2a-*` functional reports.
Hypotheses, rejected drag prototypes and decisions remain under
`output/scratch/performance-redesign/`. Diagnostics and raw reports are not shipped.

## TanStack viewport prototype: 19 October 2026

The `optim-tanstack` branch retains this experiment at Michael's request even
though it has **not demonstrated an overall performance improvement**. Its base
is `optim` at `b773d42`. It is a development foundation, not a release-qualified
replacement for that branch. No storage format, controller, extension identity,
permission, version or build pipeline changes are involved.

`extension/src/tree-viewport.js` adapts TanStack Virtual Core 3.19.6 to the existing
nested tree. TanStack owns offsets, visible ranges, overscan, scroll observation
and indexed scrolling. Tabernacle still owns row construction, nested branches,
guide spacers, keyboard navigation, search, animation and interaction retention.
Rows keep their own stable item identity; they are not reassigned to unrelated
tabs. Focused controls and owners of presses, menus, drags and outgoing animations
stay attached. Deep representative rows preserve horizontal scroll extent.

Virtualisation applies above 100 logically visible rows. Small trees, Domain
views and searches containing Saved results use the existing full renderer;
those latter layouts need separate variable-height work. Tabernacle search still
uses the complete logical projection. Native Firefox Find cannot discover
unmounted rows and is deliberately outside this experiment's requirements.

The five upstream ESM files, their source maps and MIT licence are vendored
unchanged under `extension/vendor/tanstack-virtual-core/`. `provenance.json`
records the official archive, integrity, release source and file hashes, verified
by `test/vendor.test.js`. Our build does not bundle, minify or transpile them.
The upstream JavaScript is compiled from TypeScript; its maps retain that source.
`virtual-environment.js` supplies the upstream production diagnostics flag.
Review the included notice and Mozilla's third-party-library requirements before
any submission; this experiment does not establish the appropriate AMO form
answer or guarantee review approval.

The standard three alternating screening pairs completed with Firefox 158,
Node 24.19.0, 1,000 native tabs across two real sidebars and the usual
100/1,000/10,000-tab synthetic cases. Median observations were:

| Native metric                          |   `optim` | Prototype | Change |
| -------------------------------------- | --------: | --------: | -----: |
| Idle DOM elements across both sidebars |     6,440 |       810 | -87.4% |
| Added collected extension heap         |  18.70 MB |  10.70 MB | -42.8% |
| Added idle extension resident memory   |  70.30 MB | 110.46 MB | +57.1% |
| View-and-scroll extension CPU          |  3,900 ms |  4,461 ms | +14.4% |
| Sampled extension-process RSS peak     | 429.46 MB | 613.78 MB | +42.9% |
| Exact-search next-frame response       |     14 ms |      6 ms | -57.1% |
| Broad-search next-frame response       |     19 ms |     12 ms | -36.8% |
| Search-clear next-frame response       |     12 ms |     11 ms |  -8.3% |

These are **uncalibrated screening observations**, not confirmed timing or RAM
improvements/regressions. All three pairs had the same direction for the DOM,
heap, resident, view CPU and exact/broad search observations. Collected heap is
retained allocation after forced collection, not ordinary RAM. Search response
times observe animation-frame callbacks and forced tree layout; they are not
screen-paint measurements. Both revisions receive identical complete physical
scroll traversal to verify row order and titles. Phase CPU therefore includes
that workload and its correctness observations; initial-phase CPU is not cold
first-paint latency. Resident measurements also reflect that traversal history.
The synthetic fixture tests the unchanged controller, not viewport rendering.

No five-pair A/A calibration or confirmation was run: the screen does not support
promoting this prototype as an overall optimisation. Retaining the code is an
explicit exception to the normal keep/discard gate, not a relaxed performance
standard. Raw reports, all samples and frozen sources are in
`test-results/memory/tanstack-2026-10-19/screen/`. The tested candidate extension
fingerprint is
`ee3dcfd0bceafc36fcac4f2e17e906e149b30c38cba0b5833f024d6c595fa1ae`;
the subsequent source-provenance URL correction does not change executable code.

Regression coverage includes complete 1,000-row traversal, offscreen search and
metadata, close identity, Home/End/arrows/Tab, focused-control attachment,
fold-animation ownership, narrow/wide sidebar geometry, light/dark/forced colours,
deep horizontal scrolling, listener counts, hidden views and pane restoration.
Final validation passed `npm run check` (613 unit tests), all 40 registered UI
suites, and the native Firefox drag and tab-close suites. An unsigned archive was
also built with the existing packaging method into the local scratch directory;
all packaged JavaScript and vendor files matched their source bytes.
The new suite is `node scripts/test-viewport-ui.js`. Native Firefox drag and
tab-close suites cover real sidebar scrolling, focused controls, closing, parent
promotion and undo. Manual screen-reader testing, touch, the full native suite,
upgrade/restart qualification and exceptional capacity tests remain outstanding.
Native Find tests remain available for the full renderer; their large-tree
expectations are deliberately incompatible with this prototype.

The adapter is about 485 lines, with roughly 606 net additional authored
production/CSS lines overall. It also relies on TanStack's adapter lifecycle
methods and measurements array; upgrades need parity tests. The full renderer
remains necessary for the fallbacks, so this is not yet a maintenance reduction.
Further work should profile allocation and garbage collection during scrolling,
then reduce repeated reconciliation and projection work. Re-run the bounded
screen and a matching calibration/confirmation before claiming an improvement.

## TanStack allocation investigation: 19 October 2026

This follow-up starts from `70fe951` on `optim-tanstack`. Michael again requested
that the work be retained and committed regardless of its performance result.
The existing build, upstream library bytes and persistent data remain unchanged.

The guarded native profiling tool is:

```sh
node scripts/benchmarks/viewport/profile-runner.mjs output/scratch/profile-before 70fe951
node scripts/benchmarks/viewport/profile-runner.mjs output/scratch/profile-after
node scripts/benchmarks/viewport/summarise-profile.mjs output/scratch/profile-after/profile.json output/scratch/profile-after/summary.json
```

Choose fresh output directories; their parent must exist. The tool freezes source,
instruments tab/wrapper construction, opens its own Firefox profile with 1,000
discarded tabs and records six alternating full scroll passes. It uses the normal
3 GiB/five-minute guard, validates complete row order, captures Firefox JavaScript
allocation samples and GC markers, and cleans up its browser. All profiles remain
local. Instrumentation changes allocation and timing behaviour: use this tool for
diagnosis, and `benchmark:optim` without profiling for performance decisions.

In the original recording, 318 scroll steps built 5,328 tab rows and 5,808 wrappers.
There were 9,693 sampled JS allocations (498,384 sampled bytes), and 10 minor
collections with 6.89 ms total recorded duration. No major collection was recorded
in that interval. Cache cleanup, iterator/entry arrays and child reconciliation
dominated the sampled allocation sites; TanStack's core was a small part of them.
This does not establish GC pauses as the main CPU problem. Selected DOM/style
reporters grew from 0.82 to 18.73 MB after scrolling, then returned to 0.81 MB after
forced collection. That is evidence of transient DOM retention in this fixture,
not proof of a persistent leak or exclusive attribution of resident memory.

The revised renderer avoids entry tuples and discarded sorting arrays in cache
cleanup, skips unchanged child reconciliation, shares the empty child list and
uses TanStack's cached indexes. It invalidates range extraction when interaction
ownership or geometry changes, rather than on every draw. Native `scrollend` is
enabled through TanStack's feature-detected fallback. The same diagnostic sampled
4,249 allocations (220,984 bytes, 55.7% fewer) and 5.70 ms of minor GC. Row/wrapper
construction counts remained unchanged; these sampled observations are not a
calibrated performance result.

An alternative that disables row `content-visibility` is reproducible with a
committed source ref and the optional third argument `--visible-rows`. It roughly
halved synchronous reflow markers in one diagnostic but nearly doubled style
markers and had higher sampled thread CPU. It is kept in the diagnostic tool,
not enabled in the renderer. Browser containment still benefits the overscan
rows even though the total mounted row count is already small.

A second frozen-copy variant, `--wrapper-pool`, retains up to 64 empty, detached
leaf-tab wrappers. It never reassigns row controls to another tab. After warm-up,
wrapper construction fell from 5,808 to zero, while tab-row construction stayed
at 5,328. Sampled thread CPU was 1,162.8 versus 1,192.6 ms (2.5% lower), sampled
JS allocation was 212,800 versus 220,984 bytes, and selected uncollected DOM/style
reporters were 16.88 versus 18.80 MB. This single instrumented observation does
not demonstrate an overall performance gain. The variant passed complete native
row-order traversal but has not undergone the full interaction suite or an
unprofiled paired benchmark. It remains in `scripts/benchmarks/viewport/variants.mjs`
for further experiments, disabled in the working extension. Run it with:

```sh
node scripts/benchmarks/viewport/profile-runner.mjs output/scratch/profile-wrappers - --wrapper-pool
```

Reducing allocation alone does not remove browser work to build, style and attach
row controls. The short recordings also cannot exclude major/cycle collection
costs in longer sessions. A larger row-reuse or flat-positioning redesign needs
its own focus, listener identity, hierarchy, animation and layout qualification;
the results here do not justify that extra complexity as an assumed optimisation.

### Library findings

The [TanStack API](https://tanstack.com/virtual/latest/docs/api/virtualizer)
supports retaining extra indexes through `rangeExtractor`, stable item keys,
native `scrollend`, tunable overscan and manual or observed row sizes. We use the
first three and keep overscan at 12. Reducing overscan alone risks blank frames
without eliminating construction over a complete scroll. Fixed-height tree rows
do not need per-row `ResizeObserver` measurement. The docs advise against adding
an animation-frame wrapper to resize observation without measured benefit; this
adapter leaves it disabled.

The [React adapter's direct DOM mode](https://github.com/TanStack/virtual/blob/main/packages/react-virtual/src/index.tsx)
avoids React renders by writing absolute row positions and container size.
Tabernacle already updates DOM directly, so that option is not available as a
switch in the core or an argument for introducing React. Flattening/absolutely
positioning the tree would need separate work on nested rails, folding animations,
horizontal overflow and interaction ownership. The
[dynamic example](https://tanstack.com/virtual/latest/docs/framework/react/examples/dynamic)
does show a possible future route for wrapped Domain/Saved layouts; it does not
remove those product-specific responsibilities.

| Candidate                                                                              | Relevant capability                                                             | Assessment for this investigation                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [udomdiff](https://github.com/WebReflection/udomdiff)                                  | Small keyed child-list reconciliation                                           | Its source still uses native insertion/replacement operations, and it does not build or retain row controls. It would need our focus/animation rules around it; no evidence that replacing the small reconciler fixes the measured DOM construction. |
| [morphdom](https://github.com/patrick-steele-idem/morphdom)                            | Patches one DOM tree against another, with keyed nodes and update/discard hooks | Could help a future row-template rewrite, but creating a target tree still allocates nodes. Our unchanged surviving rows already bypass rebuilding. Not added without a demonstrated benefit.                                                        |
| [FastDom](https://github.com/wilsonpage/fastdom)                                       | Batches DOM reads and writes                                                    | Potentially useful if a specific layout read/write loop is identified. It would add scheduling to synchronous focus/scroll paths and does not stop row allocation. No additional scheduler was introduced.                                           |
| [Lit Labs Virtualizer](https://github.com/lit/lit/tree/main/packages/labs/virtualizer) | Integrated rendering and measured layouts                                       | Requires a rendering migration, still removes/adds children, and its own documentation warns of prerelease/breaking API changes. It is not a low-risk mature drop-in for this nested renderer.                                                       |

TanStack's [Pretext example](https://tanstack.com/virtual/latest/docs/framework/react/examples/pretext)
precalculates wrapped text height from font and width. It does not address this
fixed-height tree's allocation problem; font/loading parity would need its own
investigation before using it in Domain/Saved results. No additional dependency
was added. None of the reviewed libraries supplies complete nested-tree focus,
animation, drag and accessibility semantics for this application.

### Follow-up benchmark results

Three alternating standard pairs against `70fe951` completed with the unchanged
1,000-tab/two-sidebar native fixture and 100/1,000/10,000 synthetic cases:

| Metric                                 | Previous prototype median | Revised median | Change |
| -------------------------------------- | ------------------------: | -------------: | -----: |
| View-and-scroll extension CPU          |                4,448.4 ms |     4,430.4 ms |  -0.4% |
| Idle extension-process resident memory |                 342.95 MB |      335.68 MB |  -2.1% |
| Added idle extension resident memory   |                 103.63 MB |       97.01 MB |  -6.4% |
| Added collected extension heap         |                 10.786 MB |      10.783 MB | -0.03% |
| Sampled extension-process RSS peak     |                 615.63 MB |      603.95 MB |  -1.9% |
| Exact-search next-frame response       |                     21 ms |          22 ms |  +4.8% |
| Broad-search next-frame response       |                     12 ms |          12 ms |     0% |

CPU changed direction across pairs; idle resident memory fell in each pair.
Neither primary metric met the predeclared 10% screening threshold, so this
candidate was not promoted to five-pair calibration/confirmation. There is **no
demonstrated CPU or RAM improvement**. Search callback timings remain coarse,
uncalibrated observations rather than screen-paint guarantees. In particular,
earlier sessions' search timings must not be combined into a new paired claim.
The code is retained at the user's request, independently of the performance gate.
Evidence: `test-results/memory/tanstack-churn-2026-10-19/screen/`; diagnostic
recordings and variant results are under
`output/scratch/tanstack-churn-2026-10-19/profile-{before,a,b}/`.

A separate three-pair comparison of the same revised executable source against
`optim` (`b773d42`) also completed:

| Metric                                 | `optim` median | Revised viewport median | Change |
| -------------------------------------- | -------------: | ----------------------: | -----: |
| DOM elements across both sidebars      |          6,440 |                     810 | -87.4% |
| Idle extension-process resident memory |      306.99 MB |               339.00 MB | +10.4% |
| Added collected extension heap         |       18.73 MB |                10.76 MB | -42.6% |
| Added idle extension resident memory   |       66.85 MB |                98.88 MB | +47.9% |
| View-and-scroll extension CPU          |     3,926.6 ms |              4,459.1 ms | +13.6% |
| Sampled extension-process RSS peak     |      435.34 MB |               609.71 MB | +40.1% |
| Exact-search next-frame response       |          22 ms |                   23 ms |  +4.5% |
| Broad-search next-frame response       |          20 ms |                   11 ms | -45.0% |

These too are uncalibrated screening observations. The primary CPU and resident
memory directions were adverse in all three pairs; the retained heap/DOM benefit
does not establish an overall improvement. No timing/memory acceptance claim or
merge to `optim` follows from either screen. Evidence:
`test-results/memory/tanstack-churn-2026-10-19/vs-optim/`. Both comparisons used
the unchanged benchmark harness, full physical traversal and the normal resource
limits; no stress escalation or resource-limit increase was made.

Resident totals include the extension process's Firefox runtime and the test
control extension. "Added" memory subtracts the disabled-extension baseline;
the 47.9% increase is this added cost, not a 47.9% increase in total browser RAM.

Both screens used candidate extension fingerprint
`774c66c926e5700a0395807efa39a90f45ff9f04d20af4b763775922ccfee1f1`.
Final functional validation passed `npm run check` (613 unit tests), all 40
registered UI suites, and the native Firefox drag and tab-close suites. These
exercise the revised renderer, not the optional diagnostic variants. No vendor
bytes, bundling/minification, permissions, storage format or release version
changed. Manual screen-reader testing, touch, full native/upgrade qualification
and exceptional capacity tests remain outside this follow-up's coverage.

## TanStack buffered ranges and lazy measurements: 19 October 2026

The selected change retains buffered range updates, lazy measurement access and an empty-folder
search fallback on `optim-tanstack`. It is retained for meaningful, repeatable reductions in
counted work, **not a demonstrated CPU or RAM improvement**. The current TanStack baseline is
`a361fca`; the comparison branch is `optim` at `b773d42`. The selected executable fingerprint is
`77579a0f267a226bbde3f2fe018d6a4f6807a53fa6cb94a9fa57f6a8d656b680`. No new production library,
vendor bytes, build pipeline, permissions or storage format changes are involved. The remaining
experimental variants are not enabled.

`viewport-range.js` starts with 12 overscan rows on each side. It refills when fewer than six
spare rows remain at the moving edge, leaving up to 18 ahead and six behind. The normal total
overscan budget stays at 24 rows, plus ancestors and existing interaction/width owners. Stable
buffered ranges reuse their index array and avoid repeated draw/reconciliation batches.
Geometry, viewport-height, fallback and suspension changes reset the buffer; owner changes still
refresh it. `draw()` reads offsets only for mounted entries and required ancestor endpoints. The
complete logical projection and geometry are still built; lazy measurement objects accumulate as
rows are visited rather than remaining permanently capped.

Matching expanded folders with no visible children have an intrinsic-height drop placeholder
absent from the fixed-height projection. Such searches now use the full renderer, alongside
Domain views and Saved-result searches. Clearing search returns safely to viewport rows when
eligible. Tabernacle search still covers the complete logical tree; native Firefox Find remains
outside the requirements. Existing row identities, nested layout and interaction ownership are
preserved.

### Targeted scrolling and memory-lifetime benchmark

This supplements `npm run benchmark:optim`; it does not replace the standard workload or
functional suites. Use Node 24 and fresh output directories:

```sh
# Three alternating pairs: HEAD versus the frozen working tree.
node scripts/benchmarks/viewport/scroll-runner.mjs
# Five A/A pairs, or five comparison pairs (calibrates first if needed).
node scripts/benchmarks/viewport/scroll-runner.mjs --baseline a361fca --calibrate
node scripts/benchmarks/viewport/scroll-runner.mjs --baseline a361fca --confirm
# Explicit baseline, or one candidate diagnostic without a comparison.
node scripts/benchmarks/viewport/scroll-runner.mjs --baseline optim
node scripts/benchmarks/viewport/scroll-runner.mjs --pilot
```

`--candidate REF` selects committed source; the default or `--working-tree` freezes the working
tree. `--noise REPORT_JSON` supplies matching calibration; `--output DIRECTORY` selects new
evidence storage. Defaults are under `test-results/memory/viewport-scroll/`. Reports retain
sources, fingerprints, individual samples, frame intervals, guard observations and correctness
results.

Each fresh Firefox profile has 1,000 discarded fixture tabs and one real sidebar. Slow scrolling
advances 24 pixels per animation frame for 240 steps each way; viewport-sized jumps traverse the
full tree six times. Memory is sampled before installation, after initial idle, after each
workload, after 10 seconds following the slow-scroll memory report, at 10/30 seconds from
full-traversal completion, and after final explicit GC/CC. Complete ID/title/order verification
runs last. No profiler, production instrumentation, retries or workload escalation is used; the
normal resource guard and 30-minute batch limit apply.

CPU excludes memory reporting and final correctness traversal, but includes the common frame
tail and invocation overhead. Whole-browser CPU excludes processes absent from either snapshot.
Frame intervals include scheduling, not exact paint or input latency. Reporting can affect
collection timing. RSS includes Firefox's extension runtime and the control extension; it is not
marginal Tabernacle RAM. Footprint and RSS are different measures, not additive. Peaks are
one-second samples; DOM/style/image/orphan categories are partial. Missing optional values are
unavailable, not zero. Timing/RAM acceptance still requires five-pair A/A and confirmation, >10%
reduction, >3× the full A/A range and agreement in every pair.

### Completed comparison and counted-work results

The targeted five-pair confirmation and matching five-pair A/A completed. No required timing or
memory metric cleared the project acceptance gate. No metric received a qualifying regression
flag either; that is not proof of equivalence. Representative medians [full observed ranges]
follow; MB is decimal:

| Metric                      |                    `a361fca` |                     Selected | Change |
| --------------------------- | ---------------------------: | ---------------------------: | -----: |
| Slow-scroll extension CPU   | 2,070.9 [1,975.5–2,200.7] ms | 1,167.7 [1,087.1–1,261.2] ms | -43.6% |
| Jump extension CPU          | 1,433.9 [1,319.7–1,496.3] ms | 1,496.3 [1,375.7–1,510.0] ms |  +4.4% |
| Slow-scroll frame p95       |                19 [19–19] ms |                19 [18–19] ms |     0% |
| RSS immediately after jumps |    305.71 [303.07–307.89] MB |    299.97 [298.11–301.33] MB |  -1.9% |
| RSS after 30 seconds idle   |    256.51 [256.28–259.33] MB |    257.72 [255.64–258.20] MB |  +0.5% |
| Final collected heap        |    15.654 [15.635–15.660] MB |    15.716 [15.702–15.720] MB |  +0.4% |
| Sampled extension RSS peak  |    306.76 [304.01–308.90] MB |    301.12 [298.78–302.28] MB |  -1.8% |

Slow CPU fell in every pair, but its 903.2 ms median reduction missed the 1,160.0 ms noise
threshold (3×386.7 ms A/A range). Whole-browser slow CPU fell 17.4%; whole-browser jump CPU rose
4.3% in every pair, also below the gate. Two candidate slow runs each had two frames over
33 ms: pair 3 had 49/67 ms, and pair 5 had 78/45 ms; all five comparison baseline runs had
none. The same-source A/A runs also had spikes, reaching 94 ms. These observations do not
establish a new timing regression under the calibrated gate. The transient orphan-DOM
backlog remained about 17 MB after jumps/10-second idle and about 0.33 MB after 30 seconds.

A separate instrumented diagnostic repeated each version three times. Every reported operation
count repeated exactly; all six runs checked 480 scroll steps, 1,001 authoritative tab
IDs/titles/order and 1,002 logical geometry rows:

| Counted operation              | Baseline | Selected | Change |
| ------------------------------ | -------: | -------: | -----: |
| Initial measurement objects    |    1,002 |       34 | -96.6% |
| Scrolling draw batches         |      384 |       30 | -92.2% |
| Scrolling reconciliation calls |    1,140 |      438 | -61.6% |
| Scrolling tab builds           |      276 |      283 |  +2.5% |
| Scrolling wrapper builds       |      372 |      378 |  +1.6% |

Both versions mounted at most 46 rows against the same 47-row bound, with identical 30,072-pixel
extent. Range extractions/draw attempts were unchanged. The candidate materialised another 195
measurements during scrolling: initial plus bounded-scroll creation was 229 versus 1,002; full
traversal can materialise the remainder. Geometry still scans all 1,002 logical rows initially.
Reconciliation child-reference counts fell 90.3%, but these are submitted references, not actual
DOM mutations. This diagnostic synchronises explicit offsets through the existing refresh API;
its work counts do not convert to CPU/RAM percentages or rescue the timing gate.

An earlier three-pair standard screen against `a361fca` recorded view-cycle CPU 4,813.8→4,645.3
ms (-3.5%), idle RSS 338.95→340.79 MB (+0.5%) and sampled peak 603.08→605.39 MB (+0.4%). It was
uncalibrated and preceded the empty-folder fix; its candidate fingerprint was
`fa5700c4056b4753f8d41e505b9d9b6994655c335ecfa6cf99dc96ce682534cf`. It must not be presented as
a paired standard comparison of the final source.

### Additional trials

All following variants are rejected or deferred, with sources/patches preserved. Except the
stated cache screen, native figures are single unpaired pilots compared with earlier buffered
screen medians; they are not acceptance evidence. MB is decimal.

| Trial                           | Evidence and remaining limitation                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Evicted-subtree teardown        | Relevant UI checks passed. Slow/jump CPU 1,332/1,491 ms; 30-second RSS 259.05 MB. Lower orphan reporting did not deliver corresponding resident-memory savings.                                                                                                                                                    |
| Complete leaf-row reuse         | Dedicated ownership/shape/motion checks passed; UI row builds fell 1,029→51. Pilot slow/jump CPU 1,291/1,346 ms; 30-second RSS 281.12 MB. Lower construction did not establish an overall win; collection timing changed.                                                                                          |
| Positioned nested layout        | Removed flow/spacer dependencies while keeping nested wrappers. A 6-pixel root-gap defect was corrected in scratch. Sibling fold motion still jumps; pilot slow/jump CPU 1,402/1,811 ms. Rejected for regression and no encouraging overall result.                                                                |
| Positioned layout plus reuse    | Passed preceding geometry checks after the gap fix, then failed sibling motion (0 pixels versus 1,115.83 required). Pilot slow/jump CPU 1,243/1,720 ms; 30-second RSS 267.85 MB. Not qualified.                                                                                                                    |
| Stable TanStack key callback    | Still rebuilt `treeLayout`. The three-pair screen of buffered/lazy plus cache reuse versus `a361fca` gave folder CPU -1.5%, view CPU -3.9% and peak RSS +0.1%; uncalibrated and not an isolated cache-versus-buffered comparison. No significant additional benefit established; removed.                          |
| Full geometry-object reuse      | Guarded topology/dimensions, reused entries/maps, refreshed row references and independently invalidated presentation. UI passed. Standard pilot folder/view CPU 4,543/4,617 ms; peak RSS 574.69 MB. No sufficient evidence to justify the extra checks/state; removed. Ordinary metadata already bypasses layout. |
| True flat sibling list, no pool | Separate from positioned nesting: removes wrappers/branches and keeps existing keyed builders. Pilot slow/jump CPU 1,163.7/1,285.9 ms; post-jump/30-second RSS 287.47/250.00 MB, peak 288.11 MB. Possible jump-cost upside remains unrefuted, but required rendering/interaction work is missing. Not retained.    |

The true-flat candidate's cached new-tab fallback positioning was repaired. The maintained UI
suite passed geometry, slow scrolling, resize and reorder checks before failing pixel parity
because rails are absent. A limited Chromium smoke passed 1,000-ID traversal, focus/title
updates, search and fallback transitions. It does not qualify branch animation, drag insertion
markers, hierarchy/accessibility or reordered-owner attachment. Those costs are absent from the
pilot: this is a structural diagnostic, not a feature-equivalent production speed/RAM result.

FAST/lit were separate isolated content-page experiments with a shared pool and protected
focused control. Three rotated rounds gave plain/FAST/lit median content CPU 1,585/1,667/1,661
ms, step p95 4/5/5 ms and 10-second RSS 200.11/205.69/202.69 MiB. All fixture checks passed; no
A/A calibration was run. Both libraries had higher RSS at every stage in every pair. FAST 3.1.2 loaded
119,776 readable bytes/26 modules; lit-html 3.3.3 loaded 64,198 bytes/one development module. The
common pool/ownership code remains, fixed-slot DOM order is not production qualified, and
shorter adapters do not establish lower maintenance. Neither warrants migration for CPU/RAM; no
extra production dependency was added.

### Evidence and final validation

Native reports are under `test-results/memory/tanstack-buffered-2026-10-19/`: `scroll-confirm/`
(including `calibration/`), `standard-screen/`, cache screens and individual `*-pilot/`
directories. Scratch source, patches and limited smoke records remain under
`output/scratch/tanstack-buffered-2026-10-19/`, including `work-count-results/report.json`,
`final-targeted-summary.{json,txt}` and `renderers/libraries-summary.{json,txt}`. Reports retain
every sample and source/harness identity; the targeted harness was
`0a839cc6e9966d26b8ef662fa6c75955e7b3a414e4f0576c50c16959561ed639`.

### Standard comparison against optim

The three alternating standard pairs in `vs-optim/report.json` completed with 1,000 native tabs
across two sidebars and the usual 100/1,000/10,000-tab synthetic cases. The baseline was `optim`
at `b773d42be64bb069779e4b8e85a96c86c05b07b5`, source fingerprint
`a0ce133d0ae6536489aa3777f820d0181f1e852776a6100fa3bd99ba3ab133e5`. The frozen candidate was the
selected source `77579a0f267a226bbde3f2fe018d6a4f6807a53fa6cb94a9fa57f6a8d656b680`, including its
uncommitted extension changes. It is not identified by the checkout's `a361fca` commit alone.
No matching A/A calibration applied: all timing/memory differences below are **uncalibrated**.
These fixed five headlines show medians [full ranges], with decimal MB:

| Metric                             |                           optim |                        Selected |  Change |
| ---------------------------------- | ------------------------------: | ------------------------------: | ------: |
| Idle extension-process RSS         |       307.72 [307.59–308.30] MB |       335.99 [334.53–339.77] MB |   +9.2% |
| Sampled extension-process RSS peak |       429.77 [422.61–432.44] MB |       585.30 [545.08–600.57] MB |  +36.2% |
| Warm tab-data reply p95            |                      2 [2–2] ms |                      2 [1–2] ms |      0% |
| Folder-action elapsed time         | 13,991.8 [13,973.8–14,140.1] ms | 13,995.3 [13,941.3–14,061.1] ms | +0.025% |
| Folder-action extension CPU        |    4,203.8 [4,194.3–4,216.7] ms |    4,424.4 [4,266.1–4,600.0] ms |   +5.2% |

Idle RSS, peak RSS and folder CPU were higher in all three pairs. Folder elapsed time changed
direction; reply p95 was equal in two pairs and lower in one. The report lists **0 Firefox and
0 synthetic regression-review flags**, but without calibration this is not evidence of no
regressions or a demonstrated overall improvement. Fixture correctness passed for both sources.

Idle DOM counts were 6,440→738 (-88.5%) in every pair. Added collected idle heap was
18.675 [18.657–18.748]→10.669 [10.668–10.685] MB (-42.9%), lower in every pair. This subtracts the
same-profile disabled baseline after collection; it is not ordinary resident memory. View-cycle
extension CPU was 4,086.5 [4,075.5–4,155.9]→4,521.3 [4,214.9–4,541.9] ms (+10.6%), higher in every
pair. Smaller DOM/retained heap coexist with an unresolved resident-memory/CPU premium over
optim in this workload. These paired observations use only this batch, not earlier candidates.

### Targeted scrolling comparison against optim

The separate `scroll-vs-optim/report.json` completed three alternating pairs on the one-sidebar
fixture. It used the exact baseline/candidate fingerprints recorded above (`a0ce133d…` and
`77579a0f…`) and targeted harness `0a839cc6…`. All six guarded runs and complete native
ID/title/order checks passed. There is **no matching optim A/A calibration**; the calibration
against `a361fca` cannot qualify this different baseline. Medians [full ranges] are descriptive:

| Metric                      |                        optim |                     Selected | Change |
| --------------------------- | ---------------------------: | ---------------------------: | -----: |
| Slow-scroll extension CPU   | 1,472.4 [1,286.2–1,487.3] ms |     995.8 [963.8–1,106.2] ms | -32.4% |
| Jump extension CPU          |   1,018.6 [823.9–1,038.6] ms | 1,366.8 [1,328.2–1,396.5] ms | +34.2% |
| RSS immediately after jumps |    259.42 [249.94–264.27] MB |    297.65 [283.25–298.27] MB | +14.7% |
| RSS after 10 seconds idle   |    258.15 [248.66–263.31] MB |    278.77 [273.12–296.78] MB |  +8.0% |
| RSS after 30 seconds idle   |    245.84 [239.39–247.22] MB |    243.71 [234.80–255.62] MB |  -0.9% |
| Final collected RSS         |    238.93 [238.31–244.86] MB |    241.55 [234.44–251.13] MB |  +1.1% |
| Final collected heap        |    23.507 [23.221–23.513] MB |    15.681 [15.121–15.682] MB | -33.3% |
| Sampled extension RSS peak  |    293.04 [291.36–295.85] MB |    297.09 [295.47–300.73] MB |  +1.4% |

Slow extension CPU was lower and jump extension CPU higher in all three pairs. Whole-browser
slow/jump CPU medians were 5,524.8→4,403.7 ms (-20.3%) and 4,192.8→4,609.2 ms (+9.9%), with the
same respective direction in every pair. RSS after jumps/10-second idle was higher in every
pair; 30-second RSS and final collected RSS changed direction. Collected heap was lower in
every pair; the peak-RSS direction was higher/higher/lower.

Slow-frame p95 was 18 [17–18]→18 [18–19] ms; jump p95 was 18 [18–18] ms for both.
In pair order, slow maximum frames were
19/19/23→25/52/121 ms and counts over 33 ms were 0/0/0→0/2/5. Jump maxima were
18/18/29→82/20/19 ms, with counts over 33 ms 0/0/0→2/0/0. This does not establish a
responsiveness gain; the adverse outliers remain visible rather than being averaged away.

Before-install RSS already differed: 226.46→237.21 MB, higher for all candidate profiles, so
absolute resident differences cannot be exclusively attributed to installed candidate code.
Optional physical footprint after jumps was 94.41→121.69 MB; at 30 seconds it was
76.19→76.06 MB with mixed directions. The optional orphan-DOM reporter was about 0.037 MB for
optim versus 17.14 MB after candidate jumps/10-second idle, returning to 0.333 MB after
30 seconds. These reporters are descriptive and reporting can influence collection timing.
The lower retained heap and promising slow CPU do not establish an overall improvement over
optim: jump CPU, transient retention and occasional long frames remain concerns.
Full individual values and pair directions are preserved in
`output/scratch/tanstack-buffered-2026-10-19/scroll-vs-optim-summary.{json,txt}`. This comparison
is separate from both the two-sidebar standard screen and the calibrated TanStack comparison.

### Final functional validation

`npm run check` passed (622 unit tests), and all 40 registered UI suites passed on the selected
production source. An additional owner-only regression was then added: mounting successive
offscreen rows at the same scroll offset must update retained rows and ancestors while releasing
the previous temporary owner. The complete viewport suite passed again with that assertion.
Coverage includes offscreen search and metadata, empty-folder search placeholders, slow scrolls,
reversals, jumps, native resize observation, same-count reorder, list shrinkage, focused/pressed
controls, menu owners, nested geometry, pixel parity, horizontal extent and sibling fold motion.

Native Firefox drag and tab-close suites passed in isolated profiles. The additional
`test-memory-benchmark-firefox` smoke exited 2 before launching its native worker because macOS
memory pressure was not normal. It is **inconclusive**, not passed; no automatic retry, limit
increase or user-app closure was attempted. Its report is
`test-results/memory/iteration/run-KqOy1j/report.json`. The earlier completed comparison batches
and their fixture correctness checks remain distinct evidence for the same selected source.

Final logs are in `output/scratch/tanstack-buffered-2026-10-19/`:
`check-final.log`, `ui-final.log`, `viewport-owner-final.log` and `native-final.log`.
Optional prototypes have only the limited checks described above. No release, upgrade, manual
screen-reader, touch, full-native-suite or exceptional-capacity qualification is claimed.

## Flat viewport follow-up (2026-10-19; not retained)

The follow-up prototype took the earlier flat-list diagnostic through functional validation,
including the visual and interaction behaviour that diagnostic omitted. It kept TanStack's
buffered range and lazy measurements, made steady-state rows direct tree children, and retained
focused, pressed, menu, drag and horizontal-width owners by their existing keys. It did not pool
or reassign controls. Search continued to use the complete logical projection.

The prototype restored continuous parent-coloured hierarchy lines, curved branch endpoints,
RTL and horizontal overflow, explicit tree ARIA position metadata, and insertion markers based
on logical sibling/subtree boundaries. It reused the existing nested viewport layout temporarily
for fold/unfold motion, including interrupted reversals and crossing the 100-row threshold.
State-preserving `moveBefore` moves kept live controls connected, with explicit scroll restoration
around the layout transitions. Engines without that API used the existing nested viewport path;
the Firefox minimum version and extension packaging were unchanged.

Functional testing exposed a further native-click risk: moving a row after `mousedown` but before
`mouseup` can suppress the subsequent click even when `moveBefore` preserves its focus and DOM
connection. The prototype deferred the return to flat layout until the press and click finished,
and prevented an older release task from clearing a newer press. A trusted mouse-event regression
and the existing rapid-toggle/double-click navigation suite passed with that fix. This distinction
is consistent with the narrower state-preservation guarantees documented for
[`Element.moveBefore`](https://developer.mozilla.org/en-US/docs/Web/API/Element/moveBefore).

### Functional evidence and complexity

- `npm run check` passed, including 626 unit tests (four new logical drop-boundary tests).
- All 41 registered UI suites obtained passing results across the initial serial run and focused
  follow-ups. The initial full batch stopped at a real double-click regression; it was not a
  single clean full-batch pass. Subsequent failures in cold/performance tests were assertions of
  the old nested DOM shape, updated to verify actual child depth, expansion, focus and revealed
  controls. Behavioural assertions were retained.
- The final expanded viewport suite passed on the frozen candidate: flat DOM/order/ARIA,
  complete search, metadata, empty-folder/full-render fallbacks, reorder/shrink/resize, ownership,
  exact guide/pixel geometry in light/dark/forced colours and RTL, horizontal extent, fold exits,
  both reversal directions, threshold transitions, held presses and compatibility without
  `moveBefore`.
- The dedicated flat drag suite passed against independent full-render boundary geometry,
  including actual moves, hover expansion, Escape restoration, invalid cycles, pins, pointer
  capture and autoscroll. Native Firefox drag and tab-close suites also passed in isolated profiles.
- Manual assistive-technology announcements, touch devices, upgrade/release QA, all native suites
  and exceptional-capacity workloads were not qualified. ARIA and keyboard assertions are not
  a substitute for screen-reader testing.

The complete production prototype added **422 net lines**, including 131 lines in two new
modules and 87 CSS lines. It still needed the nested path for motion, compatibility and existing
full-render fallbacks. Smaller steady-state DOM alone does not justify that extra maintenance.

### Benchmark stop and retention decision

The requested standard screen against current TanStack (`cc5b4245d14e`) stopped **before its first
native worker launched**. The guard observed macOS pressure level 2 with 46% pressure-free memory;
the start rule requires normal pressure as well as at least 30% free. Exit status was 2,
**inconclusive**, with no complete samples and no comparison or regression verdict.

No CPU, resident-memory or responsiveness improvement was demonstrated. The standard comparison
against `optim` (`b773d42be64b`), targeted scrolling screens and A/A confirmation were not run after
this resource stop. Replacing the stopped batch with a different native workload would not cure
the environment problem. There was no automatic retry, guard change, stress escalation or closure
of user applications. Earlier incomplete flat diagnostics are not measurements of this corrected
prototype and cannot establish its performance.

The user required meaningful overall gains before retaining the implementation. Because that
condition could not be verified, **the production and test changes were restored to `cc5b424`**;
`optim-tanstack` keeps its existing TanStack renderer. This is an unqualified experiment, not a
finding that flat rendering is slower. The complete tested prototype remains locally preserved
for a new explicitly requested comparison when memory pressure is normal:

- `output/scratch/tanstack-flat-2026-10-19/final-prototype/`: frozen extension/package source.
- `output/scratch/tanstack-flat-2026-10-19/saved-changes/`: all 13 changed/new source and test files;
  `changed-files.json` lists them, and `tracked.patch` preserves the tracked diff.
- `output/scratch/tanstack-flat-2026-10-19/`: `check-final.log`, initial `ui.log`,
  `remaining-2.log` (performance passed before the cold assertion failure), `remaining-3.log`
  (cold/refresh/native passes), `viewport-final-4.log`, and `drag-2.log` retain validation evidence.
- `test-results/memory/tanstack-flat-2026-10-19/standard-current/`: stopped benchmark report,
  guard observations and frozen baseline/candidate sources. Other comparison reports do not exist.

Candidate extension SHA-256:
`1f6b257fa1b7f3efe75cea8243a5e6955655fec7e7ba33cb53f5c3ed94131642`.
Current TanStack/restored extension SHA-256:
`77579a0f267a226bbde3f2fe018d6a4f6807a53fa6cb94a9fa57f6a8d656b680`.
Standard harness SHA-256:
`128672ebef79bf9919323f43028d8780e7c16ea6b7c6d90c9f09216c54bc3917`.
The stopped run used Firefox 158.0, Node 24.19.0 and Apple M1/16 GiB. Source hashes identify the
actual candidate; the shared base commit alone does not.

## Bounded row reuse and leaf layout: 20 October 2026

This follow-up keeps TanStack Virtual Core and the existing nested tree. It combines
reuse of ordinary leaf views, direct presentation updates, a leaf visibility override
and an adaptive buffered range. The reference is `488e77d7`; the selected executable
fingerprint is `5f7e5b718838001ac1495072e94b1c18fb8bbffe9294534764ce5b985b9cb1ea`.
No dependency, vendor code, persistence format, add-on identity or release version changes.

### View lifetime and layout

Ordinary one-line leaf tabs can reuse a complete wrapper, row, label text node and close
button. Supplied favicons and container colours are supported. The pool excludes parent
rows, audio controls, Saved results and Domain views. Overlapping logical keys retain their
existing views. Departing idle views become available before entering rows are rendered;
free views are rebound to the new logical ID, including accessible names and transient state.

The free pool has a 64-view cap and shares the existing **96 dormant views per sidebar** with
the identity cache. Mounted rows and interaction owners remain separate. Full and two-line
views release unused pooled rows. Suspension and disposal clear the pool. The complete tab
model, projection and lazy geometry still scale with the logical collection; this change
bounds view reuse, not all extension memory.

Focus, selection, menus, drag/motion ownership and every active pointer protect views from
reassignment. Pointer ownership lasts through the queued click; a later press using the same
pointer ID cannot be cleared by an earlier release task. Owners missing from a new projection
also stay ineligible for pooling, so closing a tab externally cannot redirect its outstanding
control to another tab. New integration checks cover overlapping-pointer reassignment and removal between pointer
release and click. The overlapping-press check reproduced a reassigned control before the fix.

Compatible title, URL, activation and discard changes update existing presentation fields.
Shape changes use the established builder and focus-preserving replacement. Loaded favicons
survive unrelated updates and same-URL reuse. Replaced icons keep their error handlers on the
old span, isolating late failures; an already failed image gets a fresh attempt for a new owner.

Mounted leaf rows use `content-visibility: visible` with explicit `contain: layout style paint`.
TanStack already limits mounted rows, so this avoids a second visibility calculation while
preserving the previous containment and transparent-image rendering. Parent rows keep their
existing visibility behaviour. The existing deep-row overflow exception explicitly retains
`contain: none`. Removing containment indiscriminately failed the richer pixel checks and was
not kept.

The range policy requests **12 overscan rows at startup and after large jumps**, and **24
during gradual scrolling**. A jump moves the first visible index by more than half the visible
range. The existing buffer can remain in place while it covers the requested range; refills
use the selected budget. At most 48 spare rows are buffered, plus existing ancestor and
interaction/width owners. Owner-only invalidation preserves the selected policy, while
viewport-height changes, suspension and resets restart the initial policy.

A fixed 24-row buffer reduced refill CPU but raised the measured jump-frame p95 from 18 to
20 ms in every confirmation pair. Fixed buffers of 18 and 20 were also tried: 18 restored
18 ms p95 but increased jump CPU; 20 retained the 20 ms p95. Two adaptive pilots retained
18 ms p95 for both gradual scrolling and jumps, with no additional startup rows. These
parameter trials informed selection; they are not independently calibrated performance claims.

### Alternatives investigated

The investigation compared reference clearing, a larger identity cache, field patches,
bounded reuse, flat positioning, nested positioning, containment/visibility changes and
combinations of these, including supplied-icon fixtures and different scroll buffers.
Reference clearing and larger identity retention did not justify their additional work or
retention. Flat positioning produced mixed CPU results against the nested combination, with
no clear memory advantage. The existing nested ownership was retained. Native layout and DOM
work were prominent in the baseline profile; replacing the virtualizer or introducing a
rendering/scheduling library was not justified by that evidence.

Frozen variants, diagnostic profiles and guard results are under
`output/scratch/resource-optim-2026-10-20/`. The exploratory runs are not substitutes for the
maintained calibrated comparisons. In particular, row-construction counts, collected heap,
ordinary RSS and CPU time remain distinct measures.

### Functional validation

The selected extension files passed `npm run check` (644 unit tests, lint and formatting),
all 40 registered UI suites and all 15 native Firefox functional suites. The separate native
memory-benchmark smoke is covered by the maintained comparison workload. Native checks include
same-ID upgrade/reload preservation from `v0.2.0`, pointer dragging, newly mounted close targets,
containers, Saved for Later, mixed pins and native Find in the full-renderer/page fixtures.
They are not full release qualification or exceptional-capacity testing.

Additional viewport checks cover pool budgets, identity-correct actions, focus and menu
ownership, simultaneous presses, removal before click, row shape changes, loaded-image
preservation, late favicon failures and retry on reassignment. Adaptive-buffer checks cover
startup, gradual movement, jumps, owner-only invalidation, resumption and resets. Geometry and pixel comparisons
cover narrow views, light/dark/forced colours and transparent tinted icons with audio controls.
A separate native Firefox diagnostic matched the full renderer's pixels exactly in light and
dark mode after the fading scrollbar settled, with identical scroll geometry.

The native Find suite still depended on a DevTools bridge removed from its shared browser
fixture. Its evaluation helper now uses one-shot, document-bound frame calls; the existing
Find, selection, highlight, resume and navigation assertions are unchanged and pass. The
shared browser and benchmark helpers were left unchanged. This is a test connection repair,
not a product Find change.

Validation evidence is in `output/scratch/resource-optim-2026-10-20/adaptive-validation.json`.
The QA helper also fingerprints the workspace's ignored `.DS_Store`; the benchmark export
excludes it. All 128 exported extension files were compared byte-for-byte with the tested
working tree, so that metadata-only hash difference does not represent different app code.

### Fixed-buffer comparison and review findings

The fixed-24 predecessor, fingerprint `dbd9c146…`, completed both maintained five-pair
comparisons with matching A/A. Its standard sampled RSS peak fell 25.8% (601.03 to
446.04 MB). In the scrolling workload, extension CPU fell 44.2% during gradual movement
and 12.6% during jumps; whole-browser slow-scroll CPU fell 35.4%. Its jump-frame p95,
however, increased 11.1% (18 to 20 ms), clearing the regression gate. This prompted the
adaptive policy above. These figures describe the predecessor, not the retained source.

The standard predecessor comparison also flagged an additional 1.352 MB of collected
heap after disable and a Node-100 sampled-heap increase. Five synthetic follow-up pairs
with their own A/A did not reproduce the Node flag: medians were 10.475096 versus
10.475072 MB, with no regression flags across 168 metrics. All 27 application modules in
the synthetic workload's import closure were byte-identical between sources. Both results
are retained; Node heap is not Firefox RAM.

Separate full-path native diagnostics on the 12- and 24-buffer predecessors reproduced
small post-disable heap differences. Neither grew during an extra 15-second idle interval;
selected DOM/style totals remained 108,128 bytes, ghost windows were zero, and the optional
orphan-DOM category was absent. An absent category is not a measured zero. In the 24-buffer
diagnostic, non-window cross-compartment wrapper tables accounted for 0.213 MB of the added
difference. The complete heap difference was not attributed. Runtime/allocator retention is
a possible explanation, not a proven cause; these short checks do not establish leak freedom.

Predecessor evidence is under `test-results/memory/resource-optim-2026-10-20/` in
`final-confirm/`, `final-scroll-confirm/` and `final-synthetic-followup/`. The raw reports retain
all findings, including the larger mounted-row counts from the fixed buffer. Full-path
lifecycle diagnostics are in `output/scratch/resource-optim-2026-10-20/lifecycle-diagnostic/`
and `lifecycle-final/`. They have reporting overhead and do not replace the maintained results.

### Retained candidate: measurement scope

The retained-source comparisons use Firefox 158.0 and Node 24.19.0 on the 16 GiB M1 Mac.
Each compares five alternating A/B pairs against `488e77d7`, with matching five-pair A/A
calibration. The standard workload has 1,000 native tabs across two sidebars and the
100/1,000/10,000 synthetic cases. The separate scrolling workload has 1,000 tabs in one
sidebar, gradual movement, six complete jump traversals and fixed idle intervals.

A demonstrated improvement must exceed 10% and three times the full A/A range, with
the same direction in every pair. MB means decimal megabytes. RSS includes Firefox's
extension runtime and the control extension; it is not the memory of loaded web pages.
Peaks are sampled, and overlapping memory reporters must not be added together.
Whole-browser CPU omits processes absent from either snapshot. Frame intervals include
animation-frame scheduling and are not direct measurements of paint or input latency.

The retained source's standard confirmation completed with **12 demonstrated memory
improvements, 214 metrics without demonstrated change, 72 unchanged deterministic work
measures and zero calibrated regression flags**.

| Standard native measure                  | Baseline median | Retained median |    Change | Assessment                |
| :--------------------------------------- | --------------: | --------------: | --------: | :------------------------ |
| Sampled extension-process RSS peak       |       603.95 MB |       445.38 MB |    −26.3% | Demonstrated improvement  |
| Unforced RSS after closing both sidebars |       592.66 MB |       434.86 MB |    −26.6% | Demonstrated improvement  |
| Initial idle unforced heap allocation    |        52.94 MB |        33.10 MB |    −37.5% | Demonstrated improvement  |
| Initial idle unforced RSS                |       339.23 MB |       307.56 MB |     −9.3% | Below the acceptance gate |
| Folder-action extension CPU              |     4,336.33 ms |     4,296.30 ms |     −0.9% | No demonstrated change    |
| View-cycle extension CPU                 |     4,406.44 ms |     4,443.82 ms |     +0.8% | No demonstrated change    |
| Warm snapshot reply p95                  |            2 ms |            2 ms |        0% | No demonstrated change    |
| Added collected heap after final disable |        1.927 MB |        2.207 MB | +0.280 MB | Below the variation gate  |

The post-disable heap difference remains an observation, not a demonstrated regression:
0.280 MB is below three times the matched A/A range (0.494 MB). Absolute collected heap
medians were 10.409 and 10.661 MB. All ten final-disable samples had the same selected
DOM/style total, zero ghost windows and an absent optional orphan-DOM category. There is
no claim that every memory measure improves or that these bounded tests prove leak freedom.

Standard retained-source evidence: `test-results/memory/resource-optim-2026-10-20/adaptive-confirm/`,
with matching A/A under `baseline-calibration/calibration/`. The final source was not profiled
or instrumented during either maintained comparison.

The retained scrolling comparison completed with **18 demonstrated improvements** (two CPU
and 16 memory reporters), 64 metrics without demonstrated change and four count-review flags.
There were **no calibrated timing or RAM regression flags**.

| Scrolling measure                      | Baseline median | Retained median |  Change | Assessment                |
| :------------------------------------- | --------------: | --------------: | ------: | :------------------------ |
| Gradual-scroll extension CPU           |     1,187.23 ms |       671.25 ms |  −43.5% | Demonstrated improvement  |
| Gradual-scroll whole-browser CPU       |     5,287.38 ms |     3,405.17 ms |  −35.6% | Demonstrated improvement  |
| Jump extension CPU                     |     1,391.70 ms |     1,317.23 ms |   −5.4% | Below the acceptance gate |
| Gradual-scroll frame p95               |           19 ms |           18 ms |   −5.3% | Below the acceptance gate |
| Jump frame p95                         |           18 ms |           18 ms |      0% | No demonstrated change    |
| Unforced RSS after jumps               |       296.47 MB |       266.75 MB | −10.02% | Demonstrated improvement  |
| Unforced RSS at 10 seconds after jumps |       294.65 MB |       264.19 MB |  −10.3% | Demonstrated improvement  |
| Sampled scrolling RSS peak             |       297.14 MB |       295.67 MB |   −0.5% | No demonstrated change    |
| Unforced RSS at 30 seconds after jumps |       256.29 MB |       263.88 MB |   +3.0% | No demonstrated change    |
| Final collected RSS                    |       251.35 MB |       244.48 MB |   −2.7% | No demonstrated change    |

The four count flags are the expected larger mounted buffer after gradual scrolling and at
its 10-second idle sample: 34 to 59 tab rows and 414 to 564 elements. This remains within the
48-spare-row bound and the separate 96-dormant-view budget. Selected DOM/style memory at those
same stages fell 54.7%, from 1.449 to 0.656 MB. Startup tab-row counts matched at 34, and
post-jump counts matched at 35. The increased gradual-scroll buffer is retained because the
CPU saving is demonstrated while startup, jump timing and bounded ownership are preserved.

The 30-second unforced candidate RSS ranged from 248.09 to 266.31 MB, versus 256.25 to
259.78 MB for the baseline. Its higher median was not consistent in every pair and did not
clear the gate; final collected values are a separate measure. There is no demonstrated
lower settled RSS floor. Candidate frame outliers still reached 40 ms during gradual
scrolling and 78 ms during jumps; neither maximum showed a calibrated regression. The
work does not claim universally lower RAM, uniformly faster frames or absence of pauses.

Scrolling evidence: `test-results/memory/resource-optim-2026-10-20/adaptive-scroll-confirm/`,
with matching A/A under `final-scroll-calibration/calibration/`. All ordinary guards remained
in place, with no resource stops or exceptional-capacity runs. The retained choice is the
best tested balance here: bounded view reuse and direct patches, nested layout with explicit
leaf containment, and a buffer that expands for gradual movement without the fixed-large-buffer
jump-frame regression.

## Adaptive leaf painting: 20 October 2026

The subsequent comparison with `optim` exposed additional whole-browser CPU during the
folder and sidebar-reopening sequences. Both sequences include repeated full-tree scrolling
for authoritative content verification; their CPU totals are not pure action latency.

The follow-up retains TanStack, nested layout, row pooling and interaction ownership.
Leaf rows now use explicit `content-visibility: visible` and `contain: layout style paint`
only during gradual scrolling. Startup and large jumps retain Firefox's automatic
offscreen paint suppression. The existing deep-row overflow exception applies in both
modes. Painting follows the adaptive range policy: owner-only updates preserve it,
geometry resets return to startup behaviour, and full rendering or suspension clears
the extra class.

Startup retains twelve overscan rows and gradual scrolling retains twenty-four. Large
jumps request eight. Four- and six-row trials used more collected heap after sidebar
closure; the twelve-row intermediate confirmation retained a reopening extension-CPU
flag. Eight rows was the best candidate from the adjacent settings. These trial observations
are selection evidence, not independently calibrated performance claims.

Controller and snapshot-allocation prototypes remain exploratory and were not adopted.
Sparse Node heap samples were sensitive to source and GC timing, including different
peaks for unchanged code at the same execution path. An identical-path control did not
eliminate the original difference, so path alone does not explain it. Collected Node heap
remained effectively unchanged; this neither proves lower peak allocation nor turns Node
heap into Firefox RAM. The detailed investigation and rejected variants are preserved in
`output/scratch/regressions-2026-10-20/`.

The retained extension source fingerprint is
`0e4819232a42dc8df9d062b92f874d1674fc36f01d9b4ffc805636a9472f4f0b`.
The five-pair scrolling confirmation against `efa1b5dc`, with matching five-pair A/A,
completed with no timing or RAM regression flags:

| Scrolling measure                   | Starting TanStack | Adaptive painting | Assessment             |
| ----------------------------------- | ----------------: | ----------------: | ---------------------- |
| Gradual-scroll extension CPU        |         654.78 ms |         654.89 ms | No demonstrated change |
| Jump extension CPU                  |       1,320.65 ms |       1,251.76 ms | No demonstrated change |
| Jump whole-browser CPU              |       4,768.57 ms |       4,430.80 ms | No demonstrated change |
| Gradual/jump frame-interval p95     |          18/18 ms |          18/18 ms | No demonstrated change |
| Sampled extension-process RSS peak  |         295.93 MB |         295.83 MB | No demonstrated change |
| Unforced RSS 30 seconds after jumps |         249.04 MB |         265.45 MB | No demonstrated change |

The smaller jump CPU readings did not clear the acceptance gate. The higher idle RSS
median was not consistent in every pair: baseline values ranged from 248.55 to 270.19 MB,
and candidate values from 248.56 to 269.71 MB. This does not demonstrate a lower RSS floor.

Eight count flags remain visible: after jumps and at the subsequent three memory stages,
mounted rows increased from 35 to 58 and document elements from 420 to 558. The workload
ends with a partial viewport movement; the adaptive policy can retain its wider gradual
buffer. These connected-node counts remain within the existing 48-spare-row policy and
separate 96-dormant-view budget. No timing or RAM regression accompanied them in this
confirmation. Evidence: `test-results/memory/regression-fix-2026-10-20/scroll-final/`.

The final standard comparison against `optim` (`b773d42be64b`) completed five
alternating pairs with matching five-pair A/A calibration and the unchanged
maintained harness. It reports 15 demonstrated reductions (nine memory reporters
and six descriptive DOM counts), 210 metrics without demonstrated change,
72 unchanged deterministic work measures and one synthetic regression flag.
There are no Firefox regression flags.

| Standard native measure                | optim median | Adaptive painting | Assessment                 |
| -------------------------------------- | -----------: | ----------------: | -------------------------- |
| Idle extension-process RSS             |    306.25 MB |         299.06 MB | No demonstrated change     |
| Sampled extension-process RSS peak     |    435.57 MB |         432.23 MB | No demonstrated change     |
| Idle collected heap                    |     27.20 MB |          18.85 MB | Demonstrated 31% reduction |
| Collected heap after three view cycles |     28.42 MB |          20.02 MB | Demonstrated 30% reduction |
| Added collected heap after closing     |      3.04 MB |           2.99 MB | No demonstrated change     |
| Folder-action extension CPU            |  4,056.06 ms |       4,111.92 ms | No demonstrated change     |
| Folder-action whole-browser CPU        |  8,811.64 ms |       9,099.81 ms | No demonstrated change     |
| Sidebar-reopening extension CPU        |  1,022.25 ms |       1,055.64 ms | No demonstrated change     |
| Sidebar-reopening whole-browser CPU    |  2,372.61 ms |       2,410.05 ms | No demonstrated change     |
| Warm snapshot reply p95                |         2 ms |              2 ms | No demonstrated change     |

The folder and reopening whole-browser CPU gaps are now approximately 3% and 2%,
compared with approximately 18% in the preceding `optim` versus starting-TanStack
report. Those are separate comparisons, not a calibrated percentage improvement
against the starting TanStack commit. Collected heap improvements against `optim`
remain demonstrated, but ordinary RSS and sampled peak RSS do not. The folder and
reopening totals still include the harness's content verification and settlement.

The remaining flag is the 100-tab Node create/close sampled heap peak: 8.644 to
10.474 MB, a 21% increase. Collected heap after the same burst is 7.302 MB on both
sides. The 1,000- and 10,000-tab synthetic cases have no regression flags.
Investigation found GC-sensitive sampling, but did not establish a complete
explanation or a production fix for this warning. It remains visible; it is not
evidence of higher Firefox RAM, and the work does not claim that every memory
regression is resolved.

Standard evidence: `test-results/memory/regression-fix-2026-10-20/retained-vs-optim/`.
Its generated Markdown retains the fixed headline and detailed metric selections.
The similarly named `final-vs-optim/` directory is the rejected twelve-row
intermediate comparison, not the selected eight-row result. Both final comparisons
completed all ten runs with the normal guards and matching source/harness hashes.

The selected source passed `npm run check` (644 unit tests, formatting, lint and
extension lint), the viewport suite and ten other affected UI suites, and the
native Firefox smoke, drag, tab-close and find suites. Four additional native
Firefox pixel comparisons matched full rendering exactly for light/dark mode
and jump/gradual scrolling. These cover the affected behaviour, not full release
or upgrade QA. Validation logs and source verification are under
`output/scratch/regressions-2026-10-20/`: `retained-check.log`,
`retained-viewport.log`, `functional-final/`, `native-pixels-final/` and
`final-verification.json`. No storage, identity, dependency or benchmark changes
were required.

## Local viewport geometry: 21 October 2026

At Michael's request, the viewport now uses local geometry and scroll observation instead
of TanStack Virtual Core. The vendored modules, maps, provenance, licence and production
environment shim are removed. `src/tree-geometry.js` calculates offsets and branch endpoints
in the existing row records. Two binary searches locate the visible range; unchanged ranges
reuse their result. Ancestor retention visits each retained row once, and scrolling within an
unchanged range does not query ownership or write DOM. A passive scroll listener and one
resize observer replace the general virtualiser's observation and scrolling machinery.

The nested renderer, adaptive overscan and painting, row pool, interaction ownership and full
rendering fallbacks retain their existing behaviour. Reveals and restores read the live native
scroll offset, including before a queued scroll event. Hidden updates resume through resize
observation. Persistence, identifiers, browser permissions and the supported Firefox version
are unchanged.

The retained extension fingerprint is
`94a1bc2729fc063b6b162fc15931d4127478a370f1a90964d7b35d7cd06a6acd`.
The standard benchmark against `7026b4bb7f7b` completed five alternating pairs with matching
five-pair A/A calibration on Firefox 158.0, Node 24.22.0 and the 16 GiB M1 Mac. All 298 metrics
were reviewed: **226 had no demonstrated change, 72 deterministic work measures were unchanged,
and there were zero calibrated regression flags**. No CPU or RAM improvement is claimed.

| Standard native measure               | TanStack median | Local median | Assessment             |
| ------------------------------------- | --------------: | -----------: | ---------------------- |
| Idle unforced extension-process RSS   |       301.96 MB |    291.47 MB | No demonstrated change |
| Sampled extension-process RSS peak    |       431.92 MB |    418.40 MB | No demonstrated change |
| Folder-action extension CPU           |     4,539.37 ms |  4,502.12 ms | No demonstrated change |
| View-cycle extension CPU              |     4,679.40 ms |  4,575.73 ms | No demonstrated change |
| Warm snapshot reply p95               |            2 ms |         2 ms | No demonstrated change |
| Added collected heap at final disable |        2.632 MB |     2.744 MB | No demonstrated change |

These are bounded workload results, not proof of leak freedom or universal responsiveness.
RSS includes the shared Firefox extension runtime and control extension. The initial
three-pair screen used Node 24.19.0 and was explicitly uncalibrated; its calibration was
correctly rejected because the Node patch version differed. Confirmation used the installed
24.22.0 runtime matching the cached calibration, with no harness or limit changes.

Standard evidence: `test-results/memory/own-viewport-2026-10-21/standard-confirm/`;
the initial screen remains in `standard-screen/`. Functional logs are under
`output/scratch/own-viewport-2026-10-21/`. The replacement passed 650 unit tests, all 40 UI
suites and all 16 native Firefox suites, including published-version same-ID upgrade/reload,
Find, drag, close and container checks. New coverage includes an independent geometry oracle,
logarithmic lookup at 10,000 rows, exact boundary/reveal behaviour, hidden updates and scrolls
without DOM writes. Existing light/dark/forced-colour pixel comparisons remain exact.

The supplemental scrolling screen completed three alternating pairs with the same source on
Node 24.22.0 and Firefox 158.0. Gradual and jump frame-interval p95 medians were 18 ms for both
versions. The replacement recorded no frame over 33 ms; one baseline jump frame reached 39 ms.
Gradual-scroll extension CPU
medians were 746.60 versus 677.70 ms, and jump CPU was 1,390.69 versus 1,393.69 ms. Peak sampled
extension RSS was 295.42 versus 294.67 MB. None of the 86 metrics increased by more than 10%.
This screen has **no matching scrolling A/A calibration**: these are descriptive observations,
not demonstrated CPU/RAM gains or a calibrated scrolling-regression verdict. The independently
calibrated standard confirmation above is the performance acceptance evidence for the removal.
Scrolling evidence: `test-results/memory/own-viewport-2026-10-21/scroll-screen/`.

The change removes approximately 246 kB (21%) of uncompressed extension source, including
vendored source maps. That is a file-size reduction, not a measured RAM saving. The retained
implementation is justified by the requested dependency removal, simpler ownership of geometry,
functional parity and the standard confirmation; it does not claim a general speed improvement.

## Unified filtered tab rows: 21 October 2026

Search and domain lists now use the same viewport threshold and fixed tab heights as the
main tree. A matching Saved tab or empty folder no longer forces every result into the DOM.
Saved search results keep their labelled section, with its 34 px heading represented in
geometry but excluded from keyboard navigation. Section siblings have their own ARIA positions;
focused and pressed rows retain their existing ownership. Dormant Saved rows remain subject
to the cache budget and closed tabs are evicted.

Tab titles use a single-line ellipsis in domain results, Saved searches, the Later pane,
new-tab lists and duplicate review. Full titles remain available to assistive technology and
in tooltips. Folder locations and last-viewed timestamps remain in result tooltips and accessible
descriptions. Empty search folders use compact folder rows without a drop placeholder, because
dragging is disabled during filtering. The optional website line remains available in the tree
and filtered results. No persistent format, identifiers, permissions or version changes are involved.

The bounded targeted benchmark compared `8a790c381939c6717b4a066336d05a2acc8269b2` with
extension fingerprint `296103fa6faaa8b936afdf345e3374a4626b7b3e10320d4a1a520590aaf4a901` on
Firefox 158.0 and Node 24.22.0. Each fresh profile contained 1,000 discarded fixture tabs and
one sidebar. Each scenario performed 20 narrow/broad search cycles, followed by complete
physical result traversal. Extension CPU was the predeclared primary measure; frame response,
natural memory, collected memory and DOM counts were reported separately. It reused the normal
resource guards and did not run concurrent test loads or escalate to a stress workload.

After a promising three-pair screen, five A/A calibration pairs and five alternating comparison
pairs demonstrated the following reductions. Every paired CPU result improved, exceeded 10%
and exceeded three times the full A/A range. The targeted comparison had zero calibrated
regression flags.

| Targeted extension CPU per 20 cycles | Baseline median | Candidate median | Reduction |
| ------------------------------------ | --------------: | ---------------: | --------: |
| Empty matching folder                |       738.30 ms |        308.01 ms |     58.3% |
| Matching Saved result                |       729.53 ms |        331.37 ms |     54.6% |
| Domain results                       |       879.29 ms |        433.87 ms |     50.7% |

The broad-query samples mounted 33 of 1,000 tab rows in the first two scenarios and 29 of
999 domain rows. This reduced DOM elements by about 93%. Input-to-following-frame p95 and
ordinary resident memory did not demonstrate improvements; CPU reductions must not be described
as equivalent visible-latency or whole-browser RAM savings. The lower final collected heap is a
separate post-collection observation.

Targeted evidence: `test-results/memory/search-viewport-2026-10-21/confirm/`; the successful screen
is in `screen-fixed/`. The earlier `screen/` stopped on a benchmark domain-navigation setup error
and provides no comparison. The supplementary harness and functional logs are under
`output/scratch/search-viewport-2026-10-21/`.

The standard `benchmark:optim -- --confirm` also completed five alternating pairs with
matching five-pair A/A calibration. All 298 metrics were reviewed: 226 had no demonstrated
change, 72 deterministic work measures were unchanged, and there were **zero calibrated
regression flags**. It used the unchanged bounded two-sidebar native workload and the
100 / 1,000 / 10,000-tab controller fixtures. Evidence is in
`test-results/memory/search-viewport-2026-10-21/standard/`.

Functional validation passed `npm run check` (651 unit tests), all 40 registered UI suites,
and the native Firefox smoke, domain, Later, collection, drag, tab-close, new-tab and Find
suites. New checks cover empty matching folders, mixed and all-Saved results, domain results,
full-render geometry parity, section ARIA, focus retention, keyboard boundaries and physical
traversal before bulk save/undo. Native Find retains the viewport limitation described above;
no manual assistive-technology, touch, stress or release/upgrade qualification is claimed.

After measurement, diff review restored the Later pane's header close glyph to its original
26 px size. This is the only extension difference from the frozen benchmark candidate;
search rendering, row styles and benchmarked execution paths are unchanged. Final exported extension
fingerprint: `28777597b742145bcc33c2e1f8a0968ed1d56acaf3605ea637961cad186df125`.

## Reviewed batch closing: 21 October 2026

The search refactor above was committed as `0a4576e` before this experiment. Reviewed
inactive closes now avoid building the full selection state before each removal.
The controller checks live native selection for each target, retains the existing
final target/keeper/scope validation, and uses the existing serialised removal and
invalidation path. Active targets still use the full selection/fallback path. No new
cache, stored format, durable identity or persisted organisation change is involved.

In a warmed controller, twenty inactive closes now require **one final native tab
query and one view read**, compared with twenty queries and twenty-one view reads.
Each target adds one direct native lookup; native removals and validation remain
serialised. Tests cover selection after earlier removals, activation between targets,
partial completion, a lost removal response, restart/retry, failed live lookups and
failed fallback queries, while preserving surviving placement and another window.

The frozen baseline extension fingerprint is
`28777597b742145bcc33c2e1f8a0968ed1d56acaf3605ea637961cad186df125`; the retained candidate is
`8051a1adf0b70b0cbf2abaf913296af915e31f400ef20037a6701fd0e5929410`.
Measurements used Firefox 158.0 and Node 24.22.0 on the 16 GiB M1 Mac, with unchanged
resource guards and no concurrent test loads.

The supplemental native fixture has 1,000 discarded tabs and one sidebar. Inactive
and duplicate scenarios each close three batches of twenty reviewed tabs; the mixed
scenario closes twenty tabs with its final target active. Every batch checks its
result and removed IDs; each scenario verifies surviving native IDs and complete
sidebar row order/titles. Setup gives targets explicit root placement through
ordinary controller moves, and the active target has a live seed successor.

Three-pair screening was followed by five matching A/A pairs and five fresh
alternating comparison pairs. Gains below exceed 10% and three full A/A ranges,
with the same direction in every pair.

| Scenario                   | Metric        | Baseline median | Candidate median | Change | Assessment               |
| -------------------------- | ------------- | --------------: | ---------------: | -----: | ------------------------ |
| Inactive, three × twenty   | Extension CPU |      963.687 ms |       382.246 ms | −60.3% | Demonstrated improvement |
| Inactive, three × twenty   | Completion    |        2,124 ms |         1,066 ms | −49.8% | Demonstrated improvement |
| Duplicates, three × twenty | Extension CPU |      815.160 ms |       364.498 ms | −55.3% | Demonstrated improvement |
| Duplicates, three × twenty | Completion    |        1,909 ms |         1,045 ms | −45.3% | Demonstrated improvement |
| Mixed active, twenty       | Completion    |          656 ms |           291 ms | −55.6% | Demonstrated improvement |

All 75 targeted metrics were reviewed: fourteen demonstrated improvements and no
regression flags. Mixed-active extension CPU fell descriptively from 251.552 to
116.990 ms, but did not exceed three times its A/A range. No memory improvement is
demonstrated. Mixed-active unforced heap had a 26.8% higher median, but increased in
only two of five pairs and remained within the measured A/A range.

The standard `benchmark:optim` also completed five A/A pairs and five confirmation
pairs, using separate invocations within the normal 30-minute limit. All 298 metrics
were reviewed: 226 showed no demonstrated change, 72 showed unchanged work, and none
flagged a regression. Neither workload stopped on resources. These results support
keeping the inactive-close refactor; they do not establish a gain for batches where
every successive close is active, or for larger native workloads.

Evidence is under `test-results/memory/batch-close-2026-10-21/`: `targeted-screen-final/`,
`targeted-confirm/`, `standard-calibration/` and `standard-confirm/`. The scratch
harness, plan and logs are in `output/scratch/batch-close-2026-10-21/`. Earlier failed
fixture runs are preserved: the unchanged baseline skipped unplaced records because
Firefox's native `groupId` can override an absent saved group during validation;
another baseline run loaded and renamed a discarded successor. Explicit placement
and a live successor correct the fixture equally for both sources. The pre-existing
unplaced-record validation issue remains outside this optimisation.

Validation: `npm run check`, all forty registered UI suites, and native Firefox
smoke, domain, Later, tab-collection, drag, tab-close, new-tab, Find and container-picker
suites. No release, upgrade or exceptional-capacity qualification is claimed.

## Folder collection indexes: 21 October 2026

The next review candidate was repeated folder-array scanning in collection actions
and scoped Saved searches. `folderCollection` now uses the folder index already
built for its tree ordering, and search projection passes its existing index into
Saved matching. Duplicate review builds one index per refresh for scope checks and
folder labels. Folder batches build one index per operation inside the controller
queue; native target/keeper lookup and final validation still run before each write.
This adds no cross-snapshot cache. No storage, identifiers,
ordering, permissions or visible behaviour changes are intended.

The work-count test bounds collection and Saved-search folder reads linearly at
1,000 folders and checks root, missing, descendant and moved-folder scopes. Existing
partial-save and close/retry-after-restart tests now also run with a folder scope.

Baseline is `34b82c4` (the retained batch-close optimisation), exported extension
SHA-256 `8051a1adf0b70b0cbf2abaf913296af915e31f400ef20037a6701fd0e5929410`.
Candidate extension SHA-256 is
`bead957e8be52eebfed940fb261f543bb7dd31fd2e6184b36499e84b785f133e`.
The runtime is Node 24.22.0 and Firefox 158.0 on the 16 GiB M1 Mac.

The targeted native workload uses 1,000 discarded tabs and 1,000 folders in two
500-folder branches, with one sidebar. The first branch contains ordinary tabs;
the second is Saved for Later. Pairs share duplicate URLs. It opens the first
folder's menu forty times, its 500-copy duplicate review ten times, and cycles
between narrow and broad Saved searches twenty times in the second branch. Every
iteration checks counts or exact results; complete sidebar IDs, titles and order,
and unchanged native tabs, are checked outside measurement. This is a folder-heavy
workload, not evidence of the same gains with a small number of folders.

After three alternating screening pairs, five same-source A/A pairs and five fresh
confirmation pairs passed the existing gate: a reduction over 10%, larger than
three full A/A ranges, with the same direction in every comparison pair.

| Scenario                        | Extension CPU before | Extension CPU after | Change | Assessment               |
| :------------------------------ | -------------------: | ------------------: | -----: | :----------------------- |
| Folder menu, 40 opens           |           449.651 ms |          259.107 ms | -42.4% | Demonstrated improvement |
| Duplicate review, 10 opens      |           313.829 ms |          272.469 ms | -13.2% | Demonstrated improvement |
| Scoped Saved search, 40 queries |           599.015 ms |          370.278 ms | -38.2% | Demonstrated improvement |

Scoped-search whole-browser CPU also fell from 914.883 to 693.168 ms (-24.2%). All
75 targeted metrics were reviewed: four demonstrated improvements, 71 without a
demonstrated change and zero regression flags. Menu whole-browser CPU and some
unforced memory medians increased during screening but did not exceed the calibrated
regression gate in confirmation. No response-frame or memory improvement is claimed.
Peak owned-process RSS in confirmation was 2,228,011,008 bytes; no resource stop occurred.

The standard `benchmark:optim` completed five matching A/A pairs and five fresh
confirmation pairs in separate invocations (14.36 and 14.49 minutes). All 298 metrics
were reviewed: 226 without a demonstrated change, 72 with unchanged work and zero
regression flags. All workers completed within the existing resource limits. Together,
the two workloads support retaining this refactor.

Memory uncertainty remains explicit. Three unforced folder-menu memory medians rose
about 11% in all five targeted pairs, including a 15.5 MB resident-unique increase;
these did not exceed three A/A ranges. In the standard workload, sampled Node heap
medians rose 44.3% for the 1,000-tab create/close phase and 20.4% for the 10,000-tab
cold-reader phase. Matching high samples also occurred in the baseline A/A and
comparison runs (about 26.5 MB and 101.5–101.7 MB respectively); retained heaps stayed
near 12.72 MB and 62.85 MB. These observations do not meet the calibrated regression
gate and do not establish a Firefox RAM improvement or leak freedom.

`npm run check` passed formatting, lint and 662 unit tests. All forty registered
UI suites and the same nine native Firefox suites passed: smoke, domain, Later,
tab-collection, drag, tab-close, new-tab, Find and container picker. No release,
upgrade or exceptional-capacity qualification is claimed.

Evidence is under `test-results/memory/folder-collections-2026-10-21/`, with the
scratch harness, plan and logs in `output/scratch/folder-collections-2026-10-21/`.
Valid targeted runs are `targeted-screen-separated/`, `targeted-calibration/` and
`targeted-confirm/`; the standard evidence is in `standard-calibration/` and
`standard-confirm/`. Earlier failed fixture runs are preserved. They first exposed
privileged-frame event/selector errors, then a baseline traversal failure: both
the ordinary observer and a denser two-frame observer returned 499 of 500 expected
rows in mixed nested/Saved search, omitting tab 498. The final fixture separates
ordinary and Saved branches and retains complete assertions. Product rendering was
not changed to address that pre-existing failure; the results do not resolve it.

## Controller repair invalidation (2026-10-21)

Cold-read, structural-update and retained-heap profiles used the standard synthetic
10,000-tab, nine-window, two-reader fixture, with separate CPU and allocation-sampling
runs. These instrumented profiles locate work; they are not timing or Firefox RAM
comparisons. Cold reads spent substantial CPU in cloning and serialising records.
After readers closed, the largest sampled live allocations were native tab records
(6.3 MB), presentation copies (4.2 MB), memberships (3.2 MB) and ownership indexes
(1.7 MB). Most sampled allocations disappeared after controller disposal; this does
not establish leak freedom or identify the fixture's total heap as controller memory.

The retained change limits membership-repair invalidation to the native tab's window
when that native structure and identity-ownership generation are still current after
the write. Previously, a new identity had no published window owner yet, so a repair
cleared every window's resolved tree. Ownership still commits only after all repairs
settle. Structural events, changed ownership, disposal or unavailable lifecycle
events discard that evidence. A repair without evidence or a published owner retains
conservative global invalidation, as does an ordinary write with unknown ownership.
No saved format, write ordering or creation timing changes.

Comparison baseline is `optim` commit `7e1cfaf53f3792c3c92d628ea7ef72f17d9095c4`,
extension SHA-256 `bead957e8be52eebfed940fb261f543bb7dd31fd2e6184b36499e84b785f133e`.
Candidate extension SHA-256 is
`147dbf2e7f13cec9e42440d67e0a932120b00fab9d6044c5cddb5708b7491e12`.
The unchanged standard harness ran on Node 24.22.0 / Firefox 158.0 on the 16 GiB M1
Mac, with 1,000 native tabs across two sidebars and the 100/1,000/10,000 synthetic cases.
Three screening pairs, five matching A/A pairs and five fresh confirmation pairs
completed. Calibration and confirmation were separate bounded invocations.

| Confirmed metric, 10,000 synthetic tabs |     Before |     After | Reduction |
| :-------------------------------------- | ---------: | --------: | --------: |
| Create/close sequence                   | 155.063 ms | 77.743 ms |     49.9% |
| Sampled peak heap in that sequence      | 110.087 MB | 89.341 MB |     18.8% |

Both reductions exceeded 10% and three full A/A ranges, with improvement in every
pair. All 298 metrics were reviewed: two demonstrated improvements, 224 without a
demonstrated change, 72 unchanged work measures and zero regression flags. All forty
workers completed; peak owned-process RSS was 2,619,408,384 bytes. The 1,000-tab
sequence fell 10.5%, but did not exceed three A/A ranges and is not a demonstrated
improvement. Cold reads (241.1 to 239.0 ms), cold retained heap (62.85 to 62.84 MB),
reader-closed heap (43.706 to 43.699 MB) and all Firefox metrics showed no demonstrated
change. Sampled Node peak heap is not retained controller memory or Firefox RAM.

Two earlier prototypes were removed. Delaying a creation batch by one event-loop
turn demonstrated synthetic timing reductions but added a 30.3% small-fixture heap
peak regression; a supplementary native creation screen showed no timing/CPU benefit.
Removing redundant object-rest copies did not produce a promising timing improvement.

Evidence is under `test-results/memory/controller-profile-2026-10-21/`:
`repair-standard-screen/`, `repair-standard-calibration/`, `repair-standard-confirm/`
and `repair-functional/`. Profiles, rejected patches and investigation scripts are
under `output/scratch/controller-profile-2026-10-21/`. The test for an untouched
1,996-tab window observes 7,568 tree-key lookups on the baseline and zero on the
candidate; snapshot contents remain identical. Partial repairs publish no ownership,
and an event during a pending repair exercises the global-invalidation fallback.

Validation passed `npm run check` (formatting, lint and 663 unit tests), eighteen
affected UI suites and nine native Firefox suites: smoke, domain filtering, Later,
tab collections, move dialogs, containers, drag, close and new-tab behaviour. A
post-run export verifies that the functional checkout's shipped sources match
confirmation; `repair-functional/source-equivalence.json` records that comparison.

## Benchmark shutdown and refactor retries (2026-10-21)

The earlier shutdown stall did not recur in an unchanged, instrumented native
workload. A final process audit did identify a detached Firefox updater whose
command line referenced the first failed baseline's browser PID and temporary
profile. It had survived the watchdog and was waiting for elevation. That verified
test-owned process was terminated; the pending application update files were left
intact. This establishes that application update processing escaped the isolated
session, though the archived shutdown report lacks the exit timing needed to prove
the cause of the separate later stall.

Test sessions now pass `-first-startup` to skip pending updates before preferences
load, and explicitly keep `app.update.disabledForTesting` enabled during automation.
The startup behaviour is documented in
[Mozilla's startup code](https://raw.githubusercontent.com/mozilla/gecko-dev/master/toolkit/xre/nsAppRunner.cpp).
Only disposable test launches use these settings. The native smoke suite checks
the effective runtime update-disabled state. A pending update remained pending
through protected launches without spawning another updater.

The retained harness changes address two reproducible lifecycle gaps. Process
accounting now includes the detached worker's process group, retaining descendants
after an intermediate parent exits. An exited worker gets three seconds to drain
its output; inherited pipes that remain open trigger owned-group cleanup and an
inconclusive result instead of waiting for the workload's 60-second stall limit.
Reports record the exit separately. A successful result message alone is never
accepted as shutdown. Standard native comparisons also reject incomplete extension-process
RSS accounting. The existing pressure, RSS, worker and command limits are unchanged.
Tests exercise reparenting, exclusion of unrelated processes, preserved final
output and termination of an orphan that retains the worker's output pipes.

Both saved refactors were retried independently against `1d8e40f`, with baseline
extension SHA-256
`147dbf2e7f13cec9e42440d67e0a932120b00fab9d6044c5cddb5708b7491e12`.
Each completed three alternating pairs of the standard native/synthetic benchmark
and its targeted native workload. Node 24.22.0, Firefox 158.0 and the 16 GiB M1 Mac
were used throughout. The standard harness fingerprint is
`89449dc8b1355ba0785dca24c9cac5863ffb64b220621103f41b1b57a45949db`.
These comparisons include the watchdog fixes and precede the final startup-update
protection. That later launch change invalidates their calibration for future runs;
neither rejected application refactor was retained based on these measurements.

The sidebar candidate reused a validated index for activation, folding and scope
changes. Its targeted screen observed 7.5% lower activation CPU, 1.6% higher folding
CPU and 0.4% lower navigation CPU. Standard view-cycle CPU changed by -0.2%.
Some temporary Firefox memory readings looked promising, so five matching A/A
pairs were run before deciding. The 65.8 MB sampled extension-RSS peak reduction
was smaller than three times the 53.6 MB A/A range. The 33.4 MB activation explicit
memory reduction likewise failed against a 13.2 MB A/A range. All 75 targeted
metrics assessed with that calibration reported no demonstrated change. Collected
memory was essentially unchanged. The candidate was removed; its extension hash
was `f50e95b62d70b5516ddfde0570a69aef907a083b0b1fed26862173caad4d9a80`.

The drag candidate reused subtree and sibling work within each move plan. The
trusted-gesture screen observed 5.5% lower extension CPU and 0.8% lower elapsed time;
p95 preview response remained 5 ms. Targeted memory did not show a promising gain.
Standard folder-action and view-cycle CPU changed by +0.1% and +0.3%. The candidate
was removed because it did not clear the minimum improvement threshold. Its hash
was `b027f2b439e7df71461b558cd46ce12a0b5593ee9cd3295845587b1974bea958`.
Screening percentages are descriptive, not confirmed improvements. No five-pair
candidate confirmation was justified after screening and the sidebar calibration.

Functional checks passed on the exact candidates: sidebar formatting/lint and 666
unit tests, all 41 UI suites and 11 relevant native suites; drag formatting/lint and
668 unit tests, all 40 UI suites and the same 11 native suites. These cover smoke,
domain filtering, Later, tab collections, move dialogs, drag, closing, new tabs,
Find, containers and pinned folders. Neither production refactor is retained.
Final `npm run check` passed on the retained harness changes, including 665 unit tests.

After adding startup-update protection, all 11 native suites passed again. The
final standard pilot completed the native workload and all three synthetic sizes,
with 76 of 76 extension-RSS samples complete and a clean worker exit. No Firefox,
geckodriver or updater process remained; the pre-existing `pending-elevate` update
status was unchanged. This final harness fingerprint is
`b929ec72bf1d1e84a065bb9b6e9e50e385b27ef6917b9196e96a306066fe0685`.
The final shipped-source export matches the original baseline hash above.

Evidence is under `test-results/memory/benchmark-retry-2026-10-21/`: `harness-pilot/`,
`sidebar-screen-http/`, `sidebar-standard/`, `sidebar-calibration/`,
`drag-screen-order/` and `drag-standard/`. Together these contain 35 completed native
workers with complete RSS accounting. `update-isolation-pilot/` contains the final
launch-protection pilot. The two earlier fixture failures are also
preserved: Firefox rejected extension-created data URLs, then the drag fixture
incorrectly treated snapshot array order as display order. The corrected fixtures
use local HTTP pages and native tab indices, retaining complete row/state checks.
Logs, calibrated screen assessment, decisions and lifecycle diagnostics are in
`output/scratch/benchmark-retry-2026-10-21/`. The original prototype patches remain
in the earlier sidebar and drag scratch directories.

## Keeper and folder move indexes: 22 October 2026

Reviewed duplicate batches now index keeper candidates once by canonical HTTP URL
and container. Selected closing copies are excluded. Each target reads only its
matching reviewed candidates, while retaining fresh native keeper, target and scope
validation immediately before removal. No live tab result is cached across closes.
Folder move plans build a fresh folder index for descendant counts, cycle checks
and folder lookups. The index belongs to one plan, so in-place hierarchy changes
are reflected by the next preview and by controller validation. Tab move planning
does not build this index. Storage formats, identifiers and mutation paths are unchanged.

Deterministic checks with 500 distinct duplicate pairs reduced native tab reads
from 253,000 to 3,500. A folder plan with 1,000 tabs and 1,000 flat folders reduced
folder-ID reads from 502,520 to 9,005. The regression tests bound work at 100
duplicate pairs and 1,000 folders, and cover Reader View URLs, container boundaries,
stale/closed/moved keepers, failed reads, fallback keepers, partial close failures,
restart/retry, descendant counts, pins, Saved tabs and mutable folder hierarchies.

Baseline is `b0f87246db604efba282cdc0fca60efc94e6546a`, exported extension SHA-256
`085d8050e2f634a2580bffc7f20ce9052d86917e341953bfd52547ad9a928fca`.
Candidate extension SHA-256 is
`67c2ff26dd7465df87b6f257e46575f7a934582561084231f1c82eb823e71ad5`.
Measurements used Node 24.22.0 and Firefox 158.0.1 on the 16 GiB M1 Mac, with the
existing resource limits and no concurrent test loads.

The supplemental native fixture has 1,000 discarded tabs, 1,000 flat folders and
one sidebar. It measures 90 trusted folder drag destinations and three duplicate
close batches of 100 distinct URL pairs. Every preview and batch is checked;
surviving native identities, complete membership, opaque saved fields and sidebar
state are verified outside measurement. These are folder-heavy and many-distinct-pair
workloads, not evidence of equivalent gains with a small collection.

Three alternating screening pairs, five matching same-source A/A pairs and five
fresh confirmation pairs completed. All 59 targeted metrics were reviewed: seven
demonstrated improvements, 52 without a demonstrated change and zero regression
flags. The confirmed gains exceed 10% and three full A/A ranges, with the same
direction in every pair.

| Scenario                    | Metric                 | Baseline median | Candidate median | Change |
| :-------------------------- | :--------------------- | --------------: | ---------------: | -----: |
| Folder previews, 90 targets | Extension CPU          |    1,372.256 ms |       907.262 ms | -33.9% |
| Folder previews, 90 targets | Whole-browser CPU      |    2,531.049 ms |     2,091.824 ms | -17.4% |
| Duplicates, three batches   | Extension CPU          |    2,044.998 ms |       715.586 ms | -65.0% |
| Duplicates, three batches   | Whole-browser CPU      |   13,151.020 ms |     8,400.764 ms | -36.1% |
| Duplicates, three batches   | Completion             |        7,167 ms |         3,773 ms | -47.4% |
| Duplicates, three batches   | Per-batch p95 response |        2,528 ms |         1,488 ms | -41.1% |

The seventh improvement is duplicate maximum response, which equals p95 with only
three batches per run. Folder preview response and overall elapsed time did not
clear the calibrated improvement gate. Neither workload had a resource stop.

No memory improvement is claimed. After folder dragging, unforced resident-unique
memory rose from 222.63 to 266.49 MB in the medians, increasing in every pair;
the 43.86 MB difference was below three times the 27.61 MB full A/A range.
Other unforced folder-stage reporters also increased without crossing that gate.
Duplicate-stage explicit memory rose 25.8% in the medians but not in every pair.
Final collected heap was 18.57 versus 18.50 MB; sampled extension RSS peaks were
438.85 versus 474.12 MB. These observations do not establish leak freedom or
unchanged memory use in everyday Firefox profiles.

The standard `benchmark:optim` also completed three screening pairs, five matching
A/A pairs and five fresh confirmation pairs. Calibration and confirmation ran in
separate invocations taking 14.45 and 14.41 minutes. All 298 confirmation metrics
were reviewed: 226 without a demonstrated change, 72 with unchanged work and zero
regression flags. No standard memory median increased by more than 10%, and no
worker stopped on resources. The final working-tree export matches the measured
candidate; `source-equivalence.json` records that check in the scratch directory.

Final `npm run check` passed formatting, lint and all 686 unit tests. Ten affected
UI suites passed: tab collections, duplicate selection, drag, move
dialog, group actions, folder picker, pinned folders, tab close, domain filtering
and Later. Nine native Firefox suites passed: smoke, tab collections, drag, move
dialog, container picker, tab close, pinned folders, domain filtering and Later.
No release, upgrade or exceptional-capacity qualification is claimed.

Evidence is under `test-results/memory/indexed-actions-2026-10-22/`; the supplemental
harness, deterministic counts, audits and functional logs are under
`output/scratch/indexed-actions-2026-10-22/`.

## Folder indexing and creation batch evaluation (2026-10-22)

Folder indexing is retained after the targeted response, standard regression and
functional checks below. The creation batch proposal is not retained.

The baseline is `600aeb0746f8a301f3b12bcac61cf36c7cc1981a`, extension fingerprint
`67c2ff26dd7465df87b6f257e46575f7a934582561084231f1c82eb823e71ad5`.
Both proposals were implemented as independent frozen candidates. The creation
candidate was rejected after screening; only folder indexing passed
final qualification. No storage, message, permission, identifier or version changes
are involved.

Folder actions build fresh, local indexes. Copy URLs and close confirmation use
indexed membership; Move contents traverses indexed children iteratively; the menu
reuses its existing unsaved collection when enabling Close all tabs. Ordering,
duplicate URLs, pins, Saved exclusion, Home and indentation remain unchanged.
Controller validation and writes are unchanged. There is no persistent index cache.

The folder candidate is
`42a3490569b3b2764e6d48f30b71d587575a97e6c1dd2cfc5c70f317c7cd5219`.
Its native supplement uses 1,000 discarded tabs plus a control tab, separately with
1,000 flat folders and 481 folders in depth-12 branches. Each run performs 30 menu
opens, copies, close confirmations and Move contents preparations per layout.
Menu and Move contents measurements use an empty root folder; copying and close
confirmation use the first populated root and its descendants. This isolates
destination preparation and the worst case for the redundant empty-folder scan.
Clipboard writes go to an identical test-only substitute and dialogs are cancelled.
Full membership, opaque saved records, native identities and complete sidebar row
order are checked outside timing.

Input is injected through DOM events inside the isolated Firefox sidebar. Response
means handler entry to the correct result/DOM and the next animation frame; it is
not hardware input latency or proof of paint. Earlier pilots failed because of
test-bridge input and cross-realm observer errors. Those reports are preserved but
excluded from comparisons. The corrected pilot is `folder-dom-pilot4/`; all screen,
calibration and confirmation results below use the same corrected harness.

Three alternating screening pairs, five same-source A/A pairs and five fresh
confirmation pairs completed. Calibration and confirmation were separate bounded
invocations. All 218 metrics were reviewed: four demonstrated response improvements,
214 without demonstrated change and zero calibrated regression flags.

| Scenario                  | Metric       | Baseline median | Candidate median | Change |
| :------------------------ | :----------- | --------------: | ---------------: | -----: |
| Flat Move contents        | Response p95 |           15 ms |             4 ms | -73.3% |
| Nested close confirmation | Response p95 |            7 ms |             3 ms | -57.1% |
| Nested Move contents      | Response p95 |            8 ms |             3 ms | -62.5% |

The fourth qualifying metric is flat Move contents maximum response, 15 to 5 ms.
Each exceeds 10% and three times its 1 ms full A/A range, improving in every
confirmation pair. These are bounded folder-heavy workloads, not whole-app speed
claims. Native CPU reductions did not clear the full A/A range requirement, so no
CPU improvement is established. Flat Move contents sequence CPU was mixed, with
medians of 1,038.428 and 1,087.505 ms (+4.7%); this did not establish a regression.

No RAM improvement is established. Final collected allocated heap was 18.224 versus
18.213 MB, resident memory 297.435 versus 289.096 MB, and resident-unique memory
109.724 versus 101.794 MB. Explicit memory was 31.083 versus 31.012 MB. Approximate
sampled extension RSS peaks were 755.565 versus 618.349 MB. None qualified as a
memory gain; no memory median increased by more than 10%. These process figures
include Firefox runtime and the control extension. Final ghost-window counts were
zero, and reported orphan DOM bytes were 80,144 in every final sample. The optional
main-runtime GC-heap reporter was unavailable; it is not treated as zero. Maximum
aggregate owned RSS was 2.703 GB, below the unchanged 4 GiB guard.

The rejected creation candidate
`a897149da678e0505fed09dceca76b1c4853f002306cbfa1f57b7710c67ae108`
added batch-local child counts, pinned-parent membership and sibling slots. Its
three-pair native screen used 900 existing tabs, root/common-opener layouts and
100 parallel, 100 sequential and ten individually completed creations, cleaning
up between scenarios. CPU medians ranged from 4.9% lower to 3.0% higher; no targeted
CPU or completion improvement exceeded 10%. Root parallel completion was 1,184
versus 1,327 ms (+12.1%, uncalibrated). Collected heap was 17.627 versus 17.865 MB
(+1.3%, uncalibrated). No five-pair confirmation was justified. The controller
change was removed, with its source and patch preserved locally; there is no
combined two-change performance claim.

The standard `benchmark:optim` completed three screening pairs, five matching A/A
pairs and five fresh confirmation pairs, with calibration and confirmation in
separate invocations. It covered 1,000 native tabs across two real sidebars and
the 100/1,000/10,000-tab synthetic cases. All 298 confirmation metrics were reviewed:
226 without demonstrated change, 72 unchanged work measures and zero calibrated
regression flags. An exact-search slowdown in the screen did not reproduce as a
calibrated regression. Maximum aggregate owned RSS was 2.690 GB; no worker stopped
on resources.

The standard memory review investigated the uncollected added-heap median after
view cycles: 3.098 to 4.871 MB (+1.773 MB). The increase was not consistent across
pairs and was smaller than the 6.087 MB full A/A range. Collected total heap at
that stage was 19.901 versus 19.769 MB, and after final disable it was 11.255 versus
11.122 MB. Collected added-heap differences of +22 KB after cycles and +20 KB after
disable were also inconsistent and below their 134/133 KB A/A ranges. The review
did not establish increased retained memory. Native process memory and Node heap
remain separate measures.

Separate instrumented functional fixtures counted hierarchy `id`/`parentId` reads
without timing. With 1,000 tabs and 1,000 flat folders, Copy URLs fell from 473,236
to 9,000 reads, Move contents from 1,505,501 to 12,000, and the empty-folder menu
from 483,287 to 10,990. A separate 400-folder deep-chain fixture reduced Move
contents reads from 11,067,204 to 5,596. These are work counts, not Firefox CPU or
RAM estimates. The rejected creation prototype reduced record-field reads from
205,400 to 6,200 for 900 existing plus 100 created tabs, with identical native and
session API counts; that did not establish a native performance benefit.

Validation passed `npm run check` with 686 unit tests and all 15 affected UI suites:
core, group actions, indexed folder actions, move dialog, folder picker, group
creation, folder clicks, tab clicks, tree expansion, pinned tabs, pinned folders,
Later, containers, tab closing and new tab. The new indexed-action suite verifies
exact copied URL order and duplicates, pins, Saved exclusion, empty and Saved-only
menus, stale copy/close IDs, collapsed descendants, duplicate names, destination
ordering/indentation and hierarchy mutation between actions. Existing controller
tests retain fresh-state confirmation checks, partial failures and retry coverage.

Nine native Firefox checks passed: smoke, move dialog, drag, pinned folders, Later,
container picker, tab closing, new tab and published-version upgrade/reload. The
upgrade suite initially captured a restored tab's transient `about:blank` as its
expected URL. It now waits, within 15 seconds, for the known original URL in both
native and controller state before capturing the expectation; the complete URL and
organisation assertions remain. The corrected test passed same-ID upgrade from
`v0.2.0`, reload, delayed restoration, interrupted move recovery, retry and opaque
saved-field preservation. This does not claim whole-Firefox restart coverage.

The final 115-file extension export matches the measured folder candidate exactly;
`source-equivalence.json` records the comparison. No version bump, signing or
publishing was performed.

Runtime: Node 24.19.0, Firefox 158.0.1, macOS 27.0.1 (26A434), Apple M1 with 16 GiB.
Normal macOS pressure readings were available after execution-sandbox approval;
the guard was not bypassed. Measurements used owned temporary profiles, no concurrent
test/profiling loads and unchanged pressure, RSS and timeout limits. No valid
targeted run stopped on resources. Node heap remains separate from Firefox RAM.

Evidence is under `test-results/memory/folder-creation-2026-10-22/`. Valid targeted
runs are `creation-screen/`, `folder-dom-screen/`, `folder-dom-calibration/` and
`folder-dom-confirm/`. Frozen sources, the supplemental harness, rejected patch,
metric audit and investigation logs are under
`output/scratch/folder-creation-2026-10-22/`.

## Native tab creation follow-up (2026-10-22)

The revised optimisation is retained after targeted CPU confirmation, standard
regression review and functional validation. It targets repeated full-window
native reads during inactive appends. The earlier child-count/sibling-slot
proposal remains removed.

The baseline is `027f4acdae0b3ce87c1ffc19efeb57e84fb70c73`, including the retained
folder indexing, with extension fingerprint
`42a3490569b3b2764e6d48f30b71d587575a97e6c1dd2cfc5c70f317c7cd5219`.
The final candidate fingerprint is
`c33697c2546b24299be81eb7fdf25da8e800acde0703730ba45f29c62e76e493`.
This is an incremental comparison against the accepted folder change.

A warm native-tab snapshot can now stage the IDs and expected positions of
inactive, unpinned tabs appended at the end of a known window. New records come
from authoritative `tabs.get` replies, including reuse of the controller's
existing required native check when the snapshot remains current. Earlier arrays
and position maps remain immutable. At most 32 pending additions are read at once;
larger bursts use the existing window query. Selections, middle insertions, active
or pinned tabs, navigation, moves, failed reads, cold snapshots and uncertain
native state retain the conservative invalidation/query path. Pending structures
are released after consumption or invalidation.

Creation queue boundaries, event delivery, serial membership writes, placement,
restored relationships and recovery remain unchanged. No persisted schema,
identifier, permission, public message or version changes are involved.

The investigation rejected an earlier variant that trusted creation-event records:
a real discarded-tab event reported width 729 while its authoritative native
record reported width 0. Complete native-field comparisons caught this difference.
The corrected design stages IDs and reads native records. An initial harness
pilot also exposed different optional fields between the control extension's MV2
permissions and the app's MV3 permissions; all valid comparisons query through the
same app permission context. Failed pilots are preserved and excluded.

Final review reproduced a disposal race in the initially confirmed prototype
`de5b23d4418797fb38af5a7896df841331d6ab1a855d94b02497fba9d99f12b6`:
an invalidated append refresh could expose its discarded empty placeholder if
disposal happened before the reader resumed. The new regression test failed before
the correction and passed afterwards. Discarded reads now carry a private sentinel
that triggers an authoritative retry even after disposal. The initial standard
confirmation was deliberately cancelled during its fourth pair after this finding;
it was not a resource stop. Its partial report is preserved and excluded from
qualification. The final CPU results below are fresh measurements of the corrected
source, not an extrapolation from that superseded prototype.

An independent append-tail index prototype passed 8,000 ordering queries and
5,309 commits over 40 deterministic fixtures, plus the existing controller
contracts. It was not timing-qualified or retained. Instrumentation showed only
three placement-context builds during 100 sequential native arrivals, while
repeated native window queries transferred tens of thousands of existing records.
That evidence directed the subsequent candidate towards native snapshot reuse.

Separate instrumented runs, outside timing, verified the final source's work:

| Creation scenario                    | Baseline window queries / returned rows | Candidate window queries / returned rows | Baseline / candidate single-tab reads | Membership writes, both |
| :----------------------------------- | --------------------------------------: | ---------------------------------------: | ------------------------------------: | ----------------------: |
| 100 root sequential                  |                             99 / 94,346 |                                    0 / 0 |                             100 / 199 |                     200 |
| 100 root parallel                    |                               1 / 1,001 |                                1 / 1,001 |                             100 / 100 |                     200 |
| Ten individually completed root tabs |                              10 / 9,065 |                                    0 / 0 |                               10 / 13 |                      20 |

The sequential root workload still makes 199 `tabs.query`/`tabs.get` calls; it
transfers far fewer unchanged records. Both revisions build three placement
contexts and read 100 tab memberships. Common-opener query/read/write counts remain
unchanged. Safe check reuse depends on event/read timing: the ten individual
creations used 13 single-tab reads in the final diagnostic, not necessarily one
per creation. These counts explain work removed, not whole-app speed estimates.

The targeted supplement uses 900 existing discarded tabs and at most 100 new tabs,
plus a control tab. Root and common-opener layouts each run 100 parallel creations,
100 sequential creations and ten individually completed creations, with cleanup
between scenarios. Completion requires committed placement beyond the existing
sibling tail. Full native fields, identities, membership, opaque saved records and
complete sidebar row order are verified outside timing. Volatile `lastAccessed`
values are excluded from exact native-field equality. Animation-frame gaps are
observations during the workload, not paint latency; a single batch has no p95.

The design passed three alternating screening pairs and five matching A/A pairs.
After correcting the disposal race and passing functional validation, five fresh
confirmation pairs measured the final source using that unchanged baseline,
harness, runtime and fixture calibration. All 201 comparative metrics were reviewed:
one demonstrated CPU improvement, 200 without demonstrated change and zero
calibrated regression flags.

| Root sequential, 100 creations | Baseline median | Candidate median |           Difference | Assessment                           |
| :----------------------------- | --------------: | ---------------: | -------------------: | :----------------------------------- |
| Extension-process CPU          |      454.290 ms |       308.506 ms | -145.783 ms (-32.1%) | Demonstrated improvement             |
| Committed completion           |        2,372 ms |         1,844 ms |     -528 ms (-22.3%) | Not demonstrated against calibration |
| Whole-browser CPU              |    4,707.116 ms |     4,276.645 ms |  -430.471 ms (-9.1%) | Not demonstrated against calibration |

Extension CPU improves in all five confirmation pairs, by 29.5–37.2% per pair.
Baseline samples span 438.950–487.406 ms and candidate samples 302.457–314.529 ms.
The 39.183 ms full A/A range gives a 117.548 ms three-range threshold, which the
145.783 ms reduction exceeds. Completion is faster in every pair but does not
exceed three times its 367 ms A/A range. Parallel and common-opener workloads have
no demonstrated gain. Root sequential frame-gap p95 is 17.24 versus 16.70 ms;
maximum gaps are 83.32 versus 66.70 ms, inconsistently across pairs and below the
calibrated improvement threshold. No responsiveness improvement is claimed.

No Firefox RAM saving is demonstrated. Final enabled collected allocated heap is
18.145 versus 17.969 MB, and after disabling it is 11.684 versus 11.519 MB. The
respective full A/A ranges are 0.533 and 0.545 MB. Enabled-minus-disabled collected
heap medians are 6.452 versus 6.441 MB; explicit-memory differences are 12.196
versus 12.191 MB. These lifecycle comparisons do not establish increased retained
memory or a memory saving, and do not prove leak freedom. Final resident/unique
memory is 301.941/115.032 versus 299.237/110.985 MB. Approximate sampled extension
RSS peaks are 475.693 versus 471.663 MB, against a 54.624 MB full A/A range. Final
ghost-window counts are zero and orphan DOM bytes are 157,872 in every enabled
final sample. The optional main-runtime GC-heap reporter is unavailable, not zero.

The review includes large uncollected fluctuations. Root sequential allocated
heap rises from 32.715 to 37.683 MB, inconsistently across pairs and within its
6.728 MB A/A range; after cleanup it is 28.070 versus 28.059 MB. Before opener
work, explicit-memory medians are 68.755 versus 186.803 MB, but the candidate is
higher in only two of five pairs and the difference is below the 155.489 MB full
A/A range. After opener-parallel cleanup the medians are 93.857 versus 85.125 MB,
and final collected explicit memory is 29.291 versus 29.087 MB. These variable
unforced readings do not support a natural settled-RAM benefit or a calibrated
regression; the raw ranges and all individual pairs remain in the report.

The standard `benchmark:optim` completed three screening pairs, five matching A/A
pairs and five fresh final confirmation pairs in separate bounded invocations.
It covers 1,000 native tabs across two real sidebars and 100/1,000/10,000 synthetic
tabs across 1/2/9 windows. All 298 metrics were reviewed: 221 without demonstrated
change, 72 unchanged work measures, four demonstrated synthetic improvements and
one synthetic sampled-heap review flag. There are zero Firefox regression flags.
Maximum aggregate owned RSS is 2.632 GB, with at least 65% pressure-free memory;
all final workers completed under the unchanged guards.

The synthetic creation/closure phase, including validation and message-copy work,
improves from 13.216 to 10.024 ms at 100 tabs, 36.544 to 21.636 ms at 1,000 tabs,
and 77.516 to 46.755 ms at 10,000 tabs. These are Node elapsed times, not Firefox
latency or CPU measurements. The fourth qualifying metric is the 10,000-tab
sampled Node heap maximum, 89.178 to 78.435 MB; sparse sampling has the limitation
below, so this is not treated as evidence of reduced actual peak or Firefox RAM.

The standard native retention review includes uncollected added heap after view
cycles, 3.480 to 7.134 MB. This increase is inconsistent across pairs and smaller
than its 5.624 MB full A/A range. Collected total heap at that point is 19.900
versus 19.909 MB and after final disable 11.253 versus 11.255 MB. Collected added
heap increases by 0.127 MB after cycles and 0.118 MB after disable, both
inconsistent and below their 0.188/0.190 MB A/A ranges. The similar disabled
difference does not establish added app retention. Synthetic collected heap after
disposal is 0.028–0.034 MB higher across the three collection sizes (under 0.5%).
That roughly constant overhead also persists after the controller and its caches
are disposed, consistent with extra code/runtime cost rather than retained state
growing with tab count. This small measured Node cost is not hidden by the CPU
gain, and no Firefox RAM saving is claimed.

The standard confirmation flags Node's 100-tab creation/closure sampled heap
maximum: 8.705 to 11.698 MB (+34.4%), with a 0.057 MB A/A range. Three separate instrumented
pairs on the final corrected source used the same 100-tab workload and V8
collection tracing. Including collection-boundary observations exposes baseline
maxima of 11.823–11.824 MB, which the ordinary checkpoints missed. Candidate
observed maxima are 11.747–11.817 MB. The baseline performs four young-generation
collections during the phase; the candidate performs three. Allocation totals
between collections, including fixed phase bookkeeping, are approximately 12.95
versus 12.24 MB. Collected heap is approximately 7.384 versus 7.411 MB.
This supports a collection-timing/sparse-sampling explanation for the apparent
3 MB increase, rather than increased peak or a large retained allocation. Raw
flags remain in the reports. These intrusive Node diagnostics do not establish
timing gains, exact allocation peaks or Firefox RAM benefits.

Validation passed `npm run check`: 714 unit tests, lint and formatting. The 28 new
cache tests cover immutable earlier snapshots, incomplete creation-event records,
concurrent windows, active/pinned/middle-insertion fallbacks, failed reads, metadata
and navigation during reads, selection/move/removal, native movement during awaited
membership writes, large bursts, bounded read counts and both disposal races.
Existing controller contracts cover saved identities, ordering exhaustion, pins,
Later, partial writes, retry, background restart and recovery.

All 20 affected UI suites passed: core, navigation, pane refresh, group actions,
indexed folder actions, move dialog, folder picker, group creation, folder clicks,
tab clicks, tree expansion, pinned tabs, pinned folders, Later, containers, tab
closing, new tab, drag, incremental pages and recently closed. All 13 native
Firefox suites passed: smoke, move dialog, drag, pinned folders, Later, container
picker, tab closing, new tab, domain filtering, tab collection, activity, Find and
published-version upgrade/reload. The upgrade suite verifies same-ID data from
`v0.2.0`, delayed restoration, interrupted move recovery, retry and opaque saved
fields. This does not claim whole-Firefox restart coverage.

Runtime: Node 24.19.0, Firefox 158.0.1, macOS 27.0.1 (26A434), Apple M1 with 16 GiB.
Measurements use owned temporary profiles, no concurrent test/profiling loads and
unchanged normal-pressure, 4 GiB RSS, five-minute worker and 30-minute command
limits. Normal macOS pressure readings are available after execution-sandbox
approval; no guard is bypassed. The final targeted confirmation peaks at 2.360 GB
aggregate owned RSS with at least 65% pressure-free memory. Node heap remains
separate from Firefox RAM. No version bump, signing or publishing is included.

The final 115-file extension export matches both final measured candidates exactly.
`source-equivalence.json` records the comparison.

Evidence is under `test-results/memory/creation-revisit-2026-10-22/`. Final targeted
results are in `targeted-final-confirm/`, calibrated by `targeted-calibration/`.
The standard results are in `standard-final-confirm/`, calibrated by
`standard-calibration/`.
Earlier screens, failed/superseded prototypes and the deliberately cancelled
`standard-confirm/` are preserved separately. Frozen sources, supplementary
harnesses, `corrected-gc-diagnostic/audit.json`, work-count diagnostics and
functional logs are under `output/scratch/creation-revisit-2026-10-22/`.
