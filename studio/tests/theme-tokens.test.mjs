/**
 * THE BLACK SYSTEM IS THE ONLY SYSTEM, AND IT IS SPELLED IN TOKENS.
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
 * Everything inside `:root { … }` — where a literal is not only allowed but
 * required. Taken from the COMMENT-STRIPPED text, so that removing it from the
 * body below actually removes it: the block in the original source is mostly
 * prose, and subtracting that string from the stripped rules matches nothing.
 */
const root = /:root\s*\{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? "";
assert.ok(root.length > 400, "the :root block should be findable and substantial");
/** The rules a component is actually painted by — every declaration outside :root. */
const body = rules.replace(root, "");

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

test("the ladder itself is black, not a tinted near-black", () => {
  // A near-black with a hue is the exact thing the owner asked to be rid of,
  // and it is hard to see in isolation — #0A0C05 looks black until it sits
  // next to one. The base and the canvas must be pure.
  for (const token of ["--shell", "--canvas"]) {
    const value = new RegExp(`${token}:\\s*([^;]+);`).exec(root)?.[1]?.trim();
    assert.equal(value, "#000000", `${token} must be true black`);
  }
  // And every neutral in the ladder must be neutral: R, G and B within a
  // couple of steps of each other. An olive grey fails this; a real grey does not.
  for (const token of ["--header", "--panel", "--surface", "--surface-strong", "--line", "--line-soft", "--text", "--muted", "--idle", "--track"]) {
    const value = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6});`).exec(root)?.[1];
    assert.ok(value, `${token} is missing from :root`);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(spread <= 8, `${token} (${value}) carries a hue — spread ${spread}`);
  }
});

test("gold is the only accent, and the semantics are the only other colours", () => {
  const hues = (root.match(/^\s*--([\w-]+):\s*(#[0-9A-Fa-f]{6});/gm) ?? [])
    .map((line) => /--([\w-]+):\s*(#[0-9A-Fa-f]{6})/.exec(line))
    .filter(Boolean)
    .map(([, name, value]) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
      return { name, value, spread: Math.max(r, g, b) - Math.min(r, g, b) };
    })
    .filter((t) => t.spread > 8)
    .map((t) => t.name);

  // Every coloured token must be accounted for: the gold family, or one of the
  // four semantic families and the ink that goes on them. A fifth family
  // appearing here is a second accent, which §7 of the skill forbids.
  const allowed = /^(levo-gold|accent|accent-strong|accent-ink|accent-tint|accent-tint-border|on-accent-tint|on-accent-muted|muted-on-tint|danger|danger-surface|danger-border|on-danger|warning|warning-surface|warning-border|warning-ink|on-warning|success|success-surface)$/;
  const strays = hues.filter((name) => !allowed.test(name));
  assert.deepEqual(strays, [], `unexplained coloured tokens — a second accent is forbidden: ${strays.join(", ")}`);
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

test("the engine shadow theme mirrors the page, so a shadow root is not a hole", () => {
  // These values cross into the vendored engine's shadow roots, which cannot
  // see the page's custom properties. If the two drift, the engine's own
  // chrome keeps the previous palette and shows it through the middle of the
  // app — which is exactly how the olive survived the first black pass.
  for (const [token, key] of [
    ["--shell", "shell"],
    ["--header", "header"],
    ["--panel", "panel"],
    ["--surface", "surface"],
    ["--surface-strong", "surfaceStrong"],
    ["--line", "line"],
    ["--line-soft", "lineSoft"],
    ["--text", "text"],
    ["--muted", "muted"],
    ["--idle", "idle"],
    ["--track", "track"],
  ]) {
    const page = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6});`).exec(root)?.[1];
    const shadow = new RegExp(`\\b${key}:\\s*"(#[0-9A-Fa-f]{6})"`).exec(theme)?.[1];
    assert.ok(page, `${token} missing from globals.css :root`);
    assert.ok(shadow, `${key} missing from STUDIO_SURFACES`);
    assert.equal(shadow.toUpperCase(), page.toUpperCase(), `${token} and STUDIO_SURFACES.${key} have drifted`);
  }
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
  // It described "a very dark olive family" for as long as the file was black.
  // A header comment is the first thing the next editor reads, and one that
  // describes the previous design is worse than none.
  const header = css.slice(0, css.indexOf(":root"));
  assert.ok(!/olive family/i.test(header) || /no longer/i.test(header), "the header still advertises the olive palette");
  assert.match(css, /THE BLACK SYSTEM/, "the rationale for the ladder must stay with it");
});

test("the engine chrome is parked above the shell's bar, from the same number", () => {
  /**
   * The shell's bottom bar is `--mobile-bar-height` plus the safe-area inset,
   * absolutely positioned over the canvas. The engine parks its plate bar and
   * its status line inside that same canvas, and those offsets were hard-coded
   * at 76px and 72px — chosen when the bar was shorter and before anyone had a
   * home indicator. On a phone with a 34px inset the bar is ~102px tall, so
   * the plate tabs and the whole status readout sat BEHIND it, unreachable:
   * the tool tray re-provides plate-ADD but never plate switching.
   *
   * Both sides now derive from one number. This is the test that keeps them
   * derived from the SAME one.
   */
  // `:root` carries a desktop default and the mobile block OVERRIDES it, so
  // the number to compare against is the one in force below 900px — which is
  // the only width the engine's mobile rules apply at.
  assert.ok(/--mobile-bar-height:\s*\d+px/.test(root), "--mobile-bar-height must be a token");
  const shadow = /const MOBILE_BAR_HEIGHT_PX = (\d+);/.exec(theme)?.[1];
  assert.ok(shadow, "editor-theme.ts must name the bar height it is clearing");
  const mobile = /@media \(max-width: 899px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const inForce = /--mobile-bar-height:\s*(\d+)px/.exec(mobile)?.[1];
  assert.equal(
    inForce,
    shadow,
    "editor-theme.ts and the mobile --mobile-bar-height disagree — the engine would be parked at the wrong height"
  );

  // And every engine element that lives at the bottom of the canvas clears it,
  // safe area included. A bare `bottom: NNpx` here is the bug coming back.
  const shadowCss = /EDITOR_SHADOW_CSS = `([\s\S]*?)\n`;/.exec(theme)?.[1] ?? "";
  const mobileShadow = /@media \(max-width: 899px\) \{([\s\S]*?)\n {2}\}/.exec(shadowCss)?.[1] ?? "";
  assert.ok(mobileShadow.length > 200, "the engine's mobile block should be findable");
  for (const selector of [".plate-bar", ".vp-status", ".sidebar"]) {
    const rule = new RegExp(`\\${selector}[^{]*\\{[^}]*\\}`).exec(mobileShadow)?.[0] ?? "";
    assert.ok(rule, `${selector} should have a mobile rule`);
    assert.ok(
      /bottom:\s*(calc\()?\$\{ABOVE_BAR/.test(rule),
      `${selector} must clear the shell bar — found: ${/bottom:[^;]*/.exec(rule)?.[0]}`
    );
  }
  assert.match(theme, /env\(safe-area-inset-bottom\)/, "the inset must be part of the offset");
});
