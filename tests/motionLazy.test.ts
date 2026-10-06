/**
 * MOTION IS NOT IN THE FIRST PAINT (docs/MERCHANT_PLATFORM_V2.md §B.1 #6, P1b).
 *
 * WHAT WAS MEASURED. The survey lab (docs/MERCHANT_PLATFORM_V2_SURVEY.md
 * «perf-measure») found `vendor-motion` — 45.9 KB gzip, the whole animation
 * library with its projection tree, drag and pan gestures and layout animator
 * — in the static closure of the entry: downloaded and parsed (×4 CPU) before
 * the hero could paint, because one hook (`useReducedMotion`) and the eager
 * primitives' `motion.*` elements imported it. No first screen animates any
 * of that.
 *
 * WHAT HOLDS NOW, and what this file pins in the built `dist/`:
 *
 *  1. The features half (`vendor-motion`) is never a static import of the
 *     entry; the eager half (`vendor-motion-core`: `m`, `animate`, motion
 *     values, AnimatePresence) is what remains before paint, and it is small.
 *     The features arrive through the lazy bundle
 *     (`motionFeaturesBundle`, src/lib/motionFeatures.tsx), prefetched from
 *     idle and on the first pointer.
 *  2. No projection, drag or pan code is anywhere in the initial payload —
 *     checked by fingerprint, not by file name, so a regrouping that merges
 *     the two halves under one name still fails.
 *  3. The icons the lazy routes share are one `vendor-icons` chunk instead
 *     of 112 files under 1 KB, and that chunk is not in the first paint
 *     either.
 *  4. The sources keep the shape that makes 1–3 true: `src/lib/motion.ts`
 *     answers the reduced-motion question with a media query, and every
 *     eager primitive renders `m.*` from `motion/react-m` under
 *     <MotionFeatures>, never the `motion` proxy.
 *
 * The dist walk (static imports, entry from index.html, build-when-stale) is
 * the one tests/bundleBudget.test.ts uses, repeated here rather than imported
 * so that running this file alone does not also run that suite.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ASSETS = join(DIST, 'assets');
const KB = 1024;
const gz = (path: string) => gzipSync(readFileSync(path), { level: 9 }).length;
const kb = (n: number) => `${(n / KB).toFixed(1)} KB`;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Measured at P1b: features 15.7 KB, core 31.7 KB, icons 12.1 KB gzip. Each cap is the number plus ~25 %: room for a library upgrade, not for a regrouping. */
const FEATURES_BUDGET = 20 * KB;
const CORE_BUDGET = 40 * KB;
const ICONS_BUDGET = 16 * KB;
/** 138 chunks under 1 KB before the icon chunk, 28 after (small app modules two lazy routes share). */
const TINY_CHUNKS_MAX = 45;

/** Identifiers that only the projection tree, the drag gesture and the pan session carry; they survive minification as property names. */
const FEATURE_FINGERPRINTS = ['isProjectionDirty', 'resolveTargetDelta', 'scheduleUpdateProjection', 'panSession'];

function staticImports(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:^|[^A-Za-z0-9_$.])(?:import|from)\s*["'](\.\/[^"']+\.js)["']/g)) out.add(m[1].slice(2));
  return [...out];
}

function entryFromHtml(html: string): string | null {
  const m = /<script[^>]+type="module"[^>]+src="\/assets\/([^"]+\.js)"/.exec(html) ?? /<script[^>]+src="\/assets\/([^"]+\.js)"[^>]+type="module"/.exec(html);
  return m?.[1] ?? null;
}

function staticClosure(start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of staticImports(readFileSync(join(ASSETS, file), 'utf8'))) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = info.mtimeMs;
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)));
  return newest;
}

function distIsStale(): boolean {
  const built = newestMtime(join(DIST, 'index.html'));
  if (!built) return true;
  return [join(ROOT, 'src'), join(ROOT, 'public'), join(ROOT, 'index.html'), join(ROOT, 'vite.config.ts')].some((p) => newestMtime(p) > built);
}

before(() => {
  if (existsSync(ASSETS) && !distIsStale()) return;
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('node', ['scripts/write-asset-headers.mjs'], { cwd: ROOT, stdio: 'inherit' });
  assert.ok(existsSync(ASSETS), 'vite build produced no dist/assets');
});

const files = () => readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
const chunk = (re: RegExp) => files().find((f) => re.test(f));
const initial = () => staticClosure(entryFromHtml(readFileSync(join(DIST, 'index.html'), 'utf8'))!);

