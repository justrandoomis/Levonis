/**
 * LEVONIS editor theme (slice S6).
 *
 * Lightweight design tokens copied from the main store's theme
 * (`src/index.css` — olive greens, LEVONIS gold, Cairo type) — token values
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
  /** Store olive family. */
  olive: "#0F2F25",
  oliveDark: "#0A1F18",
  oliveLight: "#184235",
  /** Store gold family. */
  gold: "#BAA369",
  goldLight: "#FFE55C",
  /** Store type stack (Cairo is the store's face; system fallbacks apply). */
  fontSans: '"Cairo", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
} as const;

/** Studio dark surfaces derived from the olive family. */
export const STUDIO_SURFACES = {
  shell: "#0A1410",
  header: "#0E1D17",
  panel: "#122419",
  surface: "#17301F",
  surfaceStrong: "#1E3A28",
  canvas: "#0C1A14",
  line: "#28453A",
  lineSoft: "#1E362C",
  text: "#EEF4EF",
  muted: "#96A99C",
  accent: LEVONIS_TOKENS.gold,
  accentStrong: "#9C8752",
  accentSoft: "#2A2A16",
  accentInk: "#221A08",
  danger: "#E5786A",
  dangerSurface: "#3B2320",
  warning: "#DBA84E",
  warningSurface: "#38301A",
} as const;

const T = STUDIO_SURFACES;

/**
 * Injected into the engine's shadow roots by the S4 adapter. Includes the
 * responsive sidebar rules driven by the `data-levo-sidebar` host attribute
 * (set through `EngineAdapter#setHostAttribute`).
 */
export const EDITOR_SHADOW_CSS = `
  :host { color-scheme: dark; background: ${T.shell} !important; color: ${T.text} !important; font-family: ${LEVONIS_TOKENS.fontSans}; }
  .app-shell { direction: ltr; background: ${T.shell}; color: ${T.text}; }
  .topbar, .left-rail { background: ${T.header}; border-color: ${T.lineSoft}; }
  .tb-btn, .tb-icon, .tb-tabs, .tb-tabs button { background: ${T.surface}; border-color: ${T.line}; border-radius: 6px; color: ${T.text}; }
  .tb-tabs button.on, .left-rail button.on { background: ${T.accent}; color: ${T.accentInk}; }
  .viewport-col { background: ${T.canvas}; }
  .vp-top-toolbar, .plate-bar, .brush-panel, .stats-card, .help-card { background: ${T.header}; border-color: ${T.line}; border-radius: 7px; box-shadow: 0 10px 24px #040806; }
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
    .plate-bar { right: 8px; bottom: 76px; padding: 4px; }
    .plate-bar button { min-width: 44px; height: 44px; }
    .vp-status { bottom: 72px; left: 9px; right: 58px; font-size: 10px; }
    .bed-warn, .stats-card { left: 8px; bottom: 116px; max-width: calc(100% - 68px); }
    .brush-panel { top: 8px; left: 8px; width: min(280px, calc(100vw - 16px)); }
    .sidebar { position: absolute; z-index: 14; top: 0; right: 0; bottom: 62px; width: min(94vw, 420px); flex-basis: auto; box-shadow: -16px 0 34px #040806; }
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
