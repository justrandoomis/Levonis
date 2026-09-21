/**
 * WHAT A PHONE DOWNLOADS BEFORE THE SHOP APPEARS, AND WHAT IT RENDERS IT IN.
 *
 * The owner sent two PageSpeed reports and asked for the mobile problems
 * fixed. These pin the two changes that carry the measured weight, and the one
 * correctness defect the audit turned up on the way.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const APP = read('src/App.tsx');

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

  // Both route trees are wrapped.
  assert.equal(
    (APP.match(/<ChunkBoundary>/g) ?? []).length,
    3,
    'the storefront routes, the main routes and the mascot each need one'
  );
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
  assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} is missing`);
  const bytes = statSync(new URL(`../${file}`, import.meta.url)).size;
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
  assert.match(face, /font-weight:\s*100 900/, 'a static face would render bold Kurdish at regular weight');
  assert.doesNotMatch(face, /U\+0600-06FF/, 'a whole-block range would override Cairo everywhere');
});

/**
 * `public/fonts/*` is NOT content-hashed, so `immutable` would strand a
 * corrected glyph in browsers for a year. It takes the icons policy instead.
 */
test('the patch font revalidates rather than being frozen for a year', () => {
  const policy = read('worker/lib/securityPolicy.ts');
  assert.match(policy, /'\/fonts\/\*'/, 'the rule must exist');
  const block = policy.slice(policy.indexOf("'/fonts/*'"));
  assert.doesNotMatch(block.slice(0, 400), /immutable/, 'a fixed name must never be immutable');
});
