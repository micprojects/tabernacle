# Development

The tab list uses one layout, styled in `extension/tree.css`. Colour tokens, the bottom
bar, menus and dialogs live in `extension/sidebar.css`. Favicons come directly from Firefox.

The Firefox add-on ID is `tabernacle@michaelprojects.com`, with saved data under `tabernacle.*`
keys.

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
`test:ui` runs all sidebar UI suites. `npm run test:firefox` runs integration tests with
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
