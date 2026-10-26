/**
 * THE SYSTEM IS SPELLED IN TOKENS — NOW IN TWO THEMES.
 *
 * CHANGED DELIBERATELY (plan item C6, decision D-14, DECISIONS row 271). This
 * file used to pin the BLACK system: pure #000000 and neutral greys. The
 * owner's later instruction is to match the reference screens, which are blue
 * charcoal with a sand-gold clay, in dark AND light. So the ladder tests below
 * now pin the reference ladder in dark and the site's cream ladder in light,
 * each kept close to grey on its own axis; everything else this file guards
 * (no literal colour in a rule, a type floor, a radius scale, the engine
 * mirror) stands and now covers both themes.
 *
 * WHY THIS EXISTS. The Studio moved from a dark OLIVE palette to black in one
 * pass over `:root`. That pass was real and it was not enough: roughly thirty
 * colours further down globals.css were written out as hex — #5F7268 for a
 * resting status dot, #3C5448 for a spinner ring, #45564C for a switch,
 * #050B08 for every shadow, #D3DED5 for text — and every one of them was
 * olive. They survived the change because nothing forced anyone to re-read the
 * rules, so the "black" Studio kept a green cast on precisely the small
 * repeated details the eye notices: a dot, a ring, a toggle, a card edge.
 *
 * The lesson is not "those thirty were wrong". It is that a design system
 * which allows a literal anywhere will accumulate a second palette, and the
 * second palette is invisible until a screenshot arrives. So: no raw colour in
 * a rule. If a value is needed and no token says it, the answer is a new token
 * with a name, not a hex code at the point of use.
 *
 * The same argument applies to two other kinds of literal:
 *   - a TYPE SIZE below the floor. Captions here were set at 8.5px and 8.8px.
 *     That is unreadable on a phone in Latin and illegible in Arabic, whose
 *     letterforms carry meaning in marks that vanish first — and this app is
 *     aimed at small screens above all. Quiet is a colour and a weight, not a
 *     size below reading (apple-design skill §5).
 *   - a CORNER RADIUS invented per rule. 6px and 7px were used
 *     interchangeably across the same screens; the difference is invisible
 *     individually and reads as sloppiness collectively (skill §2, §8).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../app/globals.css", import.meta.url);
const themeUrl = new URL("../app/editor-theme.ts", import.meta.url);

const css = await readFile(cssUrl, "utf8");
const theme = await readFile(themeUrl, "utf8");

/**
 * The stylesheet with comments removed.
 *
 * The comments deliberately QUOTE the old olive palette — that history is why
 * the rules look the way they do, and deleting it would leave the next editor
 * to rediscover it. So the rules are what is asserted on, never the prose.
 */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The two token blocks — `:root { … }` (dark, the default) and
 * `:root[data-theme="light"] { … }` — where a literal is not only allowed but
 * required. Taken from the COMMENT-STRIPPED text, so that removing them from
 * the body below actually removes them.
 */