test('the animation features are their own lazy chunk, never a static import of the entry; the core stays', () => {
  const features = chunk(/^vendor-motion-(?!core-)/);
  const core = chunk(/^vendor-motion-core-/);
  const bundle = chunk(/^motionFeaturesBundle-/);
  assert.ok(features, 'no vendor-motion chunk — the features half was regrouped');
  assert.ok(core, 'no vendor-motion-core chunk — the eager half was regrouped');
  assert.ok(bundle, 'no motionFeaturesBundle chunk — the lazy features import was inlined (src/lib/motionFeaturesBundle.ts explains the statement it needs)');
  const closure = initial();
  assert.equal(closure.has(features!), false, `${features} is in the initial payload — an eager module renders \`motion.*\` (or imports \`useReducedMotion\`) from 'motion/react' again`);
  assert.equal(closure.has(bundle!), false, `${bundle} is a STATIC import of the entry`);
  assert.ok(closure.has(core!), `${core} is not in the initial payload — the eager primitives no longer use m/AnimatePresence at all?`);
  // The lazy bundle must reach the features, or nothing ever animates.
  assert.ok(staticClosure(bundle!).has(features!), 'the features bundle does not import vendor-motion — LazyMotion would load nothing');
  const sizes = { features: gz(join(ASSETS, features!)), core: gz(join(ASSETS, core!)) };
  console.log(`motion: features ${kb(sizes.features)} gzip (lazy), core ${kb(sizes.core)} gzip (eager)`);
  assert.ok(sizes.features <= FEATURES_BUDGET, `the features chunk is ${kb(sizes.features)} gzip, over ${kb(FEATURES_BUDGET)}`);
  assert.ok(sizes.core <= CORE_BUDGET, `the motion core is ${kb(sizes.core)} gzip, over ${kb(CORE_BUDGET)} — a feature module moved into the eager half (vite.config.ts MOTION_FEATURES)`);
});

test('no projection, drag or pan code is anywhere in the initial payload', () => {
  for (const file of initial()) {
    const code = readFileSync(join(ASSETS, file), 'utf8');
    for (const mark of FEATURE_FINGERPRINTS) {
      assert.equal(code.includes(mark), false, `${file} carries \`${mark}\` — projection/gesture code is back before the first paint`);
    }
  }
  const features = chunk(/^vendor-motion-(?!core-)/)!;
  const code = readFileSync(join(ASSETS, features), 'utf8');
  for (const mark of FEATURE_FINGERPRINTS) assert.ok(code.includes(mark), `the fingerprint \`${mark}\` is gone from ${features} — pick another before trusting this test`);
});

test('the icons the lazy routes share are one chunk, outside the first paint, and the sub-1 KB chunks are gone', () => {
  const icons = chunk(/^vendor-icons-/);
  assert.ok(icons, 'no vendor-icons chunk — vite.config.ts iconChunk was removed');
  assert.equal(initial().has(icons!), false, `${icons} is in the initial payload — an icon the entry uses was assigned to it`);
  const size = gz(join(ASSETS, icons!));
  const tiny = files().filter((f) => statSync(join(ASSETS, f)).size < KB);
  console.log(`icons: ${kb(size)} gzip; ${tiny.length} chunk(s) under 1 KB raw`);
  assert.ok(size <= ICONS_BUDGET, `vendor-icons is ${kb(size)} gzip, over ${kb(ICONS_BUDGET)}`);
  assert.ok(tiny.length <= TINY_CHUNKS_MAX, `${tiny.length} chunks under 1 KB — the icon grouping stopped working:\n${tiny.join('\n')}`);
  // The factory rides with React, not with the icons (a manual chunk swallows
  // its modules' unassigned dependencies, which pulled it into vendor-icons and
  // the entry after it).
  const react = chunk(/^vendor-react-/)!;
  assert.ok(/createLucideIcon|lucide/.test(readFileSync(join(ASSETS, react), 'utf8')), 'the lucide factory is not in vendor-react');
});

