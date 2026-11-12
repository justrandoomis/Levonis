/**
 * A WINDOW FITS THE SCREEN IT IS ON — iPhone Safari included.
 *
 * «the exit button on iphone on safari on order admin does not present»
 * (owner, 2026-11-11).
 *
 * THE CAUSE. Every window is laid out in the Overlay layer, `fixed inset-0`.
 * On iOS Safari that layer is the VISIBLE area, between the status bar and the
 * toolbar, while `vh` is the LARGE viewport — measured as if the toolbar had
 * collapsed. In the admin it never collapses (the shell is `h-dvh` and scrolls
 * inside itself, so the document never does). The order window was 92vh tall
 * and anchored to the bottom edge, so it rose above the top of the screen by
 * 92% of the large viewport less the visible height, where nothing scrolls to.
 *
 * WHAT THE GEOMETRY SHOWS, AND WHAT IT DOES NOT. The X's 44px target sits
 * 17–61px below the window's top and its 20px glyph 29–49px, so the X is lost
 * once the window rises about 49px or more above the screen. With the 750 /
 * 664px large / visible split modelled for a 390×844 iPhone it rose only
 * ~26px — the title's top and the top of the X's target, not the glyph — so
 * that emulation does NOT reproduce the report: the owner's phone evidently
 * has the wider split (about 110px between the two viewports at a 664px
 * visible height), which Safari's other tab-bar layouts or iOS 26 geometry
 * can give. Nothing here ran in WebKit or on an iPhone; the cap below holds
 * whatever the split is.
 *
 * WHY A SOURCE TEST. Chromium has no large/small viewport split outside a
 * phone, so 92vh fits in every headless window and no browser test here can
 * see the bug. What can be pinned is the contract that makes it impossible:
 *
 *   1. The primitive caps every panel at its layer, less the status bar
 *      (src/index.css, `[data-overlay-panel]`, in the components layer so a
 *      caller's own `max-h-*` utility still wins). It is also the fallback
 *      where a browser has no dvh: the dvh value is dropped and the cap stands.
 *   2. No window panel in src/ sizes itself in the large viewport — vh, lvh,
 *      and vb, vmin and vmax, which iOS Safari also measures on the large
 *      viewport, or h-screen — but in dvh. (A deliberate vh fallback may stand
 *      only under `not-supports-[height:1dvh]:`.)
 *   3. The order window: 92dvh / 88dvh, its close X inside a header that sits
 *      outside the scrollers.
 *   4. A large-viewport height anywhere else in src/ is a decision, listed
 *      below with why it cannot push a window's header off an iPhone screen.
 *
 * AND THE CAP DOES NOT SCROLL (the review of 9b2cf01d). Before it, a window
 * taller than the screen lost its TOP; capped, it loses its BOTTOM — and the
 * bottom is where a form's Save and the unsaved-changes question are. So:
 *
 *   5. Every window found taller than a small iPhone's visible screen scrolls
 *      itself: `max-h-[…dvh] overflow-y-auto` on an Overlay's panel, or the v2
 *      sheet (`dragHandle`), whose body scrolls. Small means an iPhone SE in
 *      Safari (375×553); the checks of 9b2cf01d and faf5ad1c went down to
 *      320×460 (an SE with Display Zoom), where two more windows did not fit.
 *      Measured in headless Edge: the serial edit's Keep / Discard, the gift
 *      grant's «منح الهدية», a grant's last action and the scanner's
 *      typed-serial row were below the bottom edge at 390×664 or 375×553; the
 *      customer's install sheet (iOS Safari's steps) filled an SE in English
 *      (558px of content), and at 320×460 lost both of its answers in Arabic,
 *      English and Sorani — with Reduce Motion, which takes its drag away,
 *      leaving no way out on the screen at all; and at 320×460 the admin's
 *      member editor, which has no X and no scrim exit, put Cancel and Save
 *      below the edge. With these, each is on screen and takes a tap. (Not
 *      every window was measured at 320×460.)
 *   6. A `dirty` window's question can never be pushed off: it lands inside
 *      the panel's scroll, or under a body that shrinks for it.
 *   7. The whole-panel sheet (Overlay.tsx's `Sheet`) cannot scroll under a
 *      finger: motion's `drag="y"` gives the panel `touch-action: pan-x`, so a
 *      vertical swipe drags the sheet instead (headless Edge, touch: a v1
 *      sheet with a panel scroller did not move; a v2 sheet's body scrolled
 *      225px). A tall sheet is the v2 one; the ones that scroll their panel
 *      today are listed, and a new one fails. A sheet is v2 only when it comes
 *      from ui/Sheet with a v2 prop really on (`dragHandle={false}` is the
 *      whole-panel sheet), under whatever name the file imports it.
 *   8. From `sm` up the v2 sheet draws no grabber, where the whole-panel sheet
 *      drew one at every width; a sheet moved to v2 whose content leaned on it
 *      for its top spacing gets that space back (`sm:pt-5`).
 *
 * Why not `overflow-y: auto` on the cap itself: every window would clip what
 * hangs outside its panel. The shop's search window is just its field; the
 * results drop down outside it (LiveSearchPanel, `absolute top-full`), and an
 * overflow on that panel cuts them off (measured: hit-testable as shipped,
 * not with the panel's overflow set to auto).
 *
 * Run: node --import tsx --test tests/overlayViewportFit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
/** Source with comments removed: a rule explained in prose must not satisfy itself. */
const code = (path: string) =>
  read(path)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const cssCode = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '');

