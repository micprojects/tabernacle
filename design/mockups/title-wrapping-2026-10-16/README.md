# Title wrapping mockups

Generated with the built-in image generation tool on 16 October 2026, using `test-results/domain-filter-320.png` as the layout and style reference. These are design explorations.

- [A: Toolbar button](a-toolbar-button.png)
- [B: Labelled toggle](b-labelled-toggle.png)
- [C: View menu](c-view-menu.png)

A keeps the current toolbar compact. B gives the toggle a visible label but adds a row. C offers one, two or three lines through a menu. Suggested simple-toggle behaviour: single-line titles by default; up to three lines when enabled; ellipsis for longer titles; icons and close controls aligned with the first line.

## Generation prompts

### Option A

```text
Use case: ui-mockup.
Create a high-fidelity, flat, practical UI comparison mockup for the Tabernacle Firefox sidebar. The attached image is a STYLE AND LAYOUT REFERENCE for the actual existing app, not an instruction to redesign it.
Output a landscape presentation image with two equally sized sidebar panels side by side, shown straight on at the SAME SCALE, approximately 320 CSS pixels wide each. Crisp legible system sans-serif typography. A narrow neutral grey surrounding canvas, white panels, thin grey borders. No perspective, device frames, decorative branding, colourful gradients or glossy cards.
Preserve the reference app's search capsule with magnifying glass, a grey removable badge reading "domain:youtube.com", search prompt and X. Preserve its results toolbar with "6 tabs" and dropdown "Newest opened". Preserve the neutral monogram favicons, very compact normal rows, light grey selected row, close X at the right of the selected row, and simple footer icons (plus, folder-plus, fold, history, settings).
Main subject: choosing whether long tab titles remain a single ellipsised line or wrap up to THREE lines. Each panel has exactly the same six tabs in the same order. In the left panel titles are one line and truncate with ellipsis. In the right panel row height grows naturally for long titles, short titles stay compact, all wrapped lines align with the beginning of the title, favicons and close buttons align with first line, no big blank gaps or card borders between rows, max three lines with final ellipsis for overflow. Wrap naturally within actual text column, never insert artificial line breaks in short titles.
Tab titles:
1. "Woodworking tools I wish I had bought sooner"
2. "A quiet playlist for focused work"
3. "How to build a small desk for an awkward corner"
4. "Painting techniques"
5. "Music for working"
6. "Building a bookcase from scratch: measuring, cutting and finishing every shelf in a small workshop" (active, subtle selected background, should truncate after 3 lines if needed).
Put clean modest option title OUTSIDE the app panels at top, then small labels "Single line" and "Wrapped · up to 3 lines" above their respective panels. The sidebar itself contains only functional UI labels. Show enough of each panel to see all six rows and footer without excessive blank space. No annotations covering tab titles. Use the source screenshot's modest radii and monochrome compact style. This is a design exploration, not a marketing poster.
Option title: "A · Toolbar button". Keep exactly ONE results toolbar row below search. At its far right add a small square icon-only button after the "Newest opened" sort dropdown, containing a familiar text-wrap icon: two short horizontal lines and a bent return arrow. Left panel: unselected icon button, thin neutral border. Right panel: selected icon button with pale grey filled background and visible darker border, still monochrome. Keep "6 tabs" on the far left; fit all three controls plausibly within a 320px sidebar. This is a single toggle with tooltip/accessibility name Wrap titles, but don't draw a persistent tooltip or extra toolbar text. Under the panels, one small caption outside the app: "A small toggle beside sort keeps the toolbar compact."
```

### Option B

