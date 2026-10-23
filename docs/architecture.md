# Architecture

## Module ownership

Page entry points and HTML filenames remain stable. The background loads `extension/src/background.js`;
Sidebar, Settings, Activity and New tab keep their existing URLs. Supporting modules use direct
ES module imports, without barrel exports or compatibility wrappers.

| Owner                                            | Responsibility                                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/src/sidebar.js`                       | Startup, snapshots and confirmed/pending state, optimistic action queue, move-response recovery, refresh scheduling, pane switching and renderer selection.                            |
| `extension/src/sidebar/controls.js`              | Shared element/button builders and one button-template cache per sidebar.                                                                                                              |
| `extension/src/sidebar/menus.js`                 | Context and collection actions, menu construction, positioning, keyboard navigation and focus return.                                                                                  |
| `extension/src/sidebar/navigation.js`            | Breadcrumb nodes, overflow layout, folder navigation menus, invalidation and resize handling.                                                                                          |
| `extension/src/sidebar/rows.js`                  | Row construction and patching, delegated row interactions, wrappers, row caches, pooled leaves and their release.                                                                      |
| `extension/src/controller.js`                    | Serial request queue, committed model, identities, membership repair, cache invalidation, snapshots, response construction, publication and move recovery.                             |
| `extension/src/controller/preference-actions.js` | Appearance/new-tab validation and commits through the controller; temporary new-tab previews and their failure cleanup.                                                                |
| `extension/src/controller/container-actions.js`  | Container queries, choices and CRUD, using the controller's cache capabilities.                                                                                                        |
| `extension/src/tree/`                            | `index.js` and `projection.js` compute tree data; `geometry.js` and `viewport-range.js` compute layout/ranges; `full-renderer.js`, `viewport.js` and `motion.js` own rendering/motion. |
| `extension/src/new-tab/`                         | Preferences, routing, settings controls and weather, with `new-tab-page.js` remaining the page entry point.                                                                            |

The sidebar creates each subsystem once. Explicit getters read the entry point's current state;
subsystems never import the entry point or copy snapshots. Row preparation, patching and cleanup
share one cache/pool owner. Renderer and motion callbacks use that owner's methods, preserving
stable row identities, focus and interaction ownership without per-row service instances.

The controller calls its helpers inside the existing queue. Helpers do not publish, enter the
queue or keep model copies. Container reopening, folder creation/rollback, placement and
destructive tab operations remain with recovery and membership handling in the controller.
Shared `model.js`, `persistence.js`, `folder-index.js`, `browser-cache.js`,
`presentation-cache.js` and `snapshot-transfer.js` remain separate modules.

Sidebar and Settings link styles in this order: `sidebar.css`, `styles/sidebar-dialogs.css`,
`styles/appearance-picker.css`, `styles/sidebar-controls.css`, then their existing page styles.
Mixed responsive, forced-colour and reduced-motion rules retain their original positions.
The split changes file ownership only, not selectors, specificity or the effective cascade.

## Rendering and appearance

The tab list uses one layout, styled in `extension/tree.css`. Shared appearance tokens live in
`extension/colors.css`; the bottom bar and menus live in `extension/sidebar.css`. Dialog and control rules
continue in `extension/styles/` in their original cascade order.
The sidebar, settings and activity page share this neutral light/dark palette.
Automatic uses the document's preferred colour scheme; Light and Dark are explicit overrides.
The retired theme source is ignored when loading existing preferences and omitted on the next
save. Custom folder and container colours remain explicit choices. Favicons come directly from Firefox.

Trees and filtered result lists over 100 rows use the local viewport renderer in `src/tree/viewport.js`.
`src/tree/geometry.js` builds one geometry record per logical row, including nested branch
endpoints, and finds the visible range with two binary searches. The renderer keeps the
existing adaptive buffers, bounded row reuse, ancestor and interaction ownership. Domain and
Saved search results use the same fixed tab heights; a Saved section heading occupies 34 px
without entering the keyboard row order. Empty search folders have no drop placeholder, since
dragging is disabled while filtering. Smaller lists use `src/tree/full-renderer.js`, which mounts every logically visible row
without a viewport observer. The viewport renderer observes the scroll container directly,
reads current scroll offsets for synchronous reveals/restores, and disconnects its resize
observer and events on disposal. There is no runtime virtualisation
dependency or duplicate measurement cache. The [TanStack experiments](performance/README.md) describe historical prototypes.
Tabernacle search and bulk actions use the complete logical result set. As in the main tree,
native Firefox Find cannot discover unmounted rows in large domain or Saved search results;
the native Find suite covers the full-renderer and extension-page fixtures.

Local folder and nested-tab folds use one height animation per branch in
`src/tree/motion.js`: 100 ms to open and 80 ms to close, regardless of tree size.
Reversals begin at the displayed height and shorten their duration to match the
remaining distance. Related parent/child animations settle before measurement;
unrelated branches can continue independently. There is no per-frame JavaScript
or per-row animation. Closing content becomes inert immediately. Background
updates, search, bulk folding, offscreen actions and reduced motion stay immediate.
Run `node test/ui/test-tree-motion-ui.js` for interruption and accessibility checks.

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
controller snapshot. `src/new-tab/preferences.js` normalises the global `model.newTab`
preferences, defaults the master and weather switches off, and validates up to
60 HTTP(S) links. `setNewTab` merges only changed settings fields and persists them
atomically. `getNewTabState` returns window data and the global page preferences.
New tab pages remain ordinary tabs so links and web searches keep their folder
membership and container; closed copies of the page are excluded from recent history.

Firefox's manifest new-tab override is static, so the extension deliberately has
no `chrome_url_overrides` entry. `src/new-tab/routing.js` synchronously registers
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

`src/new-tab/weather.js` requests only Open-Meteo's geocoding and forecast endpoints.
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
Run `node test/ui/test-pinned-folders-ui.js` and
`node test/firefox/test-pinned-folders-firefox.js` for the new interactions and native
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

Run `node test/ui/test-domain-filter-ui.js` for live updates, safe closing, keyboard
navigation, view restoration, favicon colours and narrow-panel/colour-mode checks, and
`node test/firefox/test-domain-filter-firefox.js` for native Firefox and window isolation.
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

Run `node test/ui/test-drag-ui.js` for destination geometry, continuous hierarchy
navigation, cancellation, folder moves, colour modes and 100/500/1,000-tab scrolling.
`node test/ui/test-move-dialog-ui.js` covers folder search, keyboard selection,
subtree moves, stale destinations, narrow layouts and light/dark/forced colours.
`node test/firefox/test-move-dialog-firefox.js` checks the picker in an isolated native sidebar.
The unit suite injects failures and restarts at compound-operation write boundaries.
`npm run test:firefox` also tests continuous dragging in Firefox's actual sidebar.
For a visible, isolated-profile check, run
`FIREFOX_DRAG_HEADED=1 node test/firefox/test-drag-firefox.js`; preview and result captures
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
`node test/ui/test-activity-page-ui.js` for the page and launcher tests.
`node test/firefox/test-activity-firefox.js` verifies the same actions in an isolated
native Firefox profile.
The design follows Acorn's [in-content typography](https://acorn.firefox.com/latest/desktop/design-tokens/typography-Yo8yPRYS)
and [button guidance](https://acorn.firefox.com/latest/desktop/components/button-gsFv3Uj9),
with system fonts, existing Firefox icons, labelled actions and visible focus.

## Closing tabs

The close button, middle-click and Close tab menu item use `closeTab` with
`promoteFirstChild`: the first child takes the parent's order and the remaining
children use it as their fallback parent. Saved
ancestry keeps the closed parent's identity ahead of that fallback, so Undo
reconnects the original tree. A shared preorder preserves sibling order after
promotion and restoration. Membership changes use the existing move recovery;
failed closes roll them back when the parent is still open. A separate Close tab
and nested tabs context-menu action confirms before closing the whole branch.
Native closes keep their existing behaviour.

`node test/firefox/test-tab-close-firefox.js` checks the native Command+W/Ctrl+W close
path with animations enabled, alongside the sidebar close button, undo and immediate
Settings reopening. Firefox
can return an already invalidated tab ID from `tabs.query()` during its close
animation; failed session reads/writes therefore check that individual ID before
reporting an error and discard the stale native cache after confirming closure.
Internal-page opening also confirms failed IDs and skips closed candidates before
reusing a live page or creating a replacement, avoiding errors and duplicate pages.
Set `FIREFOX_CLOSE_HEADED=1` for a visible run. Evidence is saved in
`test-results/firefox-tab-close.json`.

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

`test/later.test.js`, `test/ui/test-later-ui.js` and `test/firefox/test-later-firefox.js`
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
`test/ui/test-tab-collection-ui.js` covers combined flows, stable review, keyboard
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

`src/tree/projection.js` describes the complete scoped hierarchy separately from
visible navigation. Folded descendants remain addressable without keeping a record
for every hidden row. Established search, domain and Saved for Later helpers remain
authoritative for ordering and collection actions; the controller revalidates action
targets. The renderer exposes update, ensure-visible, capture/restore, suspend and
dispose operations. It retains the existing row builders, nested wrappers and motion
reconciliation. The full renderer mounts every visible logical row, including
offscreen rows; lists over 100 rows use the viewport renderer and native Firefox
Find cannot discover their unmounted rows. Sidebar restoration uses scroll
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
