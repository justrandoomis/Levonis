/**
 * WHAT A PHONE DOWNLOADS BEFORE THE SHOP APPEARS, AND WHAT IT RENDERS IT IN.
 *
 * The owner sent two PageSpeed reports and asked for the mobile problems
 * fixed. The first section pins the two changes that carried the measured
 * weight then, and the one correctness defect the audit turned up on the way.
 *
 * The second section is P1a (docs/PERFORMANCE_LOG.md «P1a»,
 * docs/MERCHANT_PLATFORM_V2.md §B.1 #1 and #10). THE MEASURED REASON: every
 * first paint of the store used to wait on a third-party stylesheet —
 * index.html linked Google Fonts, and on the lab's Slow-4G phone the home's
 * LCP was 4.96 s with that link and 2.63 s with the same CSS served locally.
 * So Cairo now lives under public/fonts/cairo/, its three @font-face rules sit
 * in the document's own <style>, the Arabic subset is preloaded, the service
 * worker keeps /fonts/ cache-first, and the CSP no longer names either Google
 * origin. Each of those is a line somebody could quietly undo — a
 * `<link rel="stylesheet">` to a CDN, a dropped preload, a subset left out,
 * `/fonts/` falling back to network-only — and none of them would fail a
 * build. These assertions are what fails instead.
 *
 * Read the SOURCE index.html, not dist/: the build strips comments and adds
 * modulepreload links, but the font lines are copied through unchanged, and
 * the source is what a reviewer edits.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { THEME_BOOT_SCRIPT, THEME_BOOT_SCRIPT_HASH, assetHeadersFile, spaCsp } from '../worker/lib/securityPolicy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const APP = read('src/App.tsx');
const html = read('index.html');

/** The rules of the generated `_headers` file: path → its lines. */
function headerRules(): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  let current = '';
  for (const line of assetHeadersFile().split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!line.startsWith(' ')) { current = line.trim(); rules.set(current, []); continue; }
    rules.get(current)!.push(line.trim());
  }
  return rules;
}
const cacheControlOf = (rules: Map<string, string[]>, path: string) =>
  rules.get(path)?.find((l) => l.startsWith('Cache-Control:'))?.slice('Cache-Control:'.length).trim();

// =========================================================================
// THE ENTRY CHUNK
// =========================================================================

/**
 * These three were STATIC imports, so every visitor to the apex downloaded,
 * parsed and compiled all three before `#root` could paint — although the apex
 * renders none of them. Measured by rebuilding: the entry went 289.3 -> 224.0
 * kB raw and 88.98 -> 72.16 kB gzipped.
 */
test('the merchant storefront is not in the apex entry bundle', () => {
  for (const page of ['Storefront', 'MerchantStart', 'StorefrontProduct']) {
    assert.doesNotMatch(
      APP,
      new RegExp(`^import ${page} from '\\./pages/${page}';`, 'm'),
      `${page} must not be a static import — it puts the whole page in every apex visitor's first paint`
    );
    assert.match(
      APP,
      new RegExp(`const ${page} = React\\.lazy\\(\\(\\) => import\\('\\./pages/${page}'\\)\\)`),
      `${page} must be code-split`
    );
  }
});

/**
 * The mascot renders ON TOP of the shop and only once `ready` is true, so its
 * chunk has the whole of that wait to arrive. A further 11.5 kB gzipped.
 */
test('the mascot is deferred, and its absence is the fallback', () => {
  assert.doesNotMatch(APP, /^import AppIntro from/m);
  assert.match(APP, /const AppIntro = React\.lazy\(\(\) => import\('\.\/components\/bloub\/AppIntro'\)\)/);
  assert.match(APP, /<Suspense fallback={null}>\s*<AppIntro/, 'nothing should be drawn in its place');
});

/**
 * THE PREREQUISITE, and it landed before any of the moves above rather than
 * after the first report. React answers a rejected lazy import by throwing
 * during render; with no boundary the WHOLE tree unmounts and the customer's
 * black shop becomes a blank white page. A failed dynamic import is also
 * CACHED, so only a fresh document can retry — which is why the boundary
 * reloads rather than re-rendering.
 */
