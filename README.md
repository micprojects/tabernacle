# Tabernacle

Tabernacle is a Firefox extension I made to help me navigate and organise my tabs. It adds a sidebar with folders, nested tab trees and search.

- Organise tabs into folders and subfolders, and focus on one folder at a time.
- Keep related tabs in collapsible trees, with drag and drop to move or nest them.
- Search folders, tab titles and URLs.
- Use Firefox containers and set default containers for folders.
- Access pinned tabs, mute audio and reopen recently closed tabs.
- Revisit viewed tabs, recently entered folders and closed tabs in one searchable timeline.

Requires Firefox 142 or newer.

## Keep related tabs together

Organise tabs into folders, subfolders and nested trees in your Firefox sidebar.

<img src="assets/screenshots/01-folders-and-tabs-ui.png" width="520" alt="Tabernacle sidebar showing folders, subfolders and nested tabs.">

## Focus on one folder

Open a folder to see just its tabs. Use the folder path to move back up.

<img src="assets/screenshots/02-focus-a-folder-ui.png" width="550" alt="The Copenhagen weekend folder with its tabs and folder path.">

## Find tabs in any folder

Search tab titles, URLs and folder names, including in collapsed folders.

<img src="assets/screenshots/03-search-ui.png" width="550" alt="Search results for grid, showing matching tabs within their folders.">

## Keep sign-ins separate

Choose a Firefox container for new tabs, or set a default container for each folder.

<img src="assets/screenshots/04-folder-containers-ui.png" width="550" alt="The default container dialog with Work selected.">

## Choose how the sidebar looks

Tabernacle follows your Firefox theme automatically. It recognises Firefox Default and Mozilla’s Sun, Spark, Flame, Flare, Lavender, Dusk, Lagoon, Pine, Tide, Ash and Smoke themes, using bundled light/dark palettes and gradients. Other themes use the colours Firefox exposes; Firefox may return their base palette even when a separate dark variant is displayed. Third-party background images are not loaded.

Click the **Settings** cog at the bottom of the sidebar, or use **Preferences** for Tabernacle in Firefox’s Add-ons Manager. Settings open in a full browser tab, with sections for Appearance, Containers, Shortcuts and About.

In **Settings → Appearance**, choose **Follow Firefox** or **Tabernacle**. **Tabernacle colour mode** controls the original palette when selected manually or used as a fallback: **Follow Firefox**, **Light** or **Dark**. Save applies your preferences to every window. You can also show website domains and lines connecting nested tabs.

Theme identification requires Firefox’s **management** permission, which provides installed add-on information. Tabernacle uses it to identify the enabled theme; it does not store or transmit the installed add-on list or change Firefox’s theme. Mozilla palettes are bundled locally, with sources and licences in `extension/themes/NOTICE.txt`. No theme downloads happen at runtime.

<img src="assets/screenshots/05-dark-mode-ui.png" width="550" alt="The sidebar in dark mode with website domains and connecting lines.">

## Keep pinned tabs visible

Pin the sites you use most. They stay visible in every folder.

<img src="assets/screenshots/06-pinned-tabs-ui.png" width="602" alt="Pinned sites above the folder path and tabs.">
