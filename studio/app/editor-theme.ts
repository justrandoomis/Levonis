/**
 * LEVONIS editor theme (slice S6).
 *
 * Lightweight design tokens copied from the main store's theme
 * (`src/index.css` — the LEVONIS greens, LEVONIS gold, Cairo type) — token values
 * only, never store bundles (mandate §2). The same values are mirrored as CSS
 * custom properties in `app/globals.css` (`:root`); keep both in sync when a
 * token changes.
 *
 * `EDITOR_SHADOW_CSS` is the stylesheet the S4 engine adapter injects into
 * every three-slicer shadow root (`EngineAdapter#setThemeCss` /
 * `themeCss` option — style tag `[data-levo-theme]`). It replaces the
 * monolith's inline `EDITOR_SHADOW_CSS` + MutationObserver/500 ms-poll
 * injector: injection is now event-driven inside the adapter. The class names
 * below are the engine's internal ones — the testid/theming contract is
 * exercised by tests/editor-capabilities.test.mjs against the installed
 * three-slicer build.
 *
 * The engine chrome inside the shadow root stays LTR (`direction: ltr` on
 * `.app-shell`): coordinates, axes and technical numbers keep a stable
 * direction under ar/ckb (mandate §5).
 */

/** Store-derived identity tokens (values copied from src/index.css). */
export const LEVONIS_TOKENS = {
  /** Store gold family — the one accent the Studio spends. */
  gold: "#BAA369",
  goldLight: "#FFE55C",
  /** Store type stack (Cairo is the store's face; system fallbacks apply). */
  fontSans: '"Cairo", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
} as const;

/**
 * Studio surfaces — the BLACK system. Mirrors `:root` in app/globals.css, whose
 * comment carries the full rationale; the short version is that the base is
 * true black and elevation is a ladder of neutral greys rather than a hue.
 *
 * These values cross into the ENGINE's shadow roots via EDITOR_SHADOW_CSS
 * below, so the vendored slicer's chrome sits on the same ladder as ours
 * instead of showing its own palette through.
 */
export const STUDIO_SURFACES = {
  shell: "#000000",
  header: "#0A0A0B",
  panel: "#111113",
  surface: "#17171A",
  surfaceStrong: "#212125",
  canvas: "#000000",
  line: "#2C2C31",
  lineSoft: "#1C1C20",
  text: "#F5F5F7",
  muted: "#98989F",
  accent: LEVONIS_TOKENS.gold,
  accentStrong: "#9C8752",
  accentSoft: "#1C180E",
  accentInk: "#171106",
  danger: "#FF453A",
  dangerSurface: "#2A1411",
  warning: "#FF9F0A",
  warningSurface: "#2B1C06",
  success: "#30D158",
  successSurface: "#0E2A16",
  /*
   * Mirrors the tokens of the same name in globals.css, whose :root comment
   * carries the reasoning. They are here because these values cross into the
   * ENGINE's shadow roots through EDITOR_SHADOW_CSS below, and a shadow root
   * cannot see the page's custom properties unless we put them there.
   *
   * `shadowCast` is the one that was wrong rather than missing: the engine
   * chrome cast an olive-tinted shadow, hex 040806, onto a black canvas.
   */
  shadowCast: "#000000",
  idle: "#5B5B63",
  track: "#3A3A40",
} as const;

const T = STUDIO_SURFACES;

/**
 * HOW FAR UP THE ENGINE'S OWN CONTROLS MUST SIT ON A PHONE.
 *
 * The shell's bottom bar is `--mobile-bar-height` (68px) PLUS the safe-area
 * inset, and it is `position: absolute; bottom: 0` over the canvas. The engine
 * parks its plate bar and its status line inside the same canvas, and they
 * were pinned at 76px and 72px — numbers chosen when the bar was shorter and
 * before anyone had a home indicator.
 *
 * On a phone with a 34px inset the bar is ~102px tall, so the plate tabs, the
 * add/remove-plate buttons and the whole status readout were BEHIND it, with
 * no way to reach them: the tray does not re-provide plate switching, only
 * plate-add.
 *
 * So the offsets are computed from the bar rather than guessed next to it.
 * `env(safe-area-inset-bottom)` resolves inside a shadow root exactly as it
 * does on the page — it is a viewport-level value, not an inherited property —
 * which is what lets this stay in sync without the shell passing anything in.
 * tests/theme-tokens.test.mjs pins the 68px against globals.css so the two
 * cannot drift apart again.
 */