test('the sources keep the shape: a media query for reduced motion, m.* under <MotionFeatures>, never the proxy in an eager module', () => {
  const motion = read('src/lib/motion.ts');
  assert.doesNotMatch(motion, /from 'motion\/react'/, 'src/lib/motion.ts imports the library again');
  assert.match(motion, /matchMedia\(REDUCED_MOTION_QUERY\)/);
  assert.match(motion, /const REDUCED_MOTION_QUERY = '\(prefers-reduced-motion: reduce\)';/);
  assert.match(motion, /export function usePrefersReducedMotion\(\): boolean \{\s*return useSyncExternalStore\(subscribeReducedMotion, readReducedMotion, serverReducedMotion\);/);
  assert.match(motion, /const prefersReduced = usePrefersReducedMotion\(\);/, 'useMotion() reads the media query');
  assert.match(motion, /addEventListener\('change', onChange\)/, 'the preference updates when the OS setting changes');

  // The eager primitives, the panel and the rail: `m` from motion/react-m, no `motion` proxy, no useReducedMotion.
  const eager = [
    'src/components/ui/Overlay.tsx',
    'src/components/ui/Toast.tsx',
    'src/components/ui/Segmented.tsx',
    'src/components/ui/AppBusy.tsx',
    'src/components/pwa/UpdateReadyToast.tsx',
    'src/components/search/LiveSearch.tsx',
    'src/components/search/LiveSearchPanel.tsx',
    'src/lib/useRail.ts',
    'src/lib/motionFeatures.tsx',
  ];
  for (const f of eager) {
    const src = read(f);
    for (const line of src.split('\n').filter((l) => /from 'motion\/react'/.test(l))) {
      assert.doesNotMatch(line, /\bmotion\b(?!\/)/, `${f} imports the \`motion\` proxy: ${line.trim()}`);
      assert.doesNotMatch(line, /useReducedMotion/, `${f} imports useReducedMotion: ${line.trim()}`);
    }
    assert.doesNotMatch(src, /<motion\./, `${f} renders <motion.*>`);
    if (/<Motion\./.test(src)) {
      assert.match(src, /import \* as Motion from 'motion\/react-m';/, `${f} renders Motion.* without the react-m import`);
      assert.match(src, /<MotionFeatures>/, `${f} renders m.* elements with no <MotionFeatures> provider — they would never animate`);
    }
  }
  const features = read('src/lib/motionFeatures.tsx');
  assert.match(features, /import\('\.\/motionFeaturesBundle'\)/, 'the features are a dynamic import');
  assert.match(features, /<LazyMotion features=\{loaded \?\? quietLoader\}>/, 'once loaded, the bundle is passed synchronously');
  // The failure path (P2 review): a rejected import is recorded, never thrown
  // at the page, and the primitives paint at rest when it has failed.
  assert.match(features, /function quietLoader\(\): Promise<FeatureBundle> \{\s*return loadMotionFeatures\(\)\.catch\(\(\) => new Promise<FeatureBundle>\(\(\) => \{\}\)\);/, "LazyMotion's loader must not reject (it has no catch)");
  assert.match(features, /export function useMotionFeaturesFailed\(\): boolean \{\s*return React\.useSyncExternalStore\(subscribe, readFailed, readServer\);/);
  assert.match(features, /\.catch\(\(err: unknown\) => \{\s*loading = null;\s*setFailed\(true\);/, 'a failure sets the flag and lets the next mount retry');
  for (const f of ['src/components/ui/Overlay.tsx', 'src/components/ui/Toast.tsx', 'src/components/ui/AppBusy.tsx', 'src/components/pwa/UpdateReadyToast.tsx', 'src/components/search/LiveSearchPanel.tsx']) {
    const src = read(f);
    assert.match(src, /useMotionFeaturesFailed\(\)/, `${f} does not ask whether the features failed`);
    const initials = [...src.matchAll(/^\s*initial=\{([^\n]*)\}\s*$/gm)].map((m) => m[1]);
    assert.ok(initials.length > 0, `${f}: no initial= prop found`);
    for (const init of initials) assert.match(init, /^atRest \? false : /, `${f}: initial={${init}} does not fall back to rest when the bundle failed`);
  }
  assert.doesNotMatch(features, /<LazyMotion[^>]*\bstrict\b/, 'strict mode would throw for the lazy pages that still render motion.*');
  assert.match(read('src/lib/motionFeaturesBundle.ts'), /import \{ domMax, type FeatureBundle \} from 'motion\/react';/, 'domMax: the sheets drag and the toasts animate layout');

  // The search panel loads on the first touch of the field; the bell with the session; the prefetch waits for the first screen.
  const search = read('src/components/search/LiveSearch.tsx');
  assert.match(search, /const LiveSearchPanel = React\.lazy\(\(\) => import\('\.\/LiveSearchPanel'\)\);/);
  assert.match(search, /onPointerDown=\{arm\}/);
  assert.match(search, /onFocus=\{\(\) => \{\s*arm\(\);/);
  const header = read('src/components/Header.tsx');
  assert.match(header, /const NotificationBell = React\.lazy\(\(\) => import\('\.\/notifications\/NotificationBell'\)\);/);
  assert.match(header, /\{isAuthenticated && \(\s*<Suspense fallback=\{null\}>\s*<NotificationBell \/>/);
  assert.doesNotMatch(header, /^import .* from '\.\/subscription\/tierMeta';/m, 'the tier table is a static import of the Header again');
  const app = read('src/App.tsx');
  assert.match(app, /const ready = pathname === '\/' && homeReady;/, 'speculation needs the home data; another route\'s shell is not proof its photo is ready');
  assert.match(app, /return afterCriticalPaint\(/, 'speculation waits for fonts and visible pictures, not just an idle JS thread');
  assert.match(app, /!allowsSpeculativeLoads\(\)/, 'reduced-data connections do not download speculative routes');
  assert.match(app, /preload\(Products\);\s*preloadMotionFeatures\(\);/, 'idle prefetches the catalogue and the motion features, nothing else');
  assert.match(app, /document\.addEventListener\('pointerdown', onIntent, true\)/, 'Product, Cart and Addresses are fetched on the first pointer over their links');
  for (const lazy of ['EmailVerifyBanner', 'CompleteProfileSheet', 'ThemeIntroSheet']) {
    assert.match(app, new RegExp(`const ${lazy}Lazy = React\\.lazy\\(\\(\\) => import\\('\\./components/[a-z]+/${lazy}'\\)\\);`), `${lazy} is not lazy`);
    assert.match(app, new RegExp(`<${lazy} />`), `${lazy} is no longer rendered under that name`);
  }
});
