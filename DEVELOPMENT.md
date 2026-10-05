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
