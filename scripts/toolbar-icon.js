// Let the SVG's browser-chrome context choose its light/dark variant. The
// background page's media query can follow a different website colour setting.
export function toolbarIconSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
  <style>
    .dark {
      display: none;
    }
    @media (prefers-color-scheme: dark) {
      .light {
        display: none;
      }
      .dark {
        display: inline;
      }
    }
  </style>
  <defs>
    <g id="mark" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="0.75" y="0.75" width="14.5" height="14.5" rx="2.75" />
      <path d="M0.75 5.25h14.5M6.25 5.25v10" />
    </g>
  </defs>
  <use class="light" href="#mark" stroke="#5e5e5e" />
  <use class="dark" href="#mark" stroke="#fbfbfb" />
</svg>
`;
}