test('a chunk that never arrives cannot blank the shop', () => {
  const boundary = read('src/components/ChunkBoundary.tsx');
  assert.match(boundary, /static getDerivedStateFromError/);
  assert.match(boundary, /window\.location\.reload\(\)/, 'a re-render cannot retry a cached rejection');
  assert.match(boundary, /role="alert"/);
  // It must speak the shop's languages, and must not reach into a React
  // context from an error path.
  for (const key of ['ar:', 'en:', 'ckb:']) assert.ok(boundary.includes(key), `missing ${key} copy`);
  // The CALL, not the word — the component's own comment explains why it does
  // not reach into a React context from an error path, and a bare /useLanguage/
  // matches that prose.
  assert.doesNotMatch(boundary, /useLanguage\(/, 'a boundary that throws inside its own fallback is no boundary');
  assert.doesNotMatch(boundary, /^import .*useLanguage/m);

  // Every route tree is wrapped — the full-screen one too (P2 review: with
  // /assets/Auth-*.js aborted, /auth unmounted the root to a blank screen).
  assert.equal(
    (APP.match(/<ChunkBoundary>/g) ?? []).length,
    4,
    'the storefront routes, the full-screen routes, the main routes and the mascot each need one'
  );
  const fullScreen = APP.slice(APP.indexOf('if (isFullScreenRoute) {'), APP.indexOf('{!shellHasToaster && <ToasterGate />}'));
  assert.match(fullScreen, /<ChunkBoundary>\s*<Suspense fallback=\{<RouteFallback \/>\}>\s*<Routes>/, 'the full-screen Routes sit inside a ChunkBoundary');
  assert.match(fullScreen, /<\/Routes>\s*<\/Suspense>\s*<\/ChunkBoundary>/);
});

// =========================================================================
// THE FIVE KURDISH LETTERS
// =========================================================================

/**
 * Measured with fontTools against the live Google subset
 * (SLXVc1nY…QyyS8p4_RHH1.woff2, 30,712 B, 302 glyphs): Cairo carries NONE of
 * U+06D5 ە, U+06CE ێ, U+06C6 ۆ, U+0695 ڕ, U+06B5 ڵ. It does carry چ پ گ ژ,
 * which is why this was never obvious — Kurdish renders, but those five
 * characters drop to a per-glyph system fallback, so one word is set in two
 * typefaces at two weights.
 */
test('the Kurdish letters Cairo lacks are served from our own origin', () => {
  const file = 'public/fonts/cairo-kurdish-patch.woff2';
  assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
  const bytes = statSync(join(ROOT, file)).size;
  assert.ok(bytes > 0 && bytes < 16_384, `the patch should be a few kB, saw ${bytes}`);

  const css = read('src/index.css');
  assert.match(css, /@font-face\s*{[^}]*cairo-kurdish-patch\.woff2/, 'the face must be declared');
  // unicode-range is what makes it free for Arabic and English visitors: a
  // browser fetches a face only when the page uses a character in its range.
  const face = css.slice(css.indexOf('@font-face'), css.indexOf('}', css.indexOf('@font-face')));
  for (const cp of ['U+0695', 'U+06B5', 'U+06C6', 'U+06CE', 'U+06D5']) {
    assert.ok(face.includes(cp), `${cp} must be in the unicode-range`);
  }
  assert.match(face, /font-family:\s*"Cairo"/, 'it joins the Cairo family rather than replacing it');
  // A VARIABLE face with CAIRO'S range. A static face would render bold
  // Kurdish at regular weight; a range that differs from Cairo's `300 900`
  // is a different weight group and Chromium never consults it (P2 review:
  // with `100 900` the patch was never fetched and ە ێ ۆ fell to DejaVu).
  assert.match(face, /font-weight:\s*300 900/, "the patch must share Cairo's 300 900 range to be consulted at all");
  const doc = read('index.html');
  for (const m of doc.matchAll(/@font-face \{[^}]*cairo-v31[^}]*\}/g)) assert.match(m[0], /font-weight: 300 900/, 'the document faces set the range the patch mirrors');
  assert.doesNotMatch(face, /U\+0600-06FF/, 'a whole-block range would override Cairo everywhere');
});

/**
 * `public/fonts/cairo-kurdish-patch.woff2` is NOT content-hashed, so
 * `immutable` would strand a corrected glyph in browsers for a year. It takes
 * the icons policy instead — and since P1a the VERSIONED families beside it
 * (`/fonts/cairo/*`, `/fonts/ibm-plex-mono/*`) take the immutable year, which
 * is why this reads the parsed rule rather than the next 400 characters of
 * source.
 */
