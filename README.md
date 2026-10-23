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

Use a tab's close button or middle-click to close just that tab. Its first child
takes its place, with the other children nested beneath it. Undo restores the
original tree. To close the whole branch, right-click and choose **Close tab and
nested tabs…**, then confirm.

<img src="assets/screenshots/01-folders-and-tabs-ui.png" width="520" alt="Tabernacle sidebar showing folders, subfolders and nested tabs.">

## Focus on one folder

Open a folder to see just its tabs. Use the folder path to move back up.

<img src="assets/screenshots/02-focus-a-folder-ui.png" width="550" alt="The Copenhagen weekend folder with its tabs and folder path.">

## Find tabs in any folder

Search tab titles, original URLs and folder names within the current folder and its
subfolders, including collapsed folders. Home searches the current window. Matching
saved tabs appear in a separate **Saved for Later** section, newest first, with their
folder paths. Clicking activates the existing tab and keeps it saved; returning or
closing an item keeps your search open. Searching does not request page access.

Right-click a tab and choose **Filter by domain** to see that site's tabs from every folder
in the current window as a flat list, including pinned tabs. A dedicated header shows
the site's favicon on a softly tinted background. When a site name can be resolved
from open tab titles, it appears above the smaller domain; otherwise the domain is the heading.
The result count and sort menu sit above the list. Newest opened comes first by default;
you can also choose Recently viewed, Least recently viewed, Oldest opened, Title A–Z
or Tree order. Least recently viewed shows a quiet age label with the exact date in
its tooltip; unknown dates follow dated tabs. Use the compact domain search to match
titles and original URLs while retaining the selected sort and site filters.
Result titles wrap automatically to a maximum of three lines.
Tabs without a recorded opening time follow dated tabs in tree order.
The filter stays open as you visit or close tabs; closing a result preserves its nested tabs.
If Firefox selects a tab outside the filtered list after a close, Tabernacle activates
the nearest result above, or below when there isn't one above.
Press ⌘/Ctrl K to focus the search for your current view: domain, Saved for Later or
ordinary search. Escape dismisses an open menu or dialog first, then clears a populated
domain search when its field is focused; otherwise it returns to folders. The large
close button also returns to folders. When you opened a site from Domains, **Back to
Domains** restores your place in that directory. Pinned domains remain listed with
one matching tab, including a subdomain; at zero they hide but retain their pin.

<img src="assets/screenshots/03-search-ui.png" width="550" alt="Search results for grid, showing matching tabs within their folders.">

## Process tabs together

Right-click a folder to **Save tabs for later**, including tabs in its subfolders and
pinned tabs. The domain actions menu can save, copy URLs or close the complete current
result set, including rows below the viewport. The domain search defines that set.
Saving offers one **Undo** for the batch. Closing shows the count and any pinned tabs
before you confirm. Copying retains original article URLs, query parameters and
fragments in result order.

Choose **Review duplicates…** from Domains, a domain's actions, a folder's context
menu or Saved for Later's actions. Domains reviews the whole current window, including
saved tabs; other entry points review their folder or current results. Only identical
complete HTTP(S) source URLs in the same Firefox container form a group. Reader View
uses its source URL. Related-file and related-thread labels do not imply exact duplicates.

Review the suggested checkboxes and choose **Close N tabs**. Pinned, current and audible
tabs start unselected; otherwise the most recently viewed copy is kept. You can adjust
the choices but must keep at least one copy per group. Changed or closed tabs are skipped,
and newly opened tabs are never added to an existing review.

## Save tabs for later

Right-click a tab and choose **Save for later** to move it out of the tree. Open
**Saved for Later** from the tray button before Domains in the bottom
bar. The newest saved tabs appear first; search titles and URLs or switch to oldest
first. Each row shows the tab’s favicon and title, wrapped to at most three lines.
The full title and website address remain in its tooltip.

Clicking a saved tab activates it and leaves it in the list. Hover or focus a row
to return it to its original folder or close it. Saving a parent leaves its children
in the tree. Returning it restores its previous position and nesting where possible;
if its folder has been deleted, it returns to Home. Pinned tabs return to the pinned strip.
Returning keeps your search, sort and scroll position, with focus moving to the
nearest remaining row. Use **Show in folder** in the confirmation to navigate deliberately.

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
