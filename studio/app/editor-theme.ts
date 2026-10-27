/**
 * LEVONIS editor theme (slice S6).
 *
 * Lightweight design tokens: the reference ladder for dark, the store's
 * cream ladder for light (`src/index.css`), LEVONIS gold and Cairo type —
 * token values only, never store bundles (mandate §2). The same values are
 * mirrored as CSS custom properties in `app/globals.css` (`:root` and
 * `:root[data-theme="light"]`); keep both in sync when a token changes.
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
  /** Store gold family — the brand gold the Studio spends. */
  gold: "#BAA369",
  goldLight: "#FFE55C",
  /** Store type stack (Cairo is the store's face; globals.css self-hosts it). */
  fontSans: '"Cairo", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
} as const;

/**
 * Studio surfaces, DARK — the reference ladder. Mirrors `:root` in
 * app/globals.css, whose comment carries the full rationale: a blue-charcoal
 * page, cards one step lighter, raised controls one more, and a sand-gold
 * clay for the one primary.
 *
 * These values cross into the ENGINE's shadow roots via EDITOR_SHADOW_CSS
 * below, so the vendored slicer's chrome sits on the same ladder as ours
 * instead of showing its own palette through.
 */
export const STUDIO_SURFACES = {
  shell: "#121619",
  header: "#1A1F23",
  panel: "#22272C",
  surface: "#282E33",
  surfaceStrong: "#2E343A",
  canvas: "#16191E",
  line: "#2B3036",
  lineSoft: "#1F2429",
  text: "#F2F3F5",
  muted: "#97A2AE",
  accent: "#DCBC8C",
  accentStrong: "#C8A777",
  accentSoft: "#2C2B28",
  accentInk: "#15100A",
  /** Gold as text on this ladder (an open settings page, a selected row). */
  goldText: "#F0D18C",
  danger: "#ED7177",
  dangerSurface: "#3A2427",
  warning: "#F0B35A",
  warningSurface: "#33291A",
  success: "#67CB98",
  successSurface: "#1F3230",
  /*
   * Mirrors the tokens of the same name in globals.css, whose :root comment
   * carries the reasoning. They are here because these values cross into the
   * ENGINE's shadow roots through EDITOR_SHADOW_CSS below.
   *
   * `shadowCast` once carried an olive tint, hex 040806, onto the canvas. In
   * dark it is black.
   */
  shadowCast: "#000000",
  idle: "#5E6873",
  track: "#3A4148",
} as const;

/**
 * Studio surfaces, LIGHT — the site's cream ladder. Mirrors
 * `:root[data-theme="light"]` in app/globals.css. The canvas is the one value
 * that does not change: the engine clears its WebGL canvas to a fixed dark
 * colour, so the viewport is a dark island in both themes and its frame
 * matches it.
 */
export const STUDIO_SURFACES_LIGHT = {
  shell: "#E3DACB",
  header: "#E8E0D1",
  panel: "#EBE4D6",
  surface: "#F0EADF",
  surfaceStrong: "#DDD4C3",
  canvas: "#16191E",
  line: "#CFC5B2",
  lineSoft: "#DDD4C3",
  text: "#16181B",
  muted: "#595C62",
  accent: "#6F592B",
  accentStrong: "#5A4721",
  accentSoft: "#E6DCC6",
  accentInk: "#F6F1E7",
  goldText: "#6A5426",
  danger: "#AD3037",
  dangerSurface: "#F1D9D3",
  warning: "#87520A",
  warningSurface: "#F1E2C4",
  success: "#165C3A",
  successSurface: "#DADACA",
  /** A warm ink, as the site's light clay uses; black would grey the cream. */
  shadowCast: "#3A2E1C47",
  idle: "#8B8478",
  track: "#CFC5B2",
} as const satisfies Record<keyof typeof STUDIO_SURFACES, string>;

type SurfaceKey = keyof typeof STUDIO_SURFACES;

/**
 * The custom property each surface becomes inside the engine's shadow root.
 * One set of rules below reads them, and the host attribute
 * `data-levo-theme` (set by the shell from app/theme.ts) picks which values
 * are in force — so a theme change is an attribute flip, not a re-injected
 * stylesheet.
 */
function surfaceVars(surfaces: Record<SurfaceKey, string>): string {
  return (Object.keys(surfaces) as SurfaceKey[])
    .map((key) => `--lv-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${surfaces[key]};`)
    .join(" ");
}

/** `var(--lv-…)` for a surface key, so the rules below cannot misspell one. */
const T = Object.fromEntries(
  (Object.keys(STUDIO_SURFACES) as SurfaceKey[]).map((key) => [
    key,
    `var(--lv-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)})`,
  ]),
) as Record<SurfaceKey, string>;