/** Every source file under src/, forward slashes. */
const SRC = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
  .map((f) => `src/${f.split('\\').join('/')}`)
  .filter((f) => /\.(tsx?|css)$/.test(f));

/** Splits `sm:not-supports-[height:1dvh]:h-[88vh]` into its variants and utility, at bracket depth 0. */
function parts(token: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of token) {
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (ch === ':' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A browser without dvh — the only variant under which a bare vh height may stand. */
const NO_DVH = 'not-supports-[height:1dvh]';
/**
 * A length in the LARGE viewport: `92vh`, `90lvh`, `80vmax`, `60vb`. iOS
 * Safari measures vh, vb, vmin and vmax on the large viewport, as if the
 * toolbar had collapsed; dvh, svh, dvmax and the like are not matched.
 */
const LARGE_UNIT = /\dl?v(?:h|b|min|max)(?![a-z])/;
/** A height utility measured in the LARGE viewport: `h-[92vh]`, `max-h-[min(72lvh,42rem)]`, `h-screen`, `max-h-lvh`. */
const LARGE_VIEWPORT = new RegExp(`^(?:min-h|max-h|h)-\\[[^\\]]*${LARGE_UNIT.source}[^\\]]*\\]$|^(?:max-h|h)-(?:screen|lvh)$`);
const largeViewport = (token: string) => {
  const p = parts(token);
  return LARGE_VIEWPORT.test(p[p.length - 1]) && !p.slice(0, -1).includes(NO_DVH);
};

/**
 * Class-like tokens of a stretch of source, split at spaces, quotes, braces,
 * parentheses and `${` — but never inside a bracketed value, so
 * `max-h-[min(72vh,42rem)]` stays one token.
 */
function tokens(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    const split = depth === 0 && (/[\s"'`{}()]/.test(ch) || (ch === '$' && text[i + 1] === '{'));
    if (split) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const HEIGHT_TOKEN = /(?:^|[\s"'`{])((?:[\w-]+(?:-\[[^\]\s]*\])?:)*(?:min-h|max-h|h)-(?:\[[^\]\s]*\]|screen|lvh))(?=[\s"'`}]|$)/g;

/** The raw value starting at `i`: a quoted string's contents, or an expression to its matching brace / end. */
function valueAt(src: string, i: number): string {
  const open = src[i];
  if (open === '"' || open === "'") return src.slice(i + 1, src.indexOf(open, i + 1));
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0 && open === '{') {
        i += 1;
        break;
      }
    } else if ((ch === ',' || ch === '\n') && depth === 0 && open !== '{') break;
  }
  return src.slice(start, i);
}

/** The value of every `panelClassName` in a file: a JSX attribute or an object property. */
function panelClassNames(src: string): string[] {
  const out: string[] = [];
  const re = /panelClassName\s*[=:]\s*/g;
  while (re.exec(src) !== null) out.push(valueAt(src, re.lastIndex));
  return out;
}

/** Every JSX opening tag `<Name …>` in a source, read past quoted strings and `{…}` props. */
function openingTags(src: string, name: string): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  const re = new RegExp(`<${name.replace('.', '\\.')}(?=[\\s>/])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let quote = '';
    let j = m.index + name.length + 1;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || (ch === '`' && depth > 0)) quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
    }
    out.push({ at: m.index, text: src.slice(m.index, j + 1) });
  }
  return out;
}

/** Where the element a `<name …>` tag opens is closed: the index of its matching `</name>`, -1 if never. */
function closingOf(src: string, tag: { at: number; text: string }, name: string): number {
  if (tag.text.endsWith('/>')) return tag.at + tag.text.length;
  const opens = openingTags(src, name)
    .filter((t) => t.at > tag.at && !t.text.endsWith('/>'))
    .map((t) => t.at);
  const closes = [...src.matchAll(new RegExp(`</${name.replace('.', '\\.')}\\s*>`, 'g'))].map((m) => m.index ?? 0).filter((i) => i > tag.at);
  let depth = 1;
  let o = 0;
  for (const c of closes) {
    for (; o < opens.length && opens[o] < c; o++) depth += 1;
    depth -= 1;
    if (depth === 0) return c;
  }
  return -1;
}

/** A tag's attribute, raw (`null` when absent); a bare boolean attribute is `''`. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}(=|(?=[\\s/>]))`).exec(tag);
  if (!m) return null;
  return m[1] === '=' ? valueAt(tag, m.index + m[0].length) : '';
}

/** The rules of a stylesheet whose selector is exactly `selector`, with their declarations parsed. */
function rulesFor(css: string, selector: string): Array<{ at: number; decls: Map<string, string> }> {
  const out: Array<{ at: number; decls: Map<string, string> }> = [];
  const re = /([^{};]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    if (m[1].trim() !== selector) continue;
    const decls = new Map<string, string>();
    for (const d of m[2].split(';')) {
      const colon = d.indexOf(':');
      if (colon > 0) decls.set(d.slice(0, colon).trim().toLowerCase(), d.slice(colon + 1).trim());
    }
    out.push({ at: m.index, decls });
  }
  return out;
}
/** A CSS value with its formatting removed: `calc( 100%  -  env( x ) )` → `calc(100% - env(x))`. */
const cssValue = (v: string) => v.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

test('the primitive caps every window at its layer, less the status bar — a caller can still say less — and it does not scroll', () => {
  const css = cssCode('src/index.css');
  const caps = rulesFor(css, '[data-overlay-panel]').filter((r) => r.decls.has('max-height'));
  assert.equal(caps.length, 1, 'exactly one cap on [data-overlay-panel] in src/index.css');
  const [cap] = caps;
  assert.equal(cssValue(cap.decls.get('max-height') ?? ''), 'calc(100% - env(safe-area-inset-top))', 'the cap is the layer, less the status bar');
  // NOT a scroll container: an overflow here would clip whatever hangs outside
  // a panel — the shop search's results drop down outside its field.
  const overflow = [...cap.decls.keys()].filter((k) => k.startsWith('overflow'));
  assert.deepEqual(overflow, [], 'the cap clips nothing; a window that can be taller than the screen scrolls itself');
  // In `@layer components`: below the utilities, so `max-h-[88dvh]` on a panel
  // still wins, and a dvh value a browser drops falls back to this cap.
  const layers = [...css.matchAll(/@layer components\s*\{/g)].map((l) => {
    let depth = 0;
    let i = (l.index ?? 0) + l[0].length - 1;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && --depth === 0) break;
    }
    return [l.index ?? 0, i] as const;
  });
  assert.ok(
    layers.some(([from, to]) => cap.at > from && cap.at < to),
    'the cap sits inside an `@layer components { … }` block, under the utilities'
  );

  // The layer it is measured against is the screen: `fixed inset-0`, and the
  // panel carries the hook the cap selects.
  const overlay = code('src/components/ui/Overlay.tsx');
  const layer = openingTags(overlay, 'div').find((d) => attr(d.text, 'ref') === '{layerRef}');
  assert.ok(layer, 'the layer (ref={layerRef})');
  const layerClasses = tokens(attr(layer.text, 'className') ?? '');
  for (const t of ['fixed', 'inset-0', 'flex']) assert.ok(layerClasses.includes(t), `the layer is ${t}`);
  const panel = openingTags(overlay, 'Motion.div').find((t) => attr(t.text, 'data-overlay-panel') !== null);
  assert.ok(panel && attr(panel.text, 'ref') === '{setPanel}', 'the panel carries data-overlay-panel');
  // The on-screen keyboard pins the layer to what is visible and lets the
  // panel be no taller than it (inline, over any class).
  assert.match(overlay, /panel\.style\.maxHeight\s*=\s*['"]100%['"]/);
});

test('no window panel in src/ sizes itself in the large viewport (vh, lvh, vb, vmin, vmax): it says dvh', () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of SRC.filter((f) => /\.tsx?$/.test(f))) {
    const src = code(file);
    if (!src.includes('panelClassName')) continue;
    for (const value of panelClassNames(src)) {
      seen += 1;
      for (const t of tokens(value)) if (largeViewport(t)) offenders.push(`${file}: ${t}`);
    }
  }
  assert.ok(seen > 60, `found only ${seen} panelClassName values — the scan has lost them`);
  // The desktop search panel is top-placed (`placement="top"`, under `mt-14`):
  // its top edge is fixed below the bar, so vh limits only its bottom.
  const TOP_PLACED = ['src/components/community/search/SearchOverlay.tsx: max-h-[min(72vh,42rem)]'];
  assert.deepEqual(
    offenders.filter((o) => !TOP_PLACED.includes(o)),
    [],
    `a window panel measured in the large viewport is taller than an iPhone shows (its header goes off the top):\n${offenders.join('\n')}`
  );
  // The exception is a real one: the scan reads that panel's bracketed value whole.
  assert.deepEqual(offenders.filter((o) => TOP_PLACED.includes(o)), TOP_PLACED, 'the top-placed search panel is seen, and excused');
  // The scan itself: each large-viewport form is caught, the visible ones are not.
  for (const t of ['h-[92vh]', 'max-h-[90lvh]', 'max-h-lvh', 'h-screen', 'sm:h-[88vh]', 'max-h-[min(72vh,42rem)]', 'max-h-[90vmax]', 'h-[80vb]', 'max-h-[min(90vmin,30rem)]', 'max-h-[calc(100lvmax-2rem)]']) {
    assert.ok(largeViewport(t), t);
  }
  for (const t of ['h-[92dvh]', 'max-h-[90svh]', 'max-h-dvh', 'min-h-screen', `${NO_DVH}:h-[92vh]`, 'max-h-[90dvmax]', 'h-[80svb]', 'max-h-[90vw]']) assert.ok(!largeViewport(t), t);
  assert.deepEqual(tokens('w-full ${x} sm:max-h-[min(72vh,42rem)] pb-[max(1rem,env(safe-area-inset-bottom))]'), ['w-full', 'x', 'sm:max-h-[min(72vh,42rem)]', 'pb-[max(1rem,env(safe-area-inset-bottom))]']);
});

test('the order window: 92dvh on a phone, 88dvh from sm up; the X sits in the header, which stays while the body scrolls', () => {
  const src = code('src/components/adminOrders/OrderDetailModal.tsx');
  const [panel, ...more] = panelClassNames(src);
  assert.equal(more.length, 0, 'one window in the file');
  const t = tokens(panel);
  for (const want of ['h-[92dvh]', 'sm:h-[88dvh]', 'flex', 'flex-col', 'overflow-hidden']) {
    assert.ok(t.includes(want), `the order window's panel carries ${want}: ${panel}`);
  }
  assert.deepEqual(t.filter(largeViewport), [], `no large-viewport height on the order window: ${panel}`);
  assert.equal(attr(openingTags(src, 'Overlay')[0]?.text ?? '', 'placement'), 'bottom');

  // Located by what they ARE, not by how their classes are spelled: the
  // header is the shrink-0 row under the window's column, the X is the button
  // named «إغلاق / Close», a body is a flex-1 min-h-0 scroller — and they are
  // found by their NESTING, not by their order in the file.
  const divs = openingTags(src, 'div').map((d) => ({ at: d.at, text: d.text, cls: tokens(attr(d.text, 'className') ?? '') }));
  const column = divs.find((d) => attr(d.text, 'data-order-modal') !== null);
  assert.ok(column, 'the window column (data-order-modal)');
  for (const want of ['flex', 'flex-col', 'flex-1', 'min-h-0']) assert.ok(column.cls.includes(want), `the column is ${want}`);
  const columnEnd = closingOf(src, column, 'div');
  assert.ok(columnEnd > column.at, 'the column closes');
  const header = divs.find((d) => d.at > column.at && d.at < columnEnd && d.cls.includes('shrink-0') && d.cls.includes('border-b'));
  assert.ok(header, 'a shrink-0 header row inside the column');
  const headerEnd = closingOf(src, header, 'div');
  assert.ok(headerEnd > header.at, 'the header closes');
  const x = openingTags(src, 'button').find((b) => /^\{loc\([^)]*'Close'/.test(attr(b.text, 'aria-label') ?? ''));
  assert.ok(x, 'the close X');
  assert.ok(x.at > header.at && x.at < headerEnd, 'the close X is INSIDE the shrink-0 header');
  const bodies = divs.filter((d) => ['flex-1', 'overflow-y-auto', 'min-h-0'].every((c) => d.cls.includes(c)));
  assert.ok(bodies.length >= 2, 'the order and stages bodies scroll (flex-1, overflow-y-auto, min-h-0)');
  assert.ok(bodies.every((b) => b.at > headerEnd && b.at < columnEnd), 'the scrolling bodies are inside the column and outside the header');

  // The nesting reader itself.
  const probe = '<div a><div b><button x /></div></div><div c />';
  const [outer, inner] = openingTags(probe, 'div');
  assert.equal(closingOf(probe, outer, 'div'), probe.lastIndexOf('</div>'));
  assert.equal(closingOf(probe, inner, 'div'), probe.indexOf('</div>'));
});

test('the windows whose body sets their height measure it in dvh too', () => {
  // The scanner's camera picture sizes a centred window that has no height of
  // its own: on a small iPhone, a 58vh picture plus the title and the controls
  // put the window's top — and its X — past the top of the screen.
  const scanner = tokens(code('src/components/scanner/BarcodeScanner.tsx'));
  for (const want of ['max-h-[46dvh]', 'max-h-[58dvh]']) assert.ok(scanner.includes(want), `the camera picture: ${want}`);
  assert.deepEqual(scanner.filter(largeViewport), [], 'no large-viewport height in the scanner');
});

/**
 * EVERY OTHER LARGE-VIEWPORT HEIGHT IN src/, AND WHY IT STAYS. A new one fails
 * here until it is either dvh or listed with the reason it cannot lift a
 * window's header off an iPhone screen. Safari's bars take at most ~15% of the
 * large viewport on an iPhone, in either orientation (≈664 of ≈750px on a
 * 390×844).
 */
const KEPT: Record<string, string> = {
  'src/components/adminWarranty/serialInventory/ManualEntry.tsx: max-h-[46vh]':
    'the preview table, inside the add-serials sheet’s scrolling body (a 94dvh dock sheet): it scrolls with the body and cannot lift the header',
  'src/components/community/hub/CommunityMenu.tsx: max-h-[85vh]':
    'the desktop popover (≥1024px, never an iPhone); Anchored clamps its top inside the viewport, so vh limits only its bottom',
  'src/components/community/search/SearchOverlay.tsx: max-h-[min(72vh,42rem)]':
    'the desktop search panel, top-placed under mt-14: its top edge is fixed below the bar',
  'src/components/notifications/NotificationBell.tsx: max-h-[70vh]':
    'the phone sheet’s body: 70% of the large viewport is below the visible height of every iPhone, the primitive’s cap holds the sheet’s header regardless, and it is the body’s only height limit where dvh is unknown',
  'src/components/policies/PolicyOutline.tsx: max-h-[60vh]': 'an in-page disclosure, not a window',
  'src/pages/WarrantyVerify.tsx: min-h-[70vh]': 'a page’s minimum height, not a window',
  'src/pages/Welcome.tsx: min-h-[70vh]': 'a page’s minimum height, not a window',
  'src/pages/community/access.tsx: min-h-[60vh]': 'a page’s minimum height, not a window',
  'src/components/auth/auth.css: max-height: min(70vh, 480px)':
    'the country picker’s phone sheet, capped at 480px — below the visible height of the smallest iPhone (≈548px on an SE)',
};

const CSS_HEIGHT = new RegExp(`(?:^|[;{\\s])((?:max-|min-)?height\\s*:\\s*[^;}]*${LARGE_UNIT.source}[^;}]*)`, 'g');
/** The unit in a style prop's value: after a number (`'80vh'`), an interpolation (`${n}vh`) or a quote (`n + 'vh'`). */
const STYLE_UNIT = new RegExp(`(?:\\d|\\}|['"\`])l?v(?:h|b|min|max)(?![a-z])`);
/** Every style height in the large viewport: `maxHeight: '80vh'`, `` height: `${n}vh` ``, `minHeight: n + 'vmax'`. */
function styleHeights(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(height|maxHeight|minHeight)\s*:\s*/g)) {
    const value = valueAt(src, (m.index ?? 0) + m[0].length).trim();
    if (STYLE_UNIT.test(value)) out.push(`${m[1]}: ${value}`);
  }
  return out;
}