test('the patch font revalidates rather than being frozen for a year', () => {
  const rules = headerRules();
  assert.ok(rules.has('/fonts/*'), 'the rule must exist');
  const patch = cacheControlOf(rules, '/fonts/*') ?? '';
  assert.ok(patch.length > 0, '/fonts/* sets no Cache-Control');
  assert.doesNotMatch(patch, /immutable/, 'a fixed name must never be immutable');
  assert.match(patch, /max-age=604800/, 'the icons policy: a week, revalidated');
});

// =========================================================================
// P1a — THE FONTS ARE OURS: the document
// =========================================================================

/** Every element of one tag name with its attribute map — enough HTML for a <head>. */
function tags(source: string, name: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, 'gi');
  for (const m of source.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    out.push(attrs);
  }
  return out;
}

/** The @font-face rules of a stylesheet, as {family, weight, display, src, ranges}. */
function fontFaces(css: string) {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const body = m[1];
    const prop = (name: string) => body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1].trim() ?? '';
    return {
      family: prop('font-family').replace(/^["']|["']$/g, ''),
      weight: prop('font-weight'),
      display: prop('font-display'),
      src: prop('src').match(/url\(\s*["']?([^"')]+)["']?\s*\)/)?.[1] ?? '',
      ranges: prop('unicode-range').split(',').map((r) => r.trim()).filter(Boolean),
    };
  });
}

/** True when a unicode-range list contains the codepoint. */
function covers(ranges: string[], codepoint: number): boolean {
  return ranges.some((r) => {
    const m = r.match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
    if (!m) return false;
    if (m[1].includes('?')) {
      const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
      const hi = parseInt(m[1].replace(/\?/g, 'F'), 16);
      return codepoint >= lo && codepoint <= hi;
    }
    const lo = parseInt(m[1], 16);
    const hi = m[2] ? parseInt(m[2], 16) : lo;
    return codepoint >= lo && codepoint <= hi;
  });
}

