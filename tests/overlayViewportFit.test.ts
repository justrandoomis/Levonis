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
 * and anchored to the bottom edge: about 690px on a 390×844 iPhone whose
 * visible area is about 664px, so its top ~26px — the title and the close X —
 * sat above the top of the screen. Overflow above a fixed layer is not
 * scrollable, and the scrim was covered too: no way out but Escape, which a
 * phone does not have.
 *
 * WHY A SOURCE TEST. Chromium has no large/small viewport split outside a
 * phone, so 92vh fits in every headless window and no browser test here can
 * see the bug. What can be pinned is the contract that makes it impossible:
 *
 *   1. The primitive caps every panel at its layer, less the status bar
 *      (src/index.css, `[data-overlay-panel]`, in the components layer so a
 *      caller's own `max-h-*` utility still wins). It is also the fallback
 *      where a browser has no dvh: the dvh value is dropped and the cap stands.
 *   2. No window panel in src/ sizes itself in bare vh — dvh. (A deliberate
 *      vh fallback may stand only under `not-supports-[height:1dvh]:`.)
 *   3. The order window: 92dvh / 88dvh, its header outside the scroller.
 *   4. A bare vh height anywhere else in src/ is a decision, listed below with
 *      why it cannot push a window's header off an iPhone screen.
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
/** A height utility measured in the LARGE viewport: `h-[92vh]`, `max-h-[min(72vh,42rem)]`, `h-screen`. */
const LARGE_VIEWPORT = /^(?:min-h|max-h|h)-\[[^\]]*\dvh(?![a-z])[^\]]*\]$|^(?:max-h|h)-screen$/;
const largeViewport = (token: string) => {
  const p = parts(token);
  return LARGE_VIEWPORT.test(p[p.length - 1]) && !p.slice(0, -1).includes(NO_DVH);
};