test('every other large-viewport height in src/ is listed with the reason it cannot hide a window’s header', () => {
  const found: string[] = [];
  for (const file of SRC) {
    const text = read(file);
    if (file.endsWith('.css')) {
      for (const m of cssCode(file).matchAll(CSS_HEIGHT)) found.push(`${file}: ${m[1].trim()}`);
      continue;
    }
    // Raw text, comments included: Tailwind generates a class it reads in a comment too.
    for (const m of text.matchAll(HEIGHT_TOKEN)) if (largeViewport(m[1])) found.push(`${file}: ${m[1]}`);
    // A style prop in the large viewport (`maxHeight: '80vh'`, `` `${n}lvh` ``, `n + 'vmax'`).
    for (const s of styleHeights(code(file))) found.push(`${file}: ${s}`);
  }
  const unexplained = found.filter((f) => !(f in KEPT));
  assert.deepEqual(unexplained, [], `a large-viewport height with no reason to stay — make it dvh (vh only under ${NO_DVH}:), or list why:\n${unexplained.join('\n')}`);
  const stale = Object.keys(KEPT).filter((k) => !found.includes(k));
  assert.deepEqual(stale, [], 'listed but no longer in the source — move the pin with the code');
  // The scans themselves see every large-viewport unit: in a class, in a
  // declaration and in a style prop, however the prop's value is put together.
  for (const t of ['h-[90lvh]', 'max-h-lvh', 'sm:max-h-[min(80lvh,40rem)]', 'max-h-[90vmax]', 'h-[70vb]']) {
    assert.ok([...` ${t} `.matchAll(HEIGHT_TOKEN)].some((m) => largeViewport(m[1])), `the class scan sees ${t}`);
  }
  for (const d of ['{max-height: 80lvh}', '{max-height: calc(100vmax - 2rem)}']) assert.equal([...d.matchAll(CSS_HEIGHT)].length, 1, `the CSS scan sees ${d}`);
  for (const s of ["{ maxHeight: '80lvh' }", "{ maxHeight: 90 + 'vh' }", '{ height: `${n}vh` }', "{ minHeight: wide ? '50vmax' : 0 }", "{ maxHeight: 'calc(100vb - 4rem)' }"]) {
    assert.equal(styleHeights(s).length, 1, `the style scan sees ${s}`);
  }
  for (const s of ["{ maxHeight: '80dvh' }", "{ maxHeight: 'min(90svh, 40rem)' }", '{ height: h }} className="h-[80vh]"', '{ height: number; width: 100 }']) {
    assert.equal(styleHeights(s).length, 0, `the style scan passes ${s}`);
  }
});