const WOFF2_MAGIC = 'wOF2';
const isWoff2 = (rel: string) => readFileSync(join(ROOT, rel.replace(/^\//, 'public/')), 'latin1').slice(0, 4) === WOFF2_MAGIC;
/** The document's own <style> — the element, not the word inside a comment. */
const inlineStyle = () => html.match(/^\s*<style>([\s\S]*?)<\/style>/m)?.[1] ?? '';

test('index.html loads no third-party stylesheet and preconnects to no font host', () => {
  const links = tags(html, 'link');
  const external = links.filter((l) => /^https?:\/\//i.test(l.href ?? ''));
  assert.deepEqual(external, [], `cross-origin <link> in the head: ${external.map((l) => l.href).join(', ')}`);
  assert.equal(links.filter((l) => (l.rel ?? '').split(/\s+/).includes('stylesheet')).length, 0, 'the source document links no stylesheet at all — index.css is injected by Vite');
  assert.equal(links.filter((l) => l.rel === 'preconnect' || l.rel === 'dns-prefetch').length, 0, 'no preconnect: every origin the first paint needs is our own');
  assert.ok(!html.includes('fonts.googleapis.com') && !html.includes('fonts.gstatic.com'), 'Google Fonts is named in index.html');
  assert.ok(!/@import\s+url\(\s*["']?https?:/i.test(html), 'a remote @import in the inline style');
});

test('the Arabic subset is preloaded with the document, as a CORS font, from a file that ships', () => {
  const preloads = tags(html, 'link').filter((l) => l.rel === 'preload');
  const fonts = preloads.filter((l) => l.as === 'font');
  assert.equal(fonts.length, 1, `exactly one font preload (found ${fonts.length}): the Arabic subset is the only one every first paint needs`);
  const [arabic] = fonts;
  assert.equal(arabic.type, 'font/woff2');
  assert.ok('crossorigin' in arabic, 'crossorigin is required for a font preload, same origin or not — without it the browser downloads the file twice');
  assert.match(arabic.href, /^\/fonts\/cairo\/cairo-v\d+-arabic\.woff2$/);
  assert.ok(existsSync(join(ROOT, 'public', arabic.href)), `${arabic.href} is not in public/`);
  assert.ok(isWoff2(arabic.href), `${arabic.href} is not a woff2 file`);
  // The preload must come AFTER the theme script (the script is what must run
  // first, before anything paints) and BEFORE the inline <style> that declares
  // the face, so the request is already in flight when the CSSOM names it.
  const at = html.indexOf('rel="preload" as="font"');
  assert.ok(at > html.indexOf(`<script>${THEME_BOOT_SCRIPT}</script>`), 'the preload precedes the theme script');
  assert.ok(at < html.search(/^\s*<style>/m), 'the preload follows the inline <style>');
});

test('the inline <style> declares Cairo for the three subsets, self-hosted, variable, swapping', () => {
  const style = inlineStyle();
  const faces = fontFaces(style).filter((f) => f.family === 'Cairo');
  assert.equal(faces.length, 3, `three Cairo faces in the document (found ${faces.length})`);
  for (const face of faces) {
    assert.equal(face.weight, '300 900', `${face.src}: the variable axis the store uses (font-light … font-black)`);
    assert.equal(face.display, 'swap', `${face.src}: text must paint in the fallback, never stay invisible`);
    assert.match(face.src, /^\/fonts\/cairo\/cairo-v\d+-(arabic|latin|latin-ext)\.woff2$/, `${face.src}: a self-hosted, versioned name`);
    assert.ok(existsSync(join(ROOT, 'public', face.src)), `${face.src} is not in public/`);
    assert.ok(isWoff2(face.src), `${face.src} is not a woff2 file`);
    assert.ok(face.ranges.length > 0, `${face.src}: a face without unicode-range is downloaded by everyone`);
  }
  const bySubset = Object.fromEntries(faces.map((f) => [f.src.match(/-(arabic|latin|latin-ext)\.woff2$/)![1], f]));
  assert.deepEqual(Object.keys(bySubset).sort(), ['arabic', 'latin', 'latin-ext']);
  // The subsets cover what they are named for — and nothing that would make an
  // Arabic visitor download the Latin file.
  assert.ok(covers(bySubset.arabic.ranges, 0x0639), 'arabic: ع');
  assert.ok(covers(bySubset.arabic.ranges, 0x0660), 'arabic: ٠ (Arabic-Indic digits)');
  assert.ok(covers(bySubset.arabic.ranges, 0xfe70), 'arabic: presentation forms');
  assert.ok(covers(bySubset.latin.ranges, 0x0041), 'latin: A');
  assert.ok(covers(bySubset.latin.ranges, 0x0030), 'latin: 0');
  assert.ok(covers(bySubset['latin-ext'].ranges, 0x0130), 'latin-ext: İ');
  assert.ok(!covers(bySubset.latin.ranges, 0x0639), 'the latin file must not claim Arabic');
  assert.ok(!covers(bySubset.arabic.ranges, 0x0041), 'the arabic file must not claim Latin');
  // The document's @font-face block contains no other family: the fonts of
  // one screen (the /auth blueprint's IBM Plex Mono) belong to that screen's
  // own stylesheet, not to every navigation's document bytes.
  assert.deepEqual([...new Set(fontFaces(style).map((f) => f.family))], ['Cairo']);
});

test('the Kurdish patch face still wins its five letters: declared after the Arabic subset, inside its range', () => {
  // `unicode-range` resolution picks the LAST declared face that covers a
  // codepoint. The patch is in src/index.css, which Vite injects after the
  // document's inline <style>; if it ever moved INTO the document above the
  // Cairo rules, Sorani would silently lose its ە again.
  const css = read('src/index.css');
  const patch = fontFaces(css).find((f) => f.family === 'Cairo' && /kurdish-patch/.test(f.src));
  assert.ok(patch, 'the Kurdish patch face left src/index.css');
  assert.ok(existsSync(join(ROOT, 'public', patch.src)), `${patch.src} is not in public/`);
  const style = inlineStyle();
  const arabic = fontFaces(style).find((f) => /-arabic\.woff2$/.test(f.src))!;
  for (const cp of [0x0693, 0x0695, 0x06b5, 0x06c6, 0x06ce, 0x06d5]) {
    assert.ok(covers(patch.ranges, cp), `the patch no longer covers U+${cp.toString(16).toUpperCase()}`);
    assert.ok(covers(arabic.ranges, cp), `U+${cp.toString(16)} is outside the Arabic subset — the ordering argument would not hold`);
  }
  assert.ok(!/kurdish-patch/.test(style), 'the patch face must stay in index.css, after the document faces');
  assert.equal(fontFaces(css).filter((f) => f.family === 'Cairo').length, 1, 'index.css declares the patch face and no other Cairo face (the three subsets are in the document — see the CSS budget note there)');
});

test('the theme script is still the one hashed inline script, byte for byte', () => {
  // The font work touched the <head> around it. The CSP admits this script by
  // hash and nothing else inline; a stray edit here is a blank theme flash on
  // every page, refused by the browser rather than reported by a test.
  assert.ok(html.includes(`<script>${THEME_BOOT_SCRIPT}</script>`), 'index.html does not carry the pinned theme script');
  assert.equal(THEME_BOOT_SCRIPT_HASH, `sha256-${createHash('sha256').update(THEME_BOOT_SCRIPT, 'utf8').digest('base64')}`);
  assert.ok(spaCsp().includes(`'${THEME_BOOT_SCRIPT_HASH}'`));
  assert.equal(html.split('<script>').length - 1, 1, 'exactly one inline script');
});

// =========================================================================
// P1a — the stylesheets, the licences, the CSP, the headers
// =========================================================================

test('no stylesheet under src/ imports a remote one: the /auth mono face is self-hosted too', () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.css') && /@import\s+(?:url\(\s*)?["']?https?:/i.test(readFileSync(full, 'utf8'))) found.push(full.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, 'src'));
  assert.deepEqual(found, [], `remote @import in: ${found.join(', ')} — the CSP has no font or style origin but our own`);

  const auth = read('src/components/auth/auth.css');
  const plex = fontFaces(auth).filter((f) => f.family === 'IBM Plex Mono');
  assert.deepEqual(plex.map((f) => f.weight).sort(), ['400', '500'], 'the two weights the blueprint annotations use');
  for (const face of plex) {
    assert.match(face.src, /^\/fonts\/ibm-plex-mono\/ibm-plex-mono-v\d+-latin-(400|500)\.woff2$/);
    assert.ok(existsSync(join(ROOT, 'public', face.src)), `${face.src} is not in public/`);
    assert.ok(isWoff2(face.src));
    assert.equal(face.display, 'swap');
  }
  assert.ok(auth.includes("font-family: 'IBM Plex Mono'"), 'the annotations still ask for Plex Mono by name');
});

test('every self-hosted family ships an OFL licence beside its files', () => {
  for (const dir of ['public/fonts/cairo', 'public/fonts/ibm-plex-mono']) {
    const licence = join(ROOT, dir, 'LICENSE');
    assert.ok(existsSync(licence), `${dir}/LICENSE is missing`);
    assert.match(readFileSync(licence, 'utf8'), /SIL Open Font License, Version 1\.1/);
    assert.ok(readdirSync(join(ROOT, dir)).some((f) => f.endsWith('.woff2')), `${dir} has no woff2`);
  }
});

test('the SPA policy names no font or style origin but our own (and Google sign-in for its button)', () => {
  const csp = spaCsp();
  assert.ok(!csp.includes('fonts.googleapis.com') && !csp.includes('fonts.gstatic.com'));
  const fontSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('font-src '))!;
  assert.equal(fontSrc, "font-src 'self' data:");
});

test('the versioned font files take the immutable year; the fixed-name patch keeps its week', () => {
  const rules = headerRules();
  assert.match(cacheControlOf(rules, '/fonts/cairo/*') ?? '', /immutable/);
  assert.match(cacheControlOf(rules, '/fonts/ibm-plex-mono/*') ?? '', /immutable/);
  assert.doesNotMatch(cacheControlOf(rules, '/fonts/*') ?? 'immutable', /immutable/, 'the patch face has a fixed name and must stay revalidatable');
  const order = [...rules.keys()];
  assert.ok(order.indexOf('/fonts/*') < order.indexOf('/fonts/cairo/*'), 'the specific rule must follow the general one to win');
  // Every versioned name really is versioned, or `immutable` pins a stale file.
  for (const dir of ['public/fonts/cairo', 'public/fonts/ibm-plex-mono']) {
    for (const f of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.woff2'))) assert.match(f, /-v\d+-/, `${dir}/${f} carries no version`);
  }
});

// =========================================================================
// P1a — the service worker
// =========================================================================

type Listener = (event: unknown) => void;

/** public/sw.js in a node:vm with the smallest scope it needs; `fetch` is counted. */
function loadServiceWorker() {
  const source = read('public/sw.js');
  const listeners = new Map<string, Listener[]>();
  const state = { preloadEnabled: false, fetched: 0 };
  const self = {
    location: new URL('https://levonis-iq.com/'),
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    skipWaiting() {},
    clients: { async claim() {} },
    registration: { navigationPreload: { async enable() { state.preloadEnabled = true; } } },
  } as Record<string, unknown>;
  const context: Record<string, unknown> = {
    self,
    caches: {
      async keys() { return []; },
      async open() { return { async match() { return undefined; }, async put() {}, async keys() { return []; } }; },
      async delete() { return true; },
    },
    fetch: async () => {
      state.fetched += 1;
      return new Response('<!doctype html><title>network</title>', { headers: { 'content-type': 'text/html' } });
    },
    Response, Request, Headers, URL,
    console: { debug() {} },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'public/sw.js' });
  return {
    source,
    state,
    listeners,
    strategyFor: self.strategyFor as (url: URL, request: unknown) => string,
    internals: self.__LEVONIS_SW__ as { VERSION: string },
  };
}

const request = (url: string, init: { method?: string; mode?: string; destination?: string; headers?: Record<string, string> } = {}) => ({
  url, method: init.method ?? 'GET', mode: init.mode ?? 'no-cors', destination: init.destination ?? '', headers: new Headers(init.headers ?? {}),
});

test('the service worker persists /fonts/* cache-first and still never touches /api or /files', () => {
  const sw = loadServiceWorker();
  const decide = (path: string) => sw.strategyFor(new URL(path, 'https://levonis-iq.com'), request(path));
  assert.equal(decide('/fonts/cairo/cairo-v31-arabic.woff2'), 'cache-first');
  assert.equal(decide('/fonts/cairo/cairo-v31-latin.woff2'), 'cache-first');
  assert.equal(decide('/fonts/ibm-plex-mono/ibm-plex-mono-v20-latin-400.woff2'), 'cache-first');
  assert.equal(decide('/fonts/cairo-kurdish-patch.woff2'), 'cache-first');
  // …with the same guards as the chunks: a cache-buster or a Range is not stored.
  assert.equal(decide('/fonts/cairo/cairo-v31-arabic.woff2?v=2'), 'network-only');
  assert.equal(sw.strategyFor(new URL('/fonts/cairo/cairo-v31-arabic.woff2', 'https://levonis-iq.com'), request('/fonts/cairo/cairo-v31-arabic.woff2', { headers: { Range: 'bytes=0-9' } })), 'network-only');
  // The two surfaces that must never be cached, unchanged.
  assert.equal(decide('/api/products'), 'network-only');
  assert.equal(decide('/files/products/x.webp'), 'network-only');
  assert.equal(decide('/manifest.webmanifest'), 'network-only');
  // A font from another origin is still not ours to store.
  assert.equal(sw.strategyFor(new URL('https://fonts.gstatic.com/s/cairo.woff2'), request('https://fonts.gstatic.com/s/cairo.woff2')), 'network-only');
});

test('activate enables navigation preload, and a navigation uses the preloaded response instead of a second fetch', async () => {
  const sw = loadServiceWorker();
  assert.notEqual(sw.internals.VERSION, 'v3', 'the cache version must move with the new rules');
  const waits: Promise<unknown>[] = [];
  for (const fn of sw.listeners.get('activate') ?? []) fn({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits.map((p) => p.catch(() => undefined)));
  assert.equal(sw.state.preloadEnabled, true, 'registration.navigationPreload.enable() was not called on activate');

  // A navigation whose preload resolved: the worker must answer with it and
  // not call fetch at all — that second request is exactly the cost preload removes.
  const preloaded = new Response('<!doctype html><title>preloaded</title>', { status: 200, headers: { 'content-type': 'text/html' } });
  let answered: Promise<Response> | undefined;
  const event = {
    request: request('https://levonis-iq.com/products', { mode: 'navigate', destination: 'document' }),
    preloadResponse: Promise.resolve(preloaded),
    respondWith(p: Promise<Response>) { answered = p; },
    waitUntil() {},
  };
  for (const fn of sw.listeners.get('fetch') ?? []) fn(event);
  assert.ok(answered, 'the navigation was not answered');
  assert.equal(await (await answered!).text(), '<!doctype html><title>preloaded</title>');
  assert.equal(sw.state.fetched, 0, 'fetch was called although the preload had answered');

  // Without a preload (an older browser, or a preload that rejected) the
  // network-first fetch happens exactly as before.
  answered = undefined;
  const plain = { ...event, preloadResponse: Promise.reject(new Error('no preload')) };
  for (const fn of sw.listeners.get('fetch') ?? []) fn(plain);
  assert.equal(await (await answered!).text(), '<!doctype html><title>network</title>');
  assert.equal(sw.state.fetched, 1);
});