const root = /:root\s*\{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? "";
const light = /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? "";
assert.ok(root.length > 400, "the :root block should be findable and substantial");
assert.ok(light.length > 400, "the light block should be findable and substantial");
/** The rules a component is actually painted by — every declaration outside the token blocks. */
const body = rules.replace(root, "").replace(light, "");

/** A token's 6-digit hex value in a block, upper-cased; null when absent. */
const hexOf = (block, token) => new RegExp(`--${token}:\\s*(#[0-9A-Fa-f]{6});`).exec(block)?.[1]?.toUpperCase() ?? null;
/** The value in force in a theme: light inherits what it does not re-declare. */
const themeHex = (theme, token) => (theme === "light" ? hexOf(light, token) : null) ?? hexOf(root, token);

test("no rule in the stylesheet spells a colour out", () => {
  const literals = body.match(/#[0-9A-Fa-f]{3,8}\b/g) ?? [];
  assert.deepEqual(
    literals,
    [],
    `these colours bypass the ladder — give each one a token in :root instead: ${[...new Set(literals)].join(", ")}`
  );
});

test("no rule names a colour by any other spelling either", () => {
  // rgb()/rgba()/hsl() are the obvious way around the check above. `rgba(0,0,0,…)`
  // inside :root is how --shadow is defined and is fine; outside it is not.
  const functional = body.match(/\b(?:rgba?|hsla?)\s*\(/g) ?? [];
  assert.deepEqual(functional, [], "define the colour as a token in :root and reference it");
  // And the named colours, which are the quietest way of all to reintroduce one.
  for (const named of ["white", "black", "red", "green", "blue", "grey", "gray"]) {
    const hit = new RegExp(`:\\s*${named}\\b`).exec(body);
    assert.equal(hit, null, `"${named}" used as a colour value: ${hit?.[0]}`);
  }
});

/**
 * THE LADDERS, EACH ON ITS OWN AXIS.
 *
 * Dark is the reference's blue charcoal; light is the site's cream. A neutral
 * may lean only one way per theme and only a little: blue at or above red in
 * dark, red at or above blue in light, and never far from grey. That is what
 * keeps an olive (green high, blue low) or a stray warm cast out of the dark
 * ladder, which is how the old palette survived once already.
 */
const LADDER = ["shell", "canvas", "header", "panel", "surface", "surface-strong", "line", "line-soft", "well", "card-1", "card-2",
  "text", "text-2", "muted", "ink-disabled", "field", "idle", "track"];

test("the dark ladder is the reference's blue charcoal, and stays close to grey", () => {
  assert.equal(themeHex("dark", "shell"), "#121619", "the page is the reference ground");
  assert.equal(themeHex("dark", "panel"), "#22272C", "cards are the reference card");
  assert.equal(themeHex("dark", "surface"), "#282E33", "raised controls are the reference raised fill");
  for (const token of LADDER) {
    const value = themeHex("dark", token);
    assert.ok(value, `--${token} is missing from :root`);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    assert.ok(b >= r, `--${token} (${value}) leans warm in the dark ladder`);
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 26, `--${token} (${value}) is a colour, not a neutral`);
  }
});

test("the light ladder is the site's cream, and the viewport stays a dark island", () => {
  assert.equal(themeHex("light", "shell"), "#E3DACB", "the light page is the site's IVORY");
  assert.equal(themeHex("light", "panel"), "#EBE4D6", "light cards are the site's PAPER");
  // The engine clears its canvas to a fixed dark colour; the frame matches it.
  assert.equal(themeHex("light", "canvas"), themeHex("dark", "canvas"));
  for (const token of LADDER.filter((name) => name !== "canvas")) {
    const value = themeHex("light", token);
    assert.ok(value, `--${token} has no light value`);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    // The grounds lean warm; the inks are the site's neutral greys
    // (#16181b, #45484e), which lean a hair blue and stay grey.
    const ink = ["text", "text-2", "muted", "ink-disabled"].includes(token);
    if (!ink) assert.ok(r >= b, `--${token} (${value}) leans cold in the light ladder`);
    // The site's cream is warmer than the charcoal is blue: its hairline
    // #cfc5b2 spreads 29 and its field edge #7c715c 32. Copied values, so the
    // bound follows them.
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 32, `--${token} (${value}) is a colour, not a neutral`);
  }
});

test("gold is the only accent, and the semantics are the only other colours", () => {
  // Every coloured token in either block must be accounted for: the gold
  // family, one of the four semantic families and the ink that goes on them,
  // or ink drawn on the dark canvas. A fifth family appearing here is a second
  // accent, which §7 of the skill forbids.
  const allowed = /^(levo-gold|accent|accent-strong|accent-ink|accent-tint|accent-tint-border|on-accent-tint|on-accent-muted|muted-on-tint|gold-1|gold-2|gold-ink|gold-text|gold-line|gold-outline-fill|gold-edge|focus|danger|danger-surface|danger-border|on-danger|warning|warning-surface|warning-border|warning-ink|on-warning|success|success-surface|success-border|success-icon|success-caption|on-canvas|on-canvas-muted|on-canvas-line|knob|shadow-cast)$/;
  for (const [name, block] of [[":root", root], ["light", light]]) {
    const coloured = (block.match(/^\s*--([\w-]+):\s*(#[0-9A-Fa-f]{6});/gm) ?? [])
      .map((line) => /--([\w-]+):\s*(#[0-9A-Fa-f]{6})/.exec(line))
      .filter(Boolean)
      .map(([, token]) => token)
      .filter((token) => !LADDER.includes(token));
    const strays = coloured.filter((token) => !allowed.test(token));
    assert.deepEqual(strays, [], `${name}: unexplained coloured tokens — a second accent is forbidden: ${strays.join(", ")}`);
  }
});

/**
 * CONTRAST, COMPUTED FROM THE TOKENS, IN BOTH THEMES (WCAG 2.x, sRGB).
 * Text 4.5:1; a non-text boundary 3:1 (1.4.11) — the field edge, the focus
 * ring, the gold-outline edge, and in light the 1px edge that gives a sand
 * selection its boundary on a cream card (sand itself is about 1.2:1 there).
 */
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test("both themes meet contrast on every surface they paint", () => {
  const TEXT = [
    ["text", "shell"], ["text", "panel"], ["text", "surface"], ["text", "well"], ["text", "card-1"], ["text", "card-2"],
    ["text-2", "shell"], ["text-2", "panel"], ["muted", "shell"], ["muted", "panel"], ["muted", "surface"],
    ["gold-ink", "gold-1"], ["gold-ink", "gold-2"], ["gold-text", "shell"], ["gold-text", "panel"], ["gold-text", "surface"],
    ["text", "gold-outline-fill"], ["accent-ink", "accent"],
    ["success", "success-surface"], ["success-caption", "success-surface"],
    ["on-warning", "warning-surface"], ["on-danger", "danger-surface"],
    ["on-canvas", "canvas"], ["on-canvas-muted", "canvas"],
  ];
  const BOUNDARY = [["field", "surface"], ["field", "panel"], ["focus", "shell"], ["focus", "panel"], ["gold-line", "gold-outline-fill"], ["success-icon", "success-surface"]];
  for (const mode of ["dark", "light"]) {
    for (const [fg, bg] of TEXT) {
      const ratio = contrast(themeHex(mode, fg), themeHex(mode, bg));
      assert.ok(ratio >= 4.5, `${mode}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, below 4.5`);
    }
    for (const [fg, bg] of BOUNDARY) {
      const ratio = contrast(themeHex(mode, fg), themeHex(mode, bg));
      assert.ok(ratio >= 3, `${mode}: --${fg} against --${bg} is ${ratio.toFixed(2)}:1, below 3`);
    }
  }
  // The light sand selection: the fill alone cannot carry the boundary, so
  // the edge drawn by --clay-gold must.
  assert.ok(contrast(themeHex("light", "gold-1"), themeHex("light", "panel")) < 3, "if sand alone passed, the edge would be decoration");
  for (const bg of ["panel", "surface", "well"]) {
    assert.ok(contrast(themeHex("light", "gold-edge"), themeHex("light", bg)) >= 3, `light gold edge on --${bg}`);
  }
  assert.match(root, /--clay-gold:[^;]*0 0 0 1px var\(--gold-edge\)/, "the sand selection draws its edge");
});

test("nothing is set below the type floor", () => {
  const sizes = [...rules.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
  const tooSmall = sizes.filter((size) => size < 11);
  assert.deepEqual(
    tooSmall,
    [],
    `Arabic at this size is not quiet, it is unreadable — use var(--text-caption): ${tooSmall.join("px, ")}px`
  );
});

test("corners come from the radius scale", () => {
  // 99px is a pill — a shape, not a radius on the scale — and 50% is a circle.
  const radii = [...rules.matchAll(/border-radius:\s*([\d.]+)px/g)]
    .map((m) => Number(m[1]))
    .filter((value) => value !== 99);
  assert.deepEqual(radii, [], `invented radii — use --radius-sm / --radius / --radius-lg / --radius-sheet: ${radii.join("px, ")}px`);
});

test("touch targets keep their floor, and the floor is a token", () => {
  const tapMin = /--tap-min:\s*(\d+)px/.exec(root)?.[1];
  assert.equal(tapMin, "44", "44px is the floor for anything tappable (skill §6, §12)");
});

test("the engine shadow theme mirrors the page in both themes, so a shadow root is not a hole", () => {
  // These values cross into the vendored engine's shadow roots, which get
  // them as --lv-* properties. If the two drift, the engine's own chrome
  // keeps the previous palette and shows it through the middle of the app —
  // which is exactly how the olive survived the first black pass.
  const pairs = [
    ["shell", "shell"], ["canvas", "canvas"], ["header", "header"], ["panel", "panel"], ["surface", "surface"],
    ["surface-strong", "surfaceStrong"], ["line", "line"], ["line-soft", "lineSoft"], ["text", "text"],
    ["muted", "muted"], ["idle", "idle"], ["track", "track"],
  ];
  const surfaces = (name) => {
    const at = theme.indexOf(`export const ${name} = {`);
    assert.ok(at > 0, `${name} is missing from editor-theme.ts`);
    return theme.slice(at, theme.indexOf("}", at));
  };
  for (const [mode, name] of [["dark", "STUDIO_SURFACES"], ["light", "STUDIO_SURFACES_LIGHT"]]) {
    const block = surfaces(name);
    for (const [token, key] of pairs) {
      const page = themeHex(mode, token);
      const shadow = new RegExp(`\\b${key}:\\s*"(#[0-9A-Fa-f]{6})"`).exec(block)?.[1];
      assert.ok(page, `--${token} missing for ${mode}`);
      assert.ok(shadow, `${key} missing from ${name}`);
      assert.equal(shadow.toUpperCase(), page, `--${token} (${mode}) and ${name}.${key} have drifted`);
    }
  }
  // The light values reach the engine through its host attribute.
  assert.match(theme, /:host\(\[data-levo-theme="light"\]\) \{ \$\{surfaceVars\(STUDIO_SURFACES_LIGHT\)\}/);
});

test("the engine chrome casts a black shadow, not a tinted one", () => {
  const shadowCast = /\bshadowCast:\s*"(#[0-9A-Fa-f]{6})"/.exec(theme)?.[1];
  assert.equal(shadowCast, "#000000");
  // And no rule inside EDITOR_SHADOW_CSS spells a colour out, for the same
  // reason as the stylesheet: the shadow roots are where a stray palette hides.
  const shadowCss = /EDITOR_SHADOW_CSS = `([\s\S]*?)\n`;/.exec(theme)?.[1] ?? "";
  assert.ok(shadowCss.length > 500, "EDITOR_SHADOW_CSS should be findable");
  const literals = shadowCss.replace(/\/\*[\s\S]*?\*\//g, "").match(/#[0-9A-Fa-f]{3,8}\b/g) ?? [];
  assert.deepEqual(literals, [], `use a STUDIO_SURFACES token: ${[...new Set(literals)].join(", ")}`);
});

test("the file header describes the design that is actually in the file", () => {
  // It described "a very dark olive family" for as long as the file was black,
  // and then the black system for as long as it was not. A header comment is
  // the first thing the next editor reads, and one that describes the previous
  // design is worse than none.
  const header = css.slice(0, css.indexOf(":root"));
  assert.ok(!/olive family/i.test(header) || /no longer/i.test(header), "the header still advertises the olive palette");
  assert.match(header, /two themes/i, "the header must say there are two themes");
  assert.match(header, /black system[\s\S]{0,120}no longer/i, "the header must say the black system is gone");
  assert.match(css, /THE REFERENCE LADDER/, "the rationale for the ladder must stay with it");
});

test("the engine chrome docks inside the viewport card, from the same number", () => {
  /**
   * CHANGED DELIBERATELY WITH THE PHONE SHELL. The engine's plate bar, status
   * line and side panel used to clear the shell's 68px bottom bar plus the
   * safe-area inset — a bar that sat over the canvas and once hid the plate
   * tabs behind it. The reference column has no bottom bar: the canvas is a
   * card in a scrolling page, so the engine's chrome only clears the card's
   * rounded corner, and the safe-area inset comes back only when the viewport
   * is expanded over the whole screen. Both sides still derive from one
   * number, and this is the test that keeps them derived from the SAME one.
   */
  assert.doesNotMatch(rules, /--mobile-bar-height/, "the bottom bar is gone; nothing should still be clearing it");
  const page = /--engine-dock-gap:\s*(\d+)px/.exec(root)?.[1];
  assert.ok(page, "--engine-dock-gap must be a token");
  const shadow = /const ENGINE_DOCK_GAP_PX = (\d+);/.exec(theme)?.[1];
  assert.equal(shadow, page, "editor-theme.ts and globals.css disagree on the dock gap");

  const shadowCss = /EDITOR_SHADOW_CSS = `([\s\S]*?)\n`;/.exec(theme)?.[1] ?? "";
  assert.match(shadowCss, /:host\(\[data-levo-viewport="expanded"\]\) \{ --lv-dock-bottom: calc\(env\(safe-area-inset-bottom\) \+ \$\{ENGINE_DOCK_GAP_PX\}px\); \}/,
    "the expanded viewport is the screen's edge, so it clears the safe area");
  const mobileShadow = /@media \(max-width: 899px\) \{([\s\S]*?)\n {2}\}/.exec(shadowCss)?.[1] ?? "";
  assert.ok(mobileShadow.length > 200, "the engine's mobile block should be findable");
  for (const selector of [".plate-bar", ".vp-status", ".sidebar"]) {
    const rule = new RegExp(`\\${selector}[^{]*\\{[^}]*\\}`).exec(mobileShadow)?.[0] ?? "";
    assert.ok(rule, `${selector} should have a mobile rule`);
    assert.ok(/bottom:\s*\$\{DOCK_BOTTOM\}/.test(rule), `${selector} must dock from the one number — found: ${/bottom:[^;]*/.exec(rule)?.[0]}`);
  }
});

/**
 * WHAT A SHEET PROMISES, IT HAS TO DO.
 *
 * The bar across the top of a bottom sheet is a learned affordance — on a
 * phone it means "drag me down". It was a decorative `<div className=
 * "sheet-handle" />` with no handlers at all, so the gesture every user tries
 * first did nothing. The dialog also declared `aria-modal` while leaving focus
 * on the page behind it and ignoring Escape, so a keyboard or a screen reader
 * never entered it.
 *
 * These are source guards because the defect is an absence: every screenshot
 * of the sheet looked correct, and the handle looked exactly like a handle.
 */
test("the sheet handle is a control, not a decoration", async () => {
  const shell = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  const handle = /<div\s+className="sheet-handle"[\s\S]*?\/>/.exec(shell)?.[0] ?? "";
  assert.ok(handle, "the handle should be findable");
  assert.match(handle, /onPointerDown=\{beginSheetDrag\}/, "it must start a drag");
  assert.match(handle, /role="button"/, "and announce itself as one");
  assert.match(handle, /tabIndex=\{0\}/, "reachable by keyboard…");
  assert.match(handle, /onKeyDown=/, "…and operable by it");
  assert.match(handle, /aria-label=\{t\.close\}/, "with a name that says what it does");
});

test("the drag clamps, decides, and never leaves the sheet mid-air", async () => {
  const shell = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  const drag = /const beginSheetDrag = useCallback\([\s\S]*?\n  \}, \[\]\);/.exec(shell)?.[0] ?? "";
  assert.ok(drag, "beginSheetDrag should be findable");
  // Pointer events, so a mouse and a stylus behave like a finger.
  assert.match(drag, /setPointerCapture/, "the gesture must stay attached when the finger leaves the bar");
  assert.match(drag, /Math\.max\(0,/, "upward travel is clamped — a bottom sheet has a defined top edge");
  // Both ways a real person performs this: a long pull, and a fast flick.
  assert.match(drag, /height \/ 3/, "a pull past a third closes");
  assert.match(drag, /travelled \/ elapsed/, "and so does a flick");
  // Every listener comes off, on every ending — including a cancelled pointer.
  for (const ending of ["pointerup", "pointercancel"]) {
    assert.ok(drag.includes(`addEventListener("${ending}"`), `missing ${ending}`);
  }
  assert.match(drag, /removeEventListener\("pointermove", move\)/);
  assert.match(drag, /setSheetDrag\(0\)/, "and the sheet returns to the CSS transition's control");
});

test("a modal dialog behaves like one", async () => {
  const shell = await readFile(new URL("../app/slicer-client.tsx", import.meta.url), "utf8");
  // Escape, and focus that starts inside — the two things `aria-modal` implies
  // and neither of which was there.
  const effect = /if \(!sheet\) return;\n\s*sheetRef\.current\?\.focus\(\);[\s\S]*?\}, \[sheet\]\);/.exec(shell)?.[0] ?? "";
  assert.ok(effect, "the sheet focus/escape effect should be findable");
  assert.match(effect, /event\.key === "Escape"/);
  assert.match(effect, /removeEventListener\("keydown", onKey\)/, "and the listener comes off with the sheet");
  assert.match(shell, /aria-modal="true"/);
  assert.match(shell, /ref=\{sheetRef\}/);
  assert.match(shell, /tabIndex=\{-1\}/, "the dialog itself has to be focusable to receive focus");
});

test("the handle's touch target is the row, not the 4px bar", async () => {
  // 4px is a line, not a target. The padded row around it is what a thumb
  // hits; ::before is what the eye sees.
  const stylesheet = await readFile(cssUrl, "utf8");
  // There are two `.sheet-handle` rules: the desktop one, which hides it, and
  // the mobile one inside @media (max-width: 899px), which is the sheet people
  // actually drag. Anchor on the multi-line one so the single-line desktop
  // `display: none` cannot satisfy the assertions below.
  const rule = /\.sheet-handle \{\n[\s\S]*?\n {2}\}/.exec(stylesheet)?.[0] ?? "";
  assert.ok(rule, "the mobile handle rule should be findable");
  assert.ok(!/display: none/.test(rule), "this must be the mobile rule, not the desktop one");
  assert.match(rule, /width: 100%/);
  assert.match(rule, /height: 22px/);
  assert.match(rule, /touch-action: none/, "or the browser scrolls instead of dragging");
  assert.match(stylesheet, /\.sheet-handle::before \{[^}]*width: 40px;[^}]*height: 4px;/, "the bar keeps its familiar size");
  assert.match(stylesheet, /\.sheet-handle:focus-visible \{[^}]*outline:/, "and it shows focus (skill §12)");
});

test("every token the projects panel reads is actually defined here", async () => {
  /**
   * THE SILENT ONE.
   *
   * `components/projects-panel.tsx` ships its own <style> block built on a
   * `--levo-*` family it inherited from a different product, each with a
   * hard-coded fallback: `var(--levo-ok, #3fbf6f)`, `var(--levo-warn,
   * #e2a93b)`. Six of the eight were mapped onto the black ladder in :root.
   * Two were missed, so the fallback fired and the panel's "synced" and
   * "degraded" badges were painted in that other product's green and amber.
   *
   * A missing custom property is silent BY DESIGN — the fallback is the
   * feature, and it is precisely why the gap survived a full theme pass and a
   * screenshot review. This test is the thing that is not silent.
   */
  const panel = await readFile(new URL("../app/components/projects-panel.tsx", import.meta.url), "utf8");
  const referenced = [...new Set([...panel.matchAll(/var\((--levo-[a-z-]+)/g)].map((m) => m[1]))];
  assert.ok(referenced.length >= 6, `expected the panel's token family, saw ${referenced.length}`);
  const missing = referenced.filter((token) => !new RegExp(`^\\s*${token}:`, "m").test(root));
  assert.deepEqual(missing, [], `unmapped — the panel will silently use its own palette: ${missing.join(", ")}`);

  // And each one resolves to a token from OUR ladder, not to another literal.
  for (const token of referenced) {
    const value = new RegExp(`${token}:\\s*([^;]+);`).exec(root)?.[1]?.trim();
    assert.match(value ?? "", /^var\(--[\w-]+\)$/, `${token} must map onto the ladder, not restate a colour`);
  }
});

test("LTR is pinned to readouts, not to sentences", () => {
  /**
   * MANDATE §5 SAYS THE 3D VIEWPORT AND TECHNICAL READOUTS STAY LTR WHILE THE
   * CHROME FOLLOWS THE LOCALE. The rule was right and it had been applied at
   * the wrong level: `direction: ltr` sat on fourteen CONTAINERS whose content
   * is localised prose — the notice bar, the stale banner, the import toast,
   * every capability paragraph in the about sheet, the safety note, and most
   * of the connect sheet.
   *
   * A container's direction is the BASE DIRECTION the bidi algorithm resolves
   * an Arabic sentence against. Get it wrong and trailing punctuation lands at
   * the wrong end and any embedded Latin — a filename, a preset id — is
   * ordered against the rest of the line. It is not a cosmetic setting.
   *
   * These are the containers that may keep it, and why. Anything else that
   * acquires it should have to justify itself here first.
   */
  const ALLOWED = [
    ".viewport-mount",       // the 3D canvas — coordinates and axes
    ".studio-status",        // a technical state readout
    ".studio-actions",       // an icon row whose order is physical, not textual
    ".shell-actions",        // likewise: a strip pinned to a screen edge, past
                             // the engine's own rail, whose buttons carry one
                             // word each — no sentence for a base direction to
                             // reorder, and a physical order to preserve
    ".editor-loader small",  // the profile/bed string
    ".empty-upload-card > p",// the accepted-format list
    ".cut-number",           // a millimetre value
    ".cut-extent",           // a millimetre range
    ".profile-grid",         // Latin model names and bed dimensions
    ".segmented-control",    // layer heights and wall counts
    ".switch",               // a physical control
    ".studio-sheet > header span", // the technical subtitle
    ".print-action-grid",    // file formats
    ".connection-method-tabs",
    ".lan-connection-form",  // an IP, a serial, an access code
    ".discovered-printers button small",
    ".connected-printer-card strong, .connected-printer-card small",
  ];

  /**
   * Rules are found by SPLITTING the stylesheet, not by a regex that has to
   * span one.
   *
   * The first version used `(?:[^}]*\n)*?` to reach across a multi-line rule
   * body — the classic catastrophic-backtracking shape, which on a thousand-
   * line stylesheet simply did not finish. Cutting at every `}` gives one
   * selector and one body per piece, in linear time, and says the same thing
   * more plainly.
   */
  const all = [...new Set(
    rules
      .split("}")
      .filter((piece) => piece.includes("direction: ltr"))
      .map((piece) => {
        const brace = piece.lastIndexOf("{", piece.indexOf("direction: ltr"));
        const selector = brace === -1 ? "" : piece.slice(0, brace);
        // A rule inside a media query carries the @media line ahead of it in
        // the same piece; the selector is the last non-empty line before `{`.
        return selector.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
      })
      .filter(Boolean)
  )];

  const unexplained = all.filter((selector) => !ALLOWED.includes(selector));
  assert.deepEqual(
    unexplained,
    [],
    `direction: ltr on a container that holds localised prose — add it to ALLOWED with a reason, or remove it: ${unexplained.join(" | ")}`
  );
});

test("nothing aligns text by a physical edge", () => {
  /**
   * `text-align: left` is a PHYSICAL direction: in an RTL locale it pins text
   * to the wrong edge of its own box. `start` is the same thing in LTR and the
   * correct thing in RTL, and the repo already used it elsewhere — four rules
   * had drifted, and they were inside containers that have just stopped being
   * force-LTR, so the mismatch was about to become visible.
   */
  for (const physical of ["text-align: left", "text-align: right"]) {
    assert.ok(!rules.includes(physical), `${physical} — use start/end`);
  }
  // The same argument for box edges. `left:`/`right:` are legitimate for
  // something pinned to the viewport (a floating bar, the engine's own rail),
  // so this only guards the text-flow properties.
  for (const physical of ["margin-left:", "margin-right:", "padding-left:", "padding-right:"]) {
    assert.ok(!rules.includes(physical), `${physical} — use the -inline- logical property`);
  }
});