// ------------------------------------------ 5–8: the cap does not scroll

/** A window in a source: an `<Overlay>`, or a sheet — ui/Overlay's whole-panel one, or ui/Sheet's, v2 or not. */
interface WindowTag {
  at: number;
  text: string;
  kind: 'overlay' | 'sheet';
  /** The module the file imported it from. */
  from: string;
}
const OVERLAY_MODULE = /(?:^\.|\/ui)\/Overlay$/;
const SHEET_MODULE = /(?:^\.|\/ui)\/Sheet$/;

/**
 * Every window tag in a source, under whatever name the file imports it:
 * `Sheet`, `Sheet as Drawer` (`<Drawer>`), `* as UI` (`<UI.Sheet>`).
 */
function windowTags(src: string): WindowTag[] {
  const out: WindowTag[] = [];
  for (const m of src.matchAll(/\bimport\s+([^;'"]*?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1];
    const from = m[2];
    const overlayModule = OVERLAY_MODULE.test(from);
    if ((!overlayModule && !SHEET_MODULE.test(from)) || /^type\s/.test(clause)) continue;
    const bind = (exported: string, local: string) => {
      const kind = exported === 'Sheet' ? 'sheet' : exported === 'Overlay' && overlayModule ? 'overlay' : null;
      if (kind) for (const t of openingTags(src, local)) out.push({ ...t, kind, from });
    };
    const ns = /\*\s*as\s+(\w+)/.exec(clause);
    if (ns) for (const exported of ['Overlay', 'Sheet']) bind(exported, `${ns[1]}.${exported}`);
    for (const spec of /\{([^}]*)\}/.exec(clause)?.[1].split(',') ?? []) {
      const [name, alias] = spec.trim().split(/\s+as\s+/);
      if (name && !name.startsWith('type ')) bind(name, (alias ?? name).trim());
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The v2 sheet: ui/Sheet's `Sheet` with a v2 prop really on, as ui/Sheet.tsx
 * decides it — drag from its handle, a body that scrolls. `dragHandle={false}`,
 * or the whole-panel sheet under any name, is not.
 */
function isV2(tag: WindowTag): boolean {
  if (tag.kind !== 'sheet' || !SHEET_MODULE.test(tag.from)) return false;
  const on = (prop: string, yes: (value: string) => boolean) => {
    const value = attr(tag.text, prop);
    return value !== null && yes(value);
  };
  return (
    on('dragHandle', (v) => v === '' || v === '{true}') ||
    on('detents', (v) => /^\{\s*\[\s*['"]/.test(v)) ||
    on('header', (v) => v !== '{undefined}') ||
    on('footer', (v) => v !== '{undefined}')
  );
}
/** A panel that scrolls itself, rather than clipping or spilling what does not fit. */
const scrollsItself = (panel: string) => {
  const t = tokens(panel);
  return t.some((c) => /^overflow(-y)?-(auto|scroll)$/.test(c)) && !t.some((c) => /^overflow(-y)?-(hidden|clip|visible)$/.test(c));
};
const testIdOf = (tag: string) => (attr(tag, 'testId') ?? '').replace(/^\{|\}$/g, '');

/** Where a top-level component's source runs: from `function Name` to the next top-level declaration. */
function componentRange(src: string, name: string): [number, number] {
  const start = new RegExp(`(?:^|\\n)(?:export\\s+(?:default\\s+)?)?function\\s+${name}\\b`).exec(src);
  assert.ok(start, `function ${name}`);
  const next = /\n(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s/g;
  next.lastIndex = start.index + start[0].length;
  const end = next.exec(src);
  return [start.index, end ? end.index : src.length];
}

/**
 * THE WINDOWS FOUND TALLER THAN A SMALL iPHONE'S SCREEN without a scroll a
 * finger can use, and the scroll they have now. Every one of the app's window
 * call sites was measured or read for this; these are the ones that do not
 * fit. Each is found inside its component (`within`), by its test id where the
 * component has more than one window — never by its position in the file.
 */
const TALL: Array<{ file: string; within: string; testId?: string; kind: 'panel' | 'v2'; why: string }> = [
  { file: 'src/components/adminWarranty/serialInventory/EditSerialDialog.tsx', within: 'EditSerialDialog', kind: 'panel', why: 'the filing fields and the form, ~700px measured, and the unsaved-changes question under them' },
  { file: 'src/components/ui/PromptDialog.tsx', within: 'PromptDialog', kind: 'panel', why: 'a description, a three-line answer and the unsaved-changes question fill an SE' },
  { file: 'src/components/AdminSerials.tsx', within: 'AdminSerials', testId: 'admin-unit-action', kind: 'panel', why: 'the warranty correction: two durations, the shorter-warranty warning and the reason (~700px by the markup)' },
  { file: 'src/components/AdminSerials.tsx', within: 'AdminSerials', testId: 'admin-claim-move', kind: 'panel', why: 'the money warning, the decisions and the reason (~630px by the markup)' },
  { file: 'src/components/creativeStudio/ConflictsDialog.tsx', within: 'ConflictsDialog', kind: 'panel', why: 'two or three conflicts, each with its options' },
  { file: 'src/components/adminOperations/PurchaseUnitSerial.tsx', within: 'PurchaseUnitSerial', kind: 'panel', why: 'the scanner: on an SE its camera picture, title and typed-serial row are 558px measured, in 519' },
  { file: 'src/components/adminTradeIn/IntakeSheet.tsx', within: 'IntakeSheet', kind: 'panel', why: 'the same scanner window' },
  { file: 'src/components/warranty/AddDevicePanel.tsx', within: 'AddDevicePanel', testId: 'warranty-scanner', kind: 'panel', why: 'the same scanner window, for a customer' },
  { file: 'src/components/adminGifts/GrantSheet.tsx', within: 'GrantSheet', kind: 'v2', why: 'a customer, the level, how, a product’s fields, the reason and the note, ~740px measured; then the question' },
  { file: 'src/components/adminGifts/GrantDetail.tsx', within: 'GrantDetail', kind: 'v2', why: 'a grant’s facts, note and actions, ~830px measured' },
  { file: 'src/components/adminGifts/LevelsPanel.tsx', within: 'ItemSheet', kind: 'v2', why: 'an item’s fields grow with its product’s option groups' },
  { file: 'src/components/adminPrintCloud/sections/CustomersSection.tsx', within: 'AdjustSheet', kind: 'v2', why: 'two notes, two choices, the amount and the reason (~640px by the markup)' },
  { file: 'src/components/adminPrintCloud/sections/PrintersSection.tsx', within: 'BindSheet', kind: 'v2', why: 'a farm’s printers, one row each' },
  { file: 'src/components/adminPrintCloud/sections/StockSection.tsx', within: 'MoveSheet', kind: 'v2', why: 'receiving: quantity, place, lot, supplier, notes and cost (~650px by the markup)' },
  {
    file: 'src/components/pwa/InstallAppSheet.tsx',
    within: 'InstallAppSheet',
    kind: 'v2',
    why: 'iOS Safari’s steps and the customer’s two answers, no X: they fill an SE in English, and at 320×460 both answers were below the edge in Arabic, English and Sorani',
  },
  {
    file: 'src/components/AdminUsers.tsx',
    within: 'AdminUsers',
    testId: 'admin-edit-user',
    kind: 'panel',
    why: 'no X and no scrim exit, so Cancel and Save are the only way out: at 320×460 the owner’s editor ran to 501px, and 581px after a failed save, in a 428px window — both buttons below the edge',
  },
];

/** The one window a TALL entry names. */
function tallWindow(w: (typeof TALL)[number]): WindowTag {
  const src = code(w.file);
  const [from, to] = componentRange(src, w.within);
  const kind = w.kind === 'v2' ? 'sheet' : 'overlay';
  const found = windowTags(src).filter((t) => t.kind === kind && t.at > from && t.at < to && (!w.testId || testIdOf(t.text) === w.testId));
  assert.equal(found.length, 1, `${w.file}: exactly one ${kind === 'sheet' ? 'sheet' : '<Overlay>'} in ${w.within}${w.testId ? ` with testId ${w.testId}` : ''}`);
  return found[0];
}

test('a window taller than an iPhone’s screen scrolls itself — the cap only keeps its top on the screen', () => {
  for (const w of TALL) {
    const tag = tallWindow(w);
    if (w.kind === 'v2') {
      assert.ok(isV2(tag), `${w.file} (${w.within}): the v2 sheet (Sheet from ui/Sheet, dragHandle) — ${w.why}`);
      continue;
    }
    const panel = attr(tag.text, 'panelClassName') ?? '';
    assert.ok(scrollsItself(panel), `${w.file} (${w.within}${w.testId ? `, ${w.testId}` : ''}): its panel scrolls (overflow-y-auto, nothing hidden) — ${w.why}: ${panel}`);
  }
  // The serial edit: the WINDOW scrolls and the form does not, so the
  // question — added after the form — is inside the one scroll.
  const edit = code('src/components/adminWarranty/serialInventory/EditSerialDialog.tsx');
  const panel = tokens(attr(windowTags(edit).filter((t) => t.kind === 'overlay')[0].text, 'panelClassName') ?? '');
  for (const want of ['max-h-[85dvh]', 'overflow-y-auto']) assert.ok(panel.includes(want), `the serial edit window: ${want}`);
  const form = tokens(attr(openingTags(edit, 'form')[0].text, 'className') ?? '');
  assert.deepEqual(form.filter((c) => /^(max-h-|h-|overflow)/.test(c)), [], 'the serial edit form neither caps nor scrolls itself');

  // The reading itself: a sheet is v2 by its module and a prop that is really
  // on, under whatever name it is imported.
  const probe = [
    "import { Sheet as Drawer } from '../ui/Sheet';",
    "import * as UI from '../ui/Overlay';",
    'export const A = () => <Drawer open dragHandle={false} />;',
    'export const B = () => <Drawer open dragHandle />;',
    "export const C = () => <Drawer open detents={['large']} />;",
    'export const D = () => <UI.Sheet open dragHandle />;',
    'export const E = () => <UI.Overlay open />;',
  ].join('\n');
  assert.deepEqual(
    windowTags(probe).map((t) => `${t.kind}:${isV2(t)}`),
    ['sheet:false', 'sheet:true', 'sheet:true', 'sheet:false', 'overlay:false'],
    'dragHandle={false} and the whole-panel sheet are not v2; aliases and namespaces are read'
  );
});

/** The spacing step of a padding utility (`pt-5` → 5), or null. */
function step(cls: string, utility: string): number | null {
  const m = new RegExp(`^${utility}-(\\d+(?:\\.\\d+)?)$`).exec(cls);
  return m ? Number(m[1]) : null;
}
/** A box's top padding from `sm` up, in spacing steps: a `sm:` utility beats a bare one, and `pt` beats `py` beats `p`. */
function topPaddingFromSm(classes: string[]): number {
  for (const variant of ['sm:', '']) {
    for (const utility of ['pt', 'py', 'p']) {
      for (const c of classes) {
        const v = c.startsWith(variant) ? step(c.slice(variant.length), utility) : null;
        if (v !== null) return v;
      }
    }
  }
  return 0;
}
/** The first element inside an opening tag: a sheet's content root. */
function firstChild(src: string, tag: { at: number; text: string }): { at: number; text: string } | null {
  const re = /<([A-Za-z][\w.]*)/g;
  re.lastIndex = tag.at + tag.text.length;
  const m = re.exec(src);
  return m ? (openingTags(src, m[1]).find((t) => t.at === m.index) ?? null) : null;
}

test('a sheet moved to v2 keeps its title clear of the card’s top edge from sm up, where v2 draws no grabber', () => {
  // The whole-panel sheet draws its grabber at every width (a 4px bar with
  // 10px above and 4px below) unless motion is reduced; the v2 sheet draws it
  // on a phone only. A content root that leaned on it (`pt-2`) put its title
  // 9px under the card's top edge from sm up — a desktop, a tablet, a phone
  // held sideways (measured in headless Edge), where the v1 sheet left ~27px.
  for (const w of TALL.filter((x) => x.kind === 'v2')) {
    const src = code(w.file);
    const root = firstChild(src, tallWindow(w));
    assert.ok(root, `${w.file} (${w.within}): the sheet's content`);
    const classes = tokens(attr(root.text, 'className') ?? '');
    assert.ok(topPaddingFromSm(classes) >= 4, `${w.file} (${w.within}): at least 1rem above the title from sm up (sm:pt-5) — ${classes.join(' ')}`);
  }
  // The reading itself.
  assert.equal(topPaddingFromSm(['px-5', 'pb-5', 'pt-2']), 2);
  assert.equal(topPaddingFromSm(['px-5', 'pt-2', 'sm:pt-5']), 5);
  assert.equal(topPaddingFromSm(['p-5', 'pb-[max(1.25rem,env(safe-area-inset-bottom))]', 'sm:pb-5']), 5);
  assert.equal(topPaddingFromSm(['p-5', 'pt-2', 'md:pt-8']), 2);
});

test('a window with unsaved work keeps its question on the screen', () => {
  // Every `dirty` window: the question lands inside the panel's own scroll,
  // under a body that shrinks for it, or in a v2 sheet (the same, built in).
  const checked: string[] = [];
  const unsafe: string[] = [];
  const fpDialog = rulesFor(cssCode('src/components/financePeople/people.css'), '.fp-dialog')[0];
  assert.match(fpDialog?.decls.get('overflow-y') ?? '', /^(auto|scroll)$/, 'the finance dialog scrolls (people.css .fp-dialog)');
  for (const file of SRC.filter((f) => f.endsWith('.tsx'))) {
    const src = code(file);
    if (!/\bdirty\b/.test(src)) continue;
    for (const tag of windowTags(src)) {
      if (attr(tag.text, 'dirty') === null) continue;
      const at = `${file}: ${tag.text.slice(0, tag.text.search(/[\s/>]/))}>`;
      checked.push(at);
      if (file === 'src/components/ui/Sheet.tsx') continue; // the v2 sheet itself: a flex column whose body scrolls
      if (tag.kind === 'sheet') {
        if (!isV2(tag)) unsafe.push(`${at} — a whole-panel sheet cannot scroll under a finger; make it the v2 sheet (dragHandle)`);
        continue;
      }
      const panel = tokens(attr(tag.text, 'panelClassName') ?? '');
      const column = ['flex', 'flex-col', 'overflow-hidden'].every((c) => panel.includes(c)) && panel.some((c) => /^(max-h|h)-/.test(c));
      if (!scrollsItself(panel.join(' ')) && !column && !panel.includes('fp-dialog')) {
        unsafe.push(`${at} — its panel neither scrolls nor is a column whose body shrinks: ${panel.join(' ')}`);
      }
    }
  }
  assert.ok(checked.length >= 20, `found only ${checked.length} dirty windows — the scan has lost them`);
  assert.deepEqual(unsafe, [], `the unsaved-changes question would be pushed below the screen:\n${unsafe.join('\n')}`);

  // And the question brings ALL of itself into view, not just «keep editing»:
  // where its buttons wrap (Sorani on a narrow phone) «discard» is a second line.
  const overlay = code('src/components/ui/Overlay.tsx');
  const guard = overlay.slice(overlay.indexOf('function DiscardGuard'), overlay.indexOf('export type OverlayMode'));
  assert.match(guard, /keepRef\.current\?\.focus\(\{\s*preventScroll:\s*true\s*\}\)/, '«keep editing» takes focus without a scroll of its own');
  assert.match(guard, /rootRef\.current\?\.scrollIntoView\(\{\s*block:\s*'nearest'\s*\}\)/, 'the whole question is scrolled into view');
  const root = openingTags(guard, 'div')[0]?.text ?? '';
  assert.ok(attr(root, 'ref') === '{rootRef}' && attr(root, 'data-overlay-guard') !== null, 'what is scrolled into view is the question itself');
});

/**
 * THE WHOLE-PANEL SHEETS THAT SCROLL THEIR PANEL TODAY. On a touch phone the
 * part beyond their max-height is out of a finger's reach (the drag takes the
 * swipe); keyboard, mouse and reduced motion still scroll it. Each is a
 * follow-up to move to the v2 sheet; a new one fails here.
 */
const V1_PANEL_SCROLL: Record<string, number> = {
  'src/pages/Cart.tsx': 2,
  'src/pages/Chats.tsx': 1,
  'src/components/orders/ReviewSheet.tsx': 1,
  'src/components/subscription/PurchaseConfirm.tsx': 1,
  'src/pages/farm/sheets/Window.tsx': 1,
};

test('a whole-panel sheet does not scroll under a finger: a tall sheet is the v2 one', () => {
  const overlay = code('src/components/ui/Overlay.tsx');
  const sheet = overlay.slice(overlay.indexOf('export function Sheet'), overlay.indexOf('export interface AnchoredProps'));
  assert.match(sheet, /drag:\s*'y' as const/, 'the whole-panel sheet drags its panel vertically (motion then sets touch-action: pan-x)');
  const panelScrolls = (tag: WindowTag) => {
    const panel = attr(tag.text, 'panelClassName');
    return panel !== null && tokens(panel).some((c) => /^overflow(-y)?-(auto|scroll)$/.test(c));
  };
  const found: Record<string, number> = {};
  for (const file of SRC.filter((f) => f.endsWith('.tsx') && !f.startsWith('src/components/ui/'))) {
    for (const tag of windowTags(code(file))) {
      if (tag.kind === 'sheet' && !isV2(tag) && panelScrolls(tag)) found[file] = (found[file] ?? 0) + 1;
    }
  }
  assert.deepEqual(found, V1_PANEL_SCROLL, 'a whole-panel sheet with a panel scroller — make it the v2 sheet (dragHandle), whose body scrolls');
  // Under another name, or with its v2 prop switched off, it is still found.
  const probe = [
    "import { Sheet as BottomSheet } from '../ui/Overlay';",
    "import { Sheet } from '../ui/Sheet';",
    'export const A = () => <BottomSheet open panelClassName="w-full max-h-[88dvh] overflow-y-auto" />;',
    'export const B = () => <Sheet open dragHandle={false} panelClassName="w-full max-h-[88dvh] overflow-y-auto" />;',
    'export const C = () => <Sheet open dragHandle panelClassName="w-full max-h-[88dvh] overflow-y-auto" />;',
  ].join('\n');
  assert.equal(windowTags(probe).filter((t) => t.kind === 'sheet' && !isV2(t) && panelScrolls(t)).length, 2);
});