```text
Use case: ui-mockup.
Create a high-fidelity, flat, practical UI comparison mockup for the Tabernacle Firefox sidebar. The attached image is a STYLE AND LAYOUT REFERENCE for the actual existing app, not an instruction to redesign it.
Output a landscape presentation image with two equally sized sidebar panels side by side, shown straight on at the SAME SCALE, approximately 320 CSS pixels wide each. Crisp legible system sans-serif typography. A narrow neutral grey surrounding canvas, white panels, thin grey borders. No perspective, device frames, decorative branding, colourful gradients or glossy cards.
Preserve the reference app's search capsule with magnifying glass, a grey removable badge reading "domain:youtube.com", search prompt and X. Preserve its results toolbar with "6 tabs" and dropdown "Newest opened". Preserve the neutral monogram favicons, very compact normal rows, light grey selected row, close X at the right of the selected row, and simple footer icons (plus, folder-plus, fold, history, settings).
Main subject: choosing whether long tab titles remain a single ellipsised line or wrap up to THREE lines. Each panel has exactly the same six tabs in the same order. In the left panel titles are one line and truncate with ellipsis. In the right panel row height grows naturally for long titles, short titles stay compact, all wrapped lines align with the beginning of the title, favicons and close buttons align with first line, no big blank gaps or card borders between rows, max three lines with final ellipsis for overflow. Wrap naturally within actual text column, never insert artificial line breaks in short titles.
Tab titles:
1. "Woodworking tools I wish I had bought sooner"
2. "A quiet playlist for focused work"
3. "How to build a small desk for an awkward corner"
4. "Painting techniques"
5. "Music for working"
6. "Building a bookcase from scratch: measuring, cutting and finishing every shelf in a small workshop" (active, subtle selected background, should truncate after 3 lines if needed).
Put clean modest option title OUTSIDE the app panels at top, then small labels "Single line" and "Wrapped · up to 3 lines" above their respective panels. The sidebar itself contains only functional UI labels. Show enough of each panel to see all six rows and footer without excessive blank space. No annotations covering tab titles. Use the source screenshot's modest radii and monochrome compact style. This is a design exploration, not a marketing poster.
Option title: "B · Labelled toggle". Preserve the current results toolbar row with "6 tabs" left and "Newest opened" right. Directly BELOW that row add ONE compact second control row, clearly labelled "Wrap titles" on the left and a small neutral toggle switch aligned to the right. Left panel: switch off with knob left. Right panel: switch on with knob right, dark grey track and white knob. The control row has a subtle bottom divider and compact vertical spacing, not a settings card. Tabs follow below it. Under the panels, one small caption outside the app: "An explicit label is easier to discover, with one extra toolbar row."
```

### Option C

```text
Use case: ui-mockup.
Create a high-fidelity, flat, practical UI comparison mockup for the Tabernacle Firefox sidebar. The attached image is a STYLE AND LAYOUT REFERENCE for the actual existing app, not an instruction to redesign it.
Output a landscape presentation image with two equally sized sidebar panels side by side, shown straight on at the SAME SCALE, approximately 320 CSS pixels wide each. Crisp legible system sans-serif typography. A narrow neutral grey surrounding canvas, white panels, thin grey borders. No perspective, device frames, decorative branding, colourful gradients or glossy cards.
Preserve the reference app's search capsule with magnifying glass, a grey removable badge reading "domain:youtube.com", search prompt and X. Preserve its results toolbar with "6 tabs" and dropdown "Newest opened". Preserve the neutral monogram favicons, very compact normal rows, light grey selected row, close X at the right of the selected row, and simple footer icons (plus, folder-plus, fold, history, settings).
Main subject: choosing whether long tab titles remain a single ellipsised line or wrap up to THREE lines. Each panel has exactly the same six tabs in the same order. In the left panel titles are one line and truncate with ellipsis. In the right panel row height grows naturally for long titles, short titles stay compact, all wrapped lines align with the beginning of the title, favicons and close buttons align with first line, no big blank gaps or card borders between rows, max three lines with final ellipsis for overflow. Wrap naturally within actual text column, never insert artificial line breaks in short titles.
Tab titles:
1. "Woodworking tools I wish I had bought sooner"
2. "A quiet playlist for focused work"
3. "How to build a small desk for an awkward corner"
4. "Painting techniques"
5. "Music for working"
6. "Building a bookcase from scratch: measuring, cutting and finishing every shelf in a small workshop" (active, subtle selected background, should truncate after 3 lines if needed).
Put clean modest option title OUTSIDE the app panels at top, then small labels "Single line" and "Wrapped · up to 3 lines" above their respective panels. The sidebar itself contains only functional UI labels. Show enough of each panel to see all six rows and footer without excessive blank space. No annotations covering tab titles. Use the source screenshot's modest radii and monochrome compact style. This is a design exploration, not a marketing poster.
Option title: "C · View menu". Preserve ONE toolbar row with "6 tabs" on the left, "Newest opened" in the centre and a compact button labelled "View" with a small down chevron at the far right. Arrange sizing plausibly within a 320px sidebar. Left panel SINGLE LINE state has the View dropdown OPEN: small white popover aligned under View button with fine grey border, modest shadow, a muted heading "Tab titles" and exactly three options: "Single line" (checkmark), "Up to 2 lines", "Up to 3 lines". The small menu may overlay the upper results, but leave most rows and their one-line truncation visible. Right panel WRAPPED state has the View menu CLOSED, with the titles wrapped up to three lines visible. Under the panels, one small caption outside the app: "The View menu offers a choice of two or three lines."
```
