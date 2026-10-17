![Tabernacle icon](extension/icons/tabernacle-128.png)

# Tabernacle

Tabernacle is a Firefox extension I made to help me navigate and organise my tabs. It adds a sidebar with folders, nested tab trees and search.

- Organise tabs into folders and subfolders, and focus on one folder at a time.
- Keep related tabs in collapsible trees, with drag and drop to move or nest them.
- Search folders, tab titles and URLs.
- Use Firefox containers and set default containers for folders.
- Choose Automatic, Light or Dark colour mode for the neutral appearance.
- Access pinned tabs and folders, mute audio and reopen recently closed tabs.
- Revisit viewed tabs, recently opened folders and closed tabs in one searchable timeline.

Requires Firefox 142 or newer.

## Keep related tabs together

Organise tabs into folders, subfolders and nested trees in your Firefox sidebar.

<img src="assets/screenshots/01-folders-and-tabs-ui.png" width="520" alt="Tabernacle sidebar showing folders, subfolders and nested tabs.">

## Focus on one folder

Open a folder to see just its tabs. Use the folder path to move back up.

<img src="assets/screenshots/02-focus-a-folder-ui.png" width="550" alt="The Copenhagen weekend folder with its tabs and folder path.">

## Find tabs in any folder

Search tab titles, URLs and folder names, including in collapsed folders.

Right-click a tab and choose **Filter by domain** to see that site's tabs from every folder
in the current window as a flat list, including pinned tabs. A dedicated header shows
the site's favicon on a softly tinted background. When a site name can be resolved
from open tab titles, it appears above the smaller domain; otherwise the domain is the heading.
The result count and sort menu sit above the list. Newest opened comes first by default;
you can also choose Recently viewed, Oldest opened, Title A–Z or Tree order.
Result titles wrap automatically to a maximum of three lines.
Tabs without a recorded opening time follow dated tabs in tree order.
The filter stays open as you visit or close tabs; closing a result preserves its nested tabs.
If Firefox selects a tab outside the filtered list after a close, Tabernacle activates
the nearest result above, or below when there isn't one above.
Use the large close button or press Escape to return to your previous folder view.

On YouTube, **Enhanced** replaces the count with a remembered toggle. It starts on
and shows thumbnails, channels, folders, duplicate indicators and video progress where
available. Switch it off to use the standard domain list. The All, In progress and
Duplicates filters keep each tab separate.
Hover over a result (or focus it with the keyboard) for **Show in folder** and
**Copy video link**. Titles omit YouTube's notification count; known progress is
shown as a slim bar beneath the thumbnail.

Choose **Allow access** once to enable YouTube channel lookups and read duration and
playback position from loaded tabs. Only visible videos are checked, every five seconds;
sleeping tabs stay asleep. Saved positions have a Last seen tooltip; missing progress
is left blank. This is observed tab progress, not your account's watch history.
Thumbnails and public metadata contact YouTube directly. Metadata requests omit credentials
and referrers; thumbnails omit referrers. Playback positions stay in Firefox's tab session
data. No API key is needed.

Other supported sites have the same remembered **Enhanced** switch in the domain view:

| Mode                                    | Extra context                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Reddit                                  | Subreddit, post flair, comment count and available post images. Comment links stay distinguishable from posts. |
| Hacker News                             | Story source, comment count and Ask HN / Show HN labels.                                                       |
| GitHub                                  | Repository, page type, issue/PR number and observed open, closed, draft or merged state.                       |
| Shopping (Amazon, eBay, Etsy)           | Product image, observed price and selected options where available.                                            |
| Wikipedia                               | Article image, short description and linked section.                                                           |
| Documents (Google Docs, Sheets, Slides) | File type, clean title and the current sheet or slide where available.                                         |
| Maps (Google Maps)                      | Place name, category and address.                                                                              |
| Film (IMDb, Letterboxd)                 | Poster, release year, runtime and director.                                                                    |

Related tabs are labelled **Same thread**, **Same file**, **Same product**, or similar.
They remain separate: comments, document locations and selected product options can differ.
Maps enhancement is offered when filtering from a Maps tab; other Google pages retain their normal rows.
These modes enrich the existing domain results without changing folders or the filter's scope.

Choose **Allow access** for the site to read details from its loaded tabs. Only visible rows
are checked, sleeping tabs stay asleep, and missing details are omitted. Detail tooltips show
when information was last read; prices and issue states are observations, not live guarantees.
The extension retries unavailable details with increasing delays. Sign-in pages, consent
screens and site challenges may prevent enrichment until the page is available normally.
The last observation stays in that tab's Firefox session data. Turning a mode off restores
the standard list and stops its reads. Site access can be removed in Firefox's extension settings.

Images load from the source site's image hosts without referrers. Hacker News can also use
its public API without credentials. The other modes read the loaded page and do not fetch
private document contents, account history or a separate copy of the page.

<img src="assets/screenshots/03-search-ui.png" width="550" alt="Search results for grid, showing matching tabs within their folders.">

## Save tabs for later

Right-click a tab and choose **Save for later** to move it out of the tree. Open
**Saved for Later** from the bookmark-and-clock button before Domains in the bottom
bar. The newest saved tabs appear first; search titles and URLs, switch to oldest
first, or use the **Articles**, **Videos** and **Documents** filters. The filters
recognise common page URLs; other pages remain in **All**.

Clicking a saved tab activates it and leaves it in the list. Hover or focus a row
to return it to its original folder or close it. Saving a parent leaves its children
in the tree. Returning it restores its previous position and nesting where possible;
if its folder has been deleted, it returns to Home. Pinned tabs return to the pinned strip.

Saved tabs remain real Firefox tabs in their current window, retaining their containers
and page state. Membership is kept in Firefox session data across extension reloads
and session restoration. Closing a saved tab removes it from the list; restoring that
closed tab also restores its saved status. This feature does not save offline copies
or synchronise tabs between devices.

## Keep sign-ins separate

Choose a Firefox container for new tabs, or set a default container for each folder.

<img src="assets/screenshots/04-folder-containers-ui.png" width="550" alt="The default container dialog with Work selected.">

### Folder containers apply to new tabs

A folder’s default container is used for new tabs you create in that folder through Tabernacle. Setting a default or dragging existing tabs between folders doesn’t change those tabs’ containers.

For example, if a folder’s default is **Work**, new tabs created there use Work. Dragging a **Personal** tab into that folder leaves it in Personal, with its existing sign-ins.

To change an existing tab’s container, right-click it and choose **Reopen in container…**.

## Keep pinned tabs and folders visible

Pin the sites and folders you use most. Their icons stay visible in every folder.

<img src="assets/screenshots/06-pinned-tabs-ui.png" width="602" alt="Pinned sites above the folder path and tabs.">

## Pick up where you left off

Return to viewed tabs and folders. Reopen tabs you’ve closed.

<img src="assets/screenshots/07-recent-activity-ui.png" width="550" alt="Recent activity showing viewed tabs, closed tabs and folders, with filters and a link to the full activity page.">