/**
 * HOW FAR UP THE ENGINE'S OWN CONTROLS SIT ON A PHONE.
 *
 * They used to clear the shell's 68px bottom bar plus the safe-area inset
 * (ABOVE_BAR). The phone shell has no bottom bar now: the canvas is a card in
 * the middle of a scrolling column (globals.css, THE PHONE SHELL), so the
 * plate bar, the status line and the stats card only need to clear the card's
 * rounded corner, `--engine-dock-gap` in globals.css. When the viewport is
 * expanded over the whole screen the card's edge is the screen's edge, and
 * then the safe-area inset is added back. tests/theme-tokens.test.mjs pins
 * both numbers to each other.
 */
const ENGINE_DOCK_GAP_PX = 8;
const DOCK_BOTTOM = "var(--lv-dock-bottom)";
/**
 * SIMPLE MODE: THE ENGINE CONTROLS IT HIDES (P1-10; GAP-MAP conflict 23).
 *
 * The engine's object toolbar renders every action in its table, and the ten
 * below have no implementation behind them in the installed build: they are
 * drawn as disabled buttons (no `run`, so `disabled` is set). Spec section 10
 * and rule 18 ask that a person be shown only what really works, so Simple
 * mode removes them. Advanced keeps the engine exactly as it is.
 *
 * Arrange, Orient and Cut are on this list because the ENGINE's buttons are
 * the dead ones: the working versions are the shell's own (the desktop
 * shell-actions strip and the mobile tool tray), visible in both modes.
 *
 * tests/editor-capabilities.test.mjs reads the installed engine and fails the
 * moment one of these gains a `run` — a control that starts working must not
 * stay hidden by a list nobody re-reads.
 */
export const SIMPLE_MODE_HIDDEN_ENGINE_TOOLS = [
  "tool-arrange",
  "tool-orient",
  "tool-cut",
  "tool-boolean",
  "tool-negative",
  "tool-seam",
  "tool-mmu",
  "tool-text",
  "tool-measure",
  "tool-varlayer",
] as const;

const SIMPLE_HIDDEN_SELECTOR = SIMPLE_MODE_HIDDEN_ENGINE_TOOLS
  .map((id) => `:host([data-levo-mode="simple"]) [data-testid="${id}"]`)
  .join(", ");

/**
 * The toolbar's group separators that only introduced a hidden group, so
 * Simple does not end the toolbar in a row of empty dividers. Its own rule:
 * an engine without `:has()` drops only this cosmetic rule, never the one
 * that hides the controls.
 */
const SIMPLE_ORPHAN_SEPARATOR_SELECTOR = SIMPLE_MODE_HIDDEN_ENGINE_TOOLS
  .map((id) => `:host([data-levo-mode="simple"]) .vtt-sep:has(+ [data-testid="${id}"])`)
  .join(", ");

/**
 * Injected into the engine's shadow roots by the S4 adapter. Includes the
 * responsive sidebar rules driven by the `data-levo-sidebar` host attribute
 * and the Simple-mode rules driven by `data-levo-mode` (both set through
 * `EngineAdapter#setHostAttribute`).
 */
