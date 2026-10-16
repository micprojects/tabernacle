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

<img src="assets/screenshots/03-search-ui.png" width="550" alt="Search results for grid, showing matching tabs within their folders.">

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