/** Class-like tokens of a stretch of source. */
const tokens = (text: string) => text.split(/[\s"'`{}()]+|\$\{/).filter(Boolean);
const HEIGHT_TOKEN = /(?:^|[\s"'`{])((?:[\w-]+(?:-\[[^\]\s]*\])?:)*(?:min-h|max-h|h)-(?:\[[^\]\s]*\]|screen))(?=[\s"'`}]|$)/g;

/** The value of every `panelClassName` in a file: a JSX attribute or an object property. */
function panelClassNames(src: string): string[] {
  const out: string[] = [];
  const re = /panelClassName\s*[=:]\s*/g;
  while (re.exec(src) !== null) {
    let i = re.lastIndex;
    const open = src[i];
    if (open === '"' || open === "'") {
      const end = src.indexOf(open, i + 1);
      out.push(src.slice(i + 1, end));
      continue;
    }
    // An expression: read to the matching brace (JSX) or to the property's end (object).
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
    out.push(src.slice(start, i));
  }
  return out;
}

test('the primitive caps every window at its layer, less the status bar — and a caller can still say less', () => {
  const css = cssCode('src/index.css');
  const rule = /\[data-overlay-panel\]\s*\{\s*max-height:\s*calc\(100% - env\(safe-area-inset-top\)\);\s*\}/g;
  const all = [...css.matchAll(rule)];
  assert.equal(all.length, 1, 'exactly one cap on [data-overlay-panel] in src/index.css');
  // In `@layer components`: below the utilities, so `max-h-[88dvh]` on a panel
  // still wins, and a dvh value a browser drops falls back to this cap.
  const at = all[0].index ?? -1;
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
    layers.some(([from, to]) => at > from && at < to),
    'the cap sits inside an `@layer components { … }` block, under the utilities'
  );

  // The layer it is measured against is the screen: `fixed inset-0`, and the
  // panel carries the hook the cap selects.
  const overlay = code('src/components/ui/Overlay.tsx');
  assert.match(overlay, /className=\{`fixed inset-0 flex \$\{PLACEMENT\[placement\]\}/);
  assert.match(overlay, /\n\s*data-overlay-panel\n/);
  // The on-screen keyboard pins the layer to what is visible and lets the
  // panel be no taller than it (inline, over any class).
  assert.match(overlay, /panel\.style\.maxHeight = '100%'/);
});

test('no window panel in src/ sizes itself in the large viewport (vh): it says dvh', () => {
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
    `a window panel measured in vh is taller than an iPhone shows (its header goes off the top):\n${offenders.join('\n')}`
  );
});

test('the order window: 92dvh on a phone, 88dvh from sm up; the header stays while the body scrolls', () => {
  const src = code('src/components/adminOrders/OrderDetailModal.tsx');
  const [panel, ...more] = panelClassNames(src);
  assert.equal(more.length, 0, 'one window in the file');
  const t = tokens(panel);
  for (const want of ['h-[92dvh]', 'sm:h-[88dvh]', 'flex', 'flex-col', 'overflow-hidden']) {
    assert.ok(t.includes(want), `the order window's panel carries ${want}: ${panel}`);
  }
  assert.deepEqual(t.filter(largeViewport), [], `no bare vh on the order window: ${panel}`);
  assert.match(src, /placement="bottom"/);

  // The header — the title and the X — is a fixed row OUTSIDE the scroller,
  // and every body under it is the part that scrolls.
  const header = src.indexOf('<div className="shrink-0 border-b border-border-subtle">');
  const x = src.indexOf("aria-label={loc('إغلاق', 'Close', 'داخستن')}");
  const body = src.indexOf('<div className="flex-1 overflow-y-auto p-4 min-h-0 space-y-4">');
  assert.ok(header > 0 && x > header && body > x, 'header (shrink-0) → its close X → the scrolling body, in that order');
  assert.match(src, /<div data-order-modal className="flex flex-col flex-1 min-h-0">/);
  assert.match(src, /<div className="flex-1 overflow-y-auto p-4 space-y-6 min-h-0">/);
});

test('the windows whose body sets their height measure it in dvh too', () => {
  // The serial edit form IS its window's height (the panel has none of its own).
  const edit = code('src/components/adminWarranty/serialInventory/EditSerialDialog.tsx');
  assert.match(edit, /<form onSubmit=\{save\} className=\{`\$\{T\.AP\} p-4 sm:p-5 space-y-4 max-h-\[85dvh\] overflow-y-auto`\}>/);
  // The scanner's camera picture sizes a centred window that has no height of
  // its own: on a small iPhone, a 58vh picture plus the title and the controls
  // put the window's top — and its X — past the top of the screen.
  const scanner = code('src/components/scanner/BarcodeScanner.tsx');
  assert.match(scanner, /embedded \? 'aspect-\[4\/3\] max-h-\[46dvh\] rounded-2xl' : 'aspect-\[3\/4\] sm:aspect-\[4\/3\] max-h-\[58dvh\]'/);
});

/**
 * EVERY OTHER vh HEIGHT IN src/, AND WHY IT STAYS. A new one fails here until
 * it is either dvh or listed with the reason it cannot lift a window's header
 * off an iPhone screen. Safari's bars take at most ~15% of the large viewport
 * on an iPhone, in either orientation (≈664 of ≈750px on a 390×844).
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

test('every other vh height in src/ is listed with the reason it cannot hide a window’s header', () => {
  const found: string[] = [];
  for (const file of SRC) {
    const text = read(file);
    if (file.endsWith('.css')) {
      for (const m of cssCode(file).matchAll(/(?:^|[;{\s])((?:max-|min-)?height\s*:\s*[^;}]*\dvh(?![a-z])[^;}]*)/g)) {
        found.push(`${file}: ${m[1].trim()}`);
      }
      continue;
    }
    // Raw text, comments included: Tailwind generates a class it reads in a comment too.
    for (const m of text.matchAll(HEIGHT_TOKEN)) if (largeViewport(m[1])) found.push(`${file}: ${m[1]}`);
    // A style prop in the large viewport (`maxHeight: '80vh'`).
    for (const m of code(file).matchAll(/\b(?:height|maxHeight|minHeight)\s*:\s*['"`][^'"`]*\dvh(?![a-z])[^'"`]*['"`]/g)) {
      found.push(`${file}: ${m[0]}`);
    }
  }
  const unexplained = found.filter((f) => !(f in KEPT));
  assert.deepEqual(unexplained, [], `a vh height with no reason to stay — make it dvh (vh only under ${NO_DVH}:), or list why:\n${unexplained.join('\n')}`);
  const stale = Object.keys(KEPT).filter((k) => !found.includes(k));
  assert.deepEqual(stale, [], 'listed but no longer in the source — move the pin with the code');
});
