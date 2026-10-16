# Screenshot favicon fixtures

These are website favicons saved from the public demo tabs for repeatable
screenshot capture. `sources.json` records each source. Firefox-provided data URLs were
decoded without changing their pixels. The Google Maps icon comes from Google's public
favicon URL; the live page can redirect fresh browser profiles to a consent page.

The GitHub fixture combines its official light- and dark-mode favicon colours in one SVG
with a `prefers-color-scheme` media query. Its path is unchanged; the fill switches from
`#24292E` to white so the logo remains visible in either sidebar theme. Both original
sources are recorded in `sources.json`.

The icons identify the example websites in real Firefox tabs. They are not Tabernacle
artwork and are not included in the extension build. Their respective owners retain all
rights to their logos and marks. Update the corresponding `favicon` and `faviconType`
fields in `../screenshots.json` when replacing an icon, and record its source here.