export const EDITOR_SHADOW_CSS = `
  :host { ${surfaceVars(STUDIO_SURFACES)} --lv-dock-bottom: ${ENGINE_DOCK_GAP_PX}px; color-scheme: dark; background: ${T.shell} !important; color: ${T.text} !important; font-family: ${LEVONIS_TOKENS.fontSans}; }
  :host([data-levo-theme="light"]) { ${surfaceVars(STUDIO_SURFACES_LIGHT)} color-scheme: light; }
  :host([data-levo-viewport="expanded"]) { --lv-dock-bottom: calc(env(safe-area-inset-bottom) + ${ENGINE_DOCK_GAP_PX}px); }
  /* WHAT FLOATS ON THE CANVAS STAYS PART OF THE ISLAND. The gizmo rail, the
     view toolbar, the plate tabs and the stats card sit on (or against) the
     dark canvas, and the rail and toolbar draw their icons as light images.
     In the light theme they keep the dark values, re-declared on those
     elements, so their icons do not fade into a cream panel. */
  :host([data-levo-theme="light"]) :is(.left-rail, .vp-top-toolbar, .plate-bar, .stats-card, .bed-warn, .brush-panel) { ${surfaceVars(STUDIO_SURFACES)} color-scheme: dark; }
  /* THE CANVAS IS A DARK ISLAND IN BOTH THEMES: the engine clears it to a
     fixed dark colour, so the frame around it stays dark too. */
  .viewport-col { background: ${T.canvas}; }
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
  .tb-tabs button.on, .left-rail button.on, .plate-tab.on { background: ${T.accent}; color: ${T.accentInk}; border-color: ${T.accentStrong}; }
  .vp-top-toolbar, .plate-bar, .brush-panel, .stats-card, .help-card { background: ${T.header}; border-color: ${T.line}; border-radius: 7px; box-shadow: 0 10px 24px ${T.shadowCast}; }
  .vp-top-toolbar button:hover:not(:disabled), .left-rail button:hover { background: ${T.surfaceStrong}; }
  .sidebar { background: ${T.panel}; color: ${T.text}; border-color: ${T.line}; }
  .sidebar-scroll, .side-bottom { background: ${T.panel}; }
  .side-bottom { border-color: ${T.line}; }
  .side-card { background: ${T.surface}; border-color: ${T.line}; border-radius: 7px; color: ${T.text}; box-shadow: none; }
  .settings-book { display: flex; flex-direction: column; gap: 6px; }
  .settings-book > details { border: 1px solid ${T.line}; border-radius: 6px; overflow: hidden; background: ${T.panel}; }
  .settings-book > details > summary { min-height: 44px; padding: 11px; cursor: pointer; color: ${T.text}; font-weight: 650; background: ${T.surface}; list-style-position: inside; }
  .settings-book > details[open] > summary { color: ${T.goldText}; border-bottom: 1px solid ${T.line}; }
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
  /* A READ-ONLY CARD STAYS READABLE. The engine draws a read-only panel (here
     the printer card, with the motion limits folded into it) at opacity .62
     on its wrapper, which took every label in it to 2.6:1 on the light cards
     and 3.1:1 on the dark ones (WCAG 1.4.3 asks 4.5:1). The wrapper is inert,
     which is what makes it read-only; so the labels go back to full
     strength, and only the inactive controls inside keep the dimming that
     says they cannot be changed. Plain prose only in this comment. */
  .vp-readonly { opacity: 1 !important; }
  .vp-readonly :is(input, select, textarea, button:not(.lbl)) { opacity: .62; }
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
    .plate-bar { right: 8px; bottom: ${DOCK_BOTTOM}; padding: 4px; }
    .plate-bar button { min-width: 44px; height: 44px; }
    /* One line in the card: the full keyboard hint is a desktop affordance,
       and three lines of it covered a third of a phone-sized viewport. */
    .vp-status { bottom: ${DOCK_BOTTOM}; left: 9px; right: 104px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bed-warn, .stats-card { left: 8px; bottom: calc(${DOCK_BOTTOM} + 52px); max-width: calc(100% - 68px); }
    /* Below the shell's overlay toolbar, which owns the top 50px of the card. */
    .brush-panel { top: 54px; left: 8px; width: min(280px, calc(100vw - 16px)); }
    /* z-index 33, not 14 — «عندما اضغط على زر الاعدادات قائمة اختار الملف
       تصير امام الاعدادات».

       NO BACKTICKS IN THIS COMMENT: it lives inside a template literal, and a
       stray one silently ends the stylesheet.

       The engine lives in a shadow root, and a shadow host creates NO stacking
       context of its own. So this panel's z-index has never been scoped to the
       engine — it competes directly with the shell's own layers in the root
       stacking context, where .empty-upload-card sits at 18. That card is a
       hint on an empty bed, not a modal and never meant to be one, and at 14
       this panel lost to it: the Files card painted over the settings the
       person had just opened.

       33 puts the panel above that card and still below the import
       progress row (46) — which must stay visible
       over everything, because it is the only sign that a file is loading. */
    .sidebar { position: absolute; z-index: 33; top: 0; right: 0; bottom: ${DOCK_BOTTOM}; width: min(94vw, 420px); flex-basis: auto; box-shadow: -16px 0 34px ${T.shadowCast}; }
    :host([data-levo-sidebar="closed"]) .sidebar { display: none; }
    :host([data-levo-sidebar="open"]) .sidebar { display: flex; }
    .sidebar-scroll { padding: 8px 8px 82px; }
    .side-bottom { position: absolute; left: 0; right: 0; bottom: 0; }
    .help-card { max-width: calc(100vw - 16px); max-height: calc(100dvh - 90px); overflow: auto; }
  }
  @media (min-width: 900px) {
    .sidebar { display: flex !important; }
  }
  /* SIMPLE MODE (P1-10, owner decision S6: the default for everyone). The
     engine side panel goes at EVERY width: these rules come last and the
     host-attribute selector outranks both width rules above, the desktop
     one marked important included. What stays, in both modes: the stats card
     (the slicing estimate and the over-bed warning), the bed warning, the
     status line and the plate bar, which all live outside the side panel,
     and the shell's own messages, stale banner and slice action. What the
     engine keeps only inside the panel (its slow-slice warning and its
     simplified-retry offer) the shell carries itself, in both modes.
     Slicing still runs: the shell drives the engine through the adapter,
     which does not need the panel to be visible. Plain prose only in this
     comment, see the note near the top of this stylesheet. */
  :host([data-levo-mode="simple"]) .sidebar { display: none !important; }
  ${SIMPLE_HIDDEN_SELECTOR} { display: none !important; }
  ${SIMPLE_ORPHAN_SEPARATOR_SELECTOR} { display: none !important; }
`;