const MOBILE_BAR_HEIGHT_PX = 68;
/** Clear of the bar, plus a thumb's worth of margin so the edges do not touch. */
const ABOVE_BAR = `calc(${MOBILE_BAR_HEIGHT_PX}px + env(safe-area-inset-bottom) + 10px)`;
const ABOVE_BAR_TIGHT = `calc(${MOBILE_BAR_HEIGHT_PX}px + env(safe-area-inset-bottom) + 6px)`;

/**
 * Injected into the engine's shadow roots by the S4 adapter. Includes the
 * responsive sidebar rules driven by the `data-levo-sidebar` host attribute
 * (set through `EngineAdapter#setHostAttribute`).
 */
export const EDITOR_SHADOW_CSS = `
  :host { color-scheme: dark; background: ${T.shell} !important; color: ${T.text} !important; font-family: ${LEVONIS_TOKENS.fontSans}; }
  .app-shell { direction: ltr; background: ${T.shell}; color: ${T.text}; }
  .topbar, .left-rail { background: ${T.header}; border-color: ${T.lineSoft}; }
  /* THE ENGINE'S OWN BRAND IS NOT OUR BRAND. The vendored slicer paints a
     "ThreeSlicer RE" wordmark in its top bar, linking to its own root. Inside
     LEVO Studio that is a foreign product name on the owner's page and a link
     that navigates away from the editor. Hidden here, in the CSS the adapter
     already injects into every engine shadow root, rather than by patching
     node_modules — a patch would vanish on the next install and take the fix
     with it. The engine's attribution stays where it belongs: LICENSE.txt and
     THIRD-PARTY-NOTICES.md ship untouched, and the G-code it writes still
     carries its own "application" tag.

     NOTE FOR THE NEXT EDITOR: this comment lives INSIDE a template literal.
     A backtick here ends the string, and a dollar sign followed by a brace
     starts an interpolation. Either one breaks the build. That is exactly
     what happened: a backtick in this very comment failed every Studio
     build for a day, silently, because the error was in the server pass of
     a deploy nobody read. Plain prose only in this block. */
  .tb-logo { display: none !important; }
  .tb-btn, .tb-icon, .tb-tabs, .tb-tabs button { background: ${T.surface}; border-color: ${T.line}; border-radius: 6px; color: ${T.text}; }
  .tb-tabs button.on, .left-rail button.on { background: ${T.accent}; color: ${T.accentInk}; }
  .viewport-col { background: ${T.canvas}; }
  .vp-top-toolbar, .plate-bar, .brush-panel, .stats-card, .help-card { background: ${T.header}; border-color: ${T.line}; border-radius: 7px; box-shadow: 0 10px 24px ${T.shadowCast}; }
  .vp-top-toolbar button:hover:not(:disabled), .left-rail button:hover { background: ${T.surfaceStrong}; }
  .sidebar { background: ${T.panel}; color: ${T.text}; border-color: ${T.line}; }
  .sidebar-scroll, .side-bottom { background: ${T.panel}; }
  .side-bottom { border-color: ${T.line}; }
  .side-card { background: ${T.surface}; border-color: ${T.line}; border-radius: 7px; color: ${T.text}; box-shadow: none; }
  .settings-book { display: flex; flex-direction: column; gap: 6px; }
  .settings-book > details { border: 1px solid ${T.line}; border-radius: 6px; overflow: hidden; background: ${T.panel}; }
  .settings-book > details > summary { min-height: 44px; padding: 11px; cursor: pointer; color: ${T.text}; font-weight: 650; background: ${T.surface}; list-style-position: inside; }
  .settings-book > details[open] > summary { color: ${LEVONIS_TOKENS.goldLight}; border-bottom: 1px solid ${T.line}; }
  .settings-panel, .settings-panel .sp-top, .settings-panel .sp-body, .settings-panel .page,
  .settings-panel .group, .settings-panel .row, .sc-fold-body, .slice-menu,
  .slice-menu button { background: ${T.panel} !important; color: ${T.text} !important; border-color: ${T.line} !important; }
  .settings-panel section, .settings-panel h2, .settings-panel h3,
  .settings-panel .sp-pages, .settings-panel .sp-modes, .settings-panel .sp-builder,
  .settings-panel .inputwrap, .settings-panel .widget-cell { background: transparent !important; color: ${T.text} !important; }
  .settings-panel .row { border-bottom-color: ${T.lineSoft} !important; }
  .settings-panel .sp-pages button, .settings-panel .sp-modes button,
  .settings-panel .bse-modes button, .settings-panel .reset-btn {
    background: ${T.surface} !important; color: ${T.text} !important; border-color: ${T.line} !important;
  }
  .settings-panel .sp-pages button.on, .settings-panel .sp-modes button.on,
  .settings-panel .bse-modes button.on { background: ${T.accent} !important; color: ${T.accentInk} !important; border-color: ${T.accent} !important; }
  .settings-panel h2, .settings-panel h3, .settings-panel .lbl, .settings-panel label,
  .settings-panel summary, .settings-panel .key { color: ${T.text} !important; }
  .settings-panel .key, .settings-panel .muted, .settings-panel small { color: ${T.muted} !important; }
  .settings-panel input:not([type="checkbox"]):not([type="color"]), .settings-panel select,
  .settings-panel textarea, .settings-panel button { background: ${T.shell} !important; color: ${T.text} !important; border-color: ${T.line} !important; min-height: 34px; }
  .settings-panel input[type="checkbox"], .settings-panel input[type="range"] { accent-color: ${T.accent}; }
  .settings-panel option { background: ${T.shell}; color: ${T.text}; }
  .sc-head, .sc-info b, .obj-list2 .obj-name, .side-card .view-type-row, .side-card .slice-layer label, .side-card .grad-title, .sc-fold>summary b { color: ${T.text}; }
  .sc-info, .sc-note, .fil-mat, .side-card .role-legend, .side-card .slice-travel, .sc-fold>summary { color: ${T.muted}; }
  .side-card select, .side-card input:not([type="range"]):not([type="checkbox"]):not([type="color"]), .side-card .obj-ext { background: ${T.shell}; color: ${T.text}; border-color: ${T.line}; }
  .obj-list2 li.obj-selected, .filament-row.fil-active { background: ${T.accentSoft}; box-shadow: inset 3px 0 ${T.accent}; }
  button, .slice-btn, .export-btn, select, input { border-radius: 6px !important; }
  .slice-btn { background: ${T.accent}; color: ${T.accentInk}; }
  .export-btn { background: ${T.surfaceStrong}; color: ${T.text}; border-color: ${T.line}; }
  .empty-hint { display: none !important; }
  @media (max-width: 899px) {
    .app-shell { font-size: 12px; }
    .topbar, .left-rail, .vp-top-toolbar { display: none !important; }
    .plate-bar { right: 8px; bottom: ${ABOVE_BAR}; padding: 4px; }
    .plate-bar button { min-width: 44px; height: 44px; }
    .vp-status { bottom: ${ABOVE_BAR_TIGHT}; left: 9px; right: 58px; font-size: 11px; }
    .bed-warn, .stats-card { left: 8px; bottom: calc(${ABOVE_BAR} + 44px); max-width: calc(100% - 68px); }
    .brush-panel { top: 8px; left: 8px; width: min(280px, calc(100vw - 16px)); }
    .sidebar { position: absolute; z-index: 14; top: 0; right: 0; bottom: ${ABOVE_BAR_TIGHT}; width: min(94vw, 420px); flex-basis: auto; box-shadow: -16px 0 34px ${T.shadowCast}; }
    :host([data-levo-sidebar="closed"]) .sidebar { display: none; }
    :host([data-levo-sidebar="open"]) .sidebar { display: flex; }
    .sidebar-scroll { padding: 8px 8px 82px; }
    .side-bottom { position: absolute; left: 0; right: 0; bottom: 0; }
    .help-card { max-width: calc(100vw - 16px); max-height: calc(100dvh - 90px); overflow: auto; }
  }
  @media (min-width: 900px) {
    .sidebar { display: flex !important; }
  }
`;
