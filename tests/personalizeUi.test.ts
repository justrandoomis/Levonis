/**
 * THE STUDIO CORE ON THE SCREEN (Programme C, phase C1, lane L8) —
 * src/components/personalize/** (docs/LEVO_PROJECT_PROGRAMME.md §B.1 P12, P15,
 * §B.2, §C.6 «Compactness» and «Craft», §F F9, F10, F13; survey §5.4).
 *
 *   the words: every key in ar, en AND written Sorani; ckb ≠ ar ≠ en per key
 *   (a string of placeholders and punctuation alone excepted); ≥ 90 % of the
 *   Sorani letters Arabic-script and ≥ 90 % of the Sorani strings carrying a
 *   letter only Sorani writes; no OWNER marker; the customer vocabulary
 *   (P12 — a local forbidden list until L10's tests/customerVocabulary.test.ts
 *   lands, then import its list);
 *   the craft: theme tokens only, no hex, no `dark:`, logical utilities, no
 *   native dialogs, no `motion` proxy;
 *   the weight: the studio is lazy-only (no static import from main.tsx /
 *   App.tsx / the storefront pages reaches this folder), and the studio's own
 *   static graph holds neither the live model (the viewer, the decals), the
 *   picture/QR/icon editors, the More sheet, the icon set, the taste
 *   functions nor the words of the three languages (each a dynamic import);
 *   the row: ControlRow renders EXACTLY the compiled tiles + the door for every
 *   fixture blueprint (react-dom/server) — archetype A = 5 row controls;
 *   the simplified slot markers: glow / ring / badge declared and drawn only
 *   while the slot is filled;
 *   the state: the reducer keeps the configuration valid (the text rule, the
 *   letters, the allowed colours, sold variants, declared options), undo;
 *   the derivation < 2 ms a change; the verdict line for every check code;
 *   the look card's id-map codec and quad maths; the icon set = lucide's.
 *
 * Run: node --import tsx --test tests/personalizeUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { FIXTURES, NAME_STAND_CONFIG } from './fixtures/personalizeBlueprints';
import { CHECK_CODES, SAY_CODES, checkGroup } from '../packages/catalog/src/personalize/vocab';
import { BETTER_CODES } from '../packages/catalog/src/personalize/suggest';
import { normalizeTarget } from '../packages/catalog/src/personalize/config';
import type { CheckFinding } from '../packages/catalog/src/personalize/check';
import type { DesignConfig, PublicBlueprint } from '../packages/catalog/src/personalize/types';

// The language provider reads `levo_lang` from localStorage on mount; a stub lets each render pick its language.
let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { studioWords, studioLang, fill } = await import('../src/components/personalize/strings');
// One file per language (the studio loads the one on the screen); the tests read all three.
const STUDIO_STRINGS = {
  ar: (await import('../src/components/personalize/strings.ar')).default,
  en: (await import('../src/components/personalize/strings.en')).default,
  ckb: (await import('../src/components/personalize/strings.ckb')).default,
};
const studioStrings = (lang: string) => STUDIO_STRINGS[studioLang(lang)];
const studio = await import('../src/components/personalize/useStudio');
const { ControlRow } = await import('../src/components/personalize/ControlRow');
const { readyLine, targetOf } = await import('../src/components/personalize/ReadyLine');
const { SLOT_MARKERS, markerFor, viewOf, decalFrame, FINISH_OF } = await import('../src/components/personalize/live');
const { encodeIdMap, decodeIdMap, frameQuad, frameWidthAxis } = await import('../src/components/personalize/lookcard');
const { ICON_PATHS } = await import('../src/components/personalize/iconPaths');
const { photoFor } = await import('../src/components/personalize/SceneFallback');
const { initState, reduce, derive, rebase, cleanTyping, sizeWordIndex, swatchesFor, colorsAttr } = studio;

const DIR = 'src/components/personalize';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const FILES = readdirSync(join(ROOT, DIR)).filter((f) => /\.tsx?$/.test(f)).map((f) => `${DIR}/${f}`);
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: node }));
};

type Leaf = [string, string];
function leaves(o: unknown, path = ''): Leaf[] {
  if (typeof o === 'string') return [[path, o]];
  if (Array.isArray(o)) return o.flatMap((v, i) => leaves(v, `${path}.${i}`));
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}
const letterless = (s: string) => !/\p{L}/u.test(s.replace(/\{\w+\}/g, '').replace(/QR|IQD/g, ''));
const SORANI = /[ەۆێڕڵڤگچپژیک]/;

// ------------------------------------------------------------------ the words

test('every word exists in ar, en and written Sorani — distinct per key, no Arabic standing in for ckb', async () => {
  const ar = leaves(STUDIO_STRINGS.ar);
  for (const lang of ['en', 'ckb'] as const) assert.deepEqual(leaves(STUDIO_STRINGS[lang]).map(([k]) => k), ar.map(([k]) => k), `${lang} has exactly the Arabic keys`);
  const en = new Map(leaves(STUDIO_STRINGS.en));
  const ckb = new Map(leaves(STUDIO_STRINGS.ckb));
  let sorani = 0;
  let worded = 0;
  let letters = 0;
  let arabicScript = 0;
  for (const [k, a] of ar) {
    const e = en.get(k)!;
    const c = ckb.get(k)!;
    assert.ok(a && e && c, `${k}: a word in every language`);
    // Placeholders stay placeholders in every language.
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(ph(e), ph(a), `${k}: the English keeps the placeholders`);
    assert.equal(ph(c), ph(a), `${k}: the Sorani keeps the placeholders`);
    if (letterless(a)) continue;
    assert.notEqual(c, a, `${k}: the Sorani is the Arabic («${c}»)`);
    assert.notEqual(c, e, `${k}: the Sorani is the English`);
    assert.notEqual(a, e, `${k}: the Arabic is the English`);
    worded += 1;
    if (SORANI.test(c)) sorani += 1;
    for (const ch of c.replace(/\{\w+\}/g, '')) {
      if (!/\p{L}/u.test(ch)) continue;
      letters += 1;
      if (/[؀-ۿ]/.test(ch)) arabicScript += 1;
    }
  }
  assert.ok(sorani / worded >= 0.9, `only ${sorani} of ${worded} Sorani strings carry a letter only Sorani writes`);
  assert.ok(arabicScript / letters >= 0.9, `only ${arabicScript} of ${letters} Sorani letters are Arabic-script`);
  // The five row labels reuse the app's existing human Sorani.
  assert.deepEqual([STUDIO_STRINGS.ckb.tiles.name, STUDIO_STRINGS.ckb.tiles.look, STUDIO_STRINGS.ckb.tiles.size, STUDIO_STRINGS.ckb.tiles.more], ['ناو', 'ڕەنگەکان', 'قەبارە', 'زیاتر']);
  assert.equal(STUDIO_STRINGS.ckb.door.add_to_cart, 'زیادکردن بۆ سەبەتە');
  assert.equal(STUDIO_STRINGS.ckb.door.request, 'داوای چاپکردنی بکە');
  assert.equal(STUDIO_STRINGS.ar.door.request, 'اطلب الطباعة');
  assert.equal(STUDIO_STRINGS.ar.door.add_to_cart, 'أضف إلى السلة');
  assert.equal(STUDIO_STRINGS.ar.door.ask, 'اسأل المتجر');
  assert.equal(STUDIO_STRINGS.en.ready, 'Ready to print');
  assert.equal((await studioWords('fr')).ready, 'جاهز للطباعة', 'an unknown language falls back to Arabic');
  assert.equal(await studioWords('ckb'), STUDIO_STRINGS.ckb, 'the loader reads the language file');
  assert.equal(studioWords('en'), studioWords('en'), 'one promise per language, so `use` reads it synchronously once loaded');
  assert.equal(fill('{a} + {b}', { a: 1 }), '1 + {b}');
});

test('one sentence per engine code — every check code, rule explanation and «Make it better» suggestion', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const t = STUDIO_STRINGS[lang];
    for (const c of CHECK_CODES) assert.ok(t.check[c]?.length > 6, `${lang}: ${c}`);
    for (const c of SAY_CODES) assert.ok(t.say[c]?.length > 6, `${lang}: say ${c}`);
    for (const c of BETTER_CODES) assert.ok(t.betterSay[c]?.length > 6, `${lang}: better ${c}`);
  }
});

test('no OWNER marker and no Arabic placeholder left for a translator in this folder', () => {
  for (const f of FILES) assert.doesNotMatch(read(f), /OWNER:|TODO\(ckb\)|XXX/, f);
});

/**
 * THE CUSTOMER VOCABULARY (P12, §F F10) — a local list until L10's
 * tests/customerVocabulary.test.ts exports the canonical one (then import it).
 */
const FORBIDDEN: Record<'ar' | 'en' | 'ckb', RegExp[]> = {
  en: [/\bstl\b/i, /\b3mf\b/i, /\bobj\b/i, /\bmesh/i, /\bpolygon/i, /\btriangle/i, /\bverte(x|ices)\b/i, /\bslic(er|ing|e)\b/i, /\binfill/i, /\bnozzle/i, /\blayers?\b/i, /\bsupports?\b/i, /\bg-?code/i, /\bextrud/i, /\bcad\b/i, /\bmanifold/i],
  ar: [/شبكة مضلعات|ميش/, /مضلع/, /مثلث/, /رؤوس/, /تقطيع|شرائح/, /حشو/, /فوهة|نوزل/, /طبق[ةا]/, /دعام/, /جي ?كود/, /بثق|الطارد/, /\bكاد\b/, /مانيفولد/],
  ckb: [/مێش/, /فرەگۆشە/, /سێگۆشە/, /لووتکە/, /سلایس/, /پڕکردنەوەی ناوەوە/, /نۆزڵ/, /\sچین\s|^چین/, /پاڵپشت/, /جی کۆد/, /ئێکسترۆد/, /\bکاد\b/, /مانیفۆڵد/],
};

test('customer vocabulary — no workshop, file or geometry word in any studio string', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const [k, s] of leaves(STUDIO_STRINGS[lang])) {
      for (const re of [...FORBIDDEN[lang], ...FORBIDDEN.en]) assert.doesNotMatch(s, re, `${lang}.${k}: «${s}»`);
    }
  }
});

// ------------------------------------------------------------------ the craft

const CLASS_LITERALS = (src: string): string[] =>
  [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})|(?:const \w+ = |: |\? |&& )'((?:lv-|flex|h-|w-|px-|text-)[^']*)'/g)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' '));
const TOKENS = /^(canvas|surface|surface-raised|surface-selected|text-primary|text-secondary|text-muted|border-subtle|gold|success|warning|danger|current|transparent)(\/\d+|\/\[[^\]]+\])?$/;

test('theme tokens only — no hex, no dark:, no physical left/right utilities, no inline colour but the engine\'s numbers', () => {
  for (const f of FILES) {
    const src = code(f);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${f}: a hex colour`);
    assert.doesNotMatch(src, /\bdark:/, `${f}: a dark: variant`);
    for (const cls of CLASS_LITERALS(src).flatMap((c) => c.split(/\s+/)).filter(Boolean)) {
      const bare = cls.replace(/^(?:[a-z0-9-]+:)+/, '');
      assert.doesNotMatch(bare, /^-?(ml|mr|pl|pr|left|right)-|^(text-left|text-right|float-left|float-right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br)\b/, `${f}: physical utility ${cls}`);
      const colour = /^(bg|text|border|divide|ring|fill|stroke|from|to|via|outline|decoration|placeholder|caret|accent|shadow)-(.+)$/.exec(bare);
      if (!colour) continue;
      const v = colour[2];
      // Sizes, widths and layout words that share a prefix with a colour utility.
      if (/^(\[\d|\d|xs|sm|base|lg|xl|\dxl|center|start|end|left|right|justify|ellipsis|clip|wrap|nowrap|balance|pretty|none|solid|dashed|dotted|double|opacity|x|y|s|e|t|b|inset|clip|repeat|cover|contain|auto|fixed|local|scroll|no-repeat|origin|gradient|blend)/.test(v)) continue;
      assert.match(v, TOKENS, `${f}: «${cls}» is not a theme token`);
    }
    for (const m of src.matchAll(/(?:backgroundColor|color|background|borderColor)\s*:\s*`?([^,}`]+)/g)) assert.match(m[1], /rgb\(\$\{|rgb\(\$\{rgb|\.\.\.dot\(/, `${f}: an inline colour that is not the engine's numbers (${m[1]})`);
  }
});

test('no native dialogs and no `motion` proxy — m.* under <MotionFeatures> only', () => {
  for (const f of FILES) {
    const src = code(f);
    assert.doesNotMatch(src, /(?<![\w.])(?:window\.)?(alert|confirm|prompt)\s*\(/, `${f}: a native dialog`);
    assert.doesNotMatch(src, /import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*'motion\/react'/, `${f}: the motion proxy`);
    assert.doesNotMatch(src, /\bmotion\.[a-z]+\b/, `${f}: a motion.* element`);
    if (/Motion\.\w+/.test(src)) {
      assert.match(src, /import \* as Motion from 'motion\/react-m'/, `${f}: Motion is motion/react-m`);
      assert.match(src, /<MotionFeatures>/, `${f}: Motion.* sits under <MotionFeatures>`);
    }
    assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b/, `${f}: no browser storage in C1`);
  }
});

// ------------------------------------------------------------------ the weight

/** Static imports of a source file (not `import type`, not `import()`), resolved to repository paths. */
function staticImports(rel: string): string[] {
  const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    let base: string | null = null;
    if (spec.startsWith('.')) base = join(dirname(rel), spec);
    else if (spec.startsWith('@levonis/')) {
      const [, pkg, ...rest] = spec.split('/');
      base = `packages/${pkg}/src/${rest.join('/')}`;
    }
    if (!base) continue;
    const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((x) => resolve(ROOT, base! + x)).find((p) => existsSync(p) && !p.endsWith('/'));
    if (hit && /\.(ts|tsx)$/.test(hit)) out.push(hit.slice(ROOT.length + 1));
  }
  return out;
}
function closure(starts: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const g of staticImports(f)) stack.push(g);
  }
  return seen;
}

test('the studio is lazy-only — no first-paint closure (the app, the storefront) reaches it', () => {
  const first = closure(['src/main.tsx', 'src/App.tsx', 'src/pages/Storefront.tsx', 'src/pages/StorefrontProduct.tsx']);
  assert.ok(first.size > 20, 'the walker found the app');
  const leaked = [...first].filter((f) => f.startsWith(`${DIR}/`) || f.startsWith('src/lib/viewer/studio') || f.startsWith('src/lib/viewer/decals'));
  assert.deepEqual(leaked, [], 'nothing of the studio in a first-paint closure');
});

test('the studio loads the live model, the editors, the More sheet, the icon set and the taste functions after its first paint', () => {
  const own = closure([`${DIR}/Studio.tsx`]);
  const later = [
    'src/lib/viewer/studio.ts',
    'src/lib/viewer/mesh.ts',
    'src/lib/viewer/decals.ts',
    'src/lib/viewer/scene.ts',
    `${DIR}/LiveModel.tsx`,
    `${DIR}/live.ts`,
    `${DIR}/extras.tsx`,
    `${DIR}/MoreSheet.tsx`,
    `${DIR}/iconPaths.ts`,
    `${DIR}/strings.ar.ts`,
    `${DIR}/strings.en.ts`,
    `${DIR}/strings.ckb.ts`,
    'src/components/ui/Sheet.tsx',
    'worker/lib/qr.ts',
    'src/components/profile/qr.ts',
  ];
  for (const f of later) assert.ok(!own.has(f), `${f} is not a static import of the studio`);
  for (const taste of ['themes', 'suggest', 'summary']) assert.ok(!own.has(`packages/catalog/src/personalize/${taste}.ts`), `${taste}.ts is not in the studio's first paint`);
  // spec.ts is reached only through the engine's own `sizeOrder` (check/rules); the studio never names it.
  for (const f of FILES) assert.doesNotMatch(code(f), /personalize\/spec'/, `${f} imports spec.ts`);
  assert.ok(own.has('packages/catalog/src/personalize/check.ts') && own.has('packages/catalog/src/personalize/surface.ts'), 'the first-paint engine: check and surface');
  const studioSrc = code(`${DIR}/Studio.tsx`);
  assert.match(studioSrc, /lazy\(\(\) => import\('\.\/MoreSheet'\)\)/);
  assert.match(studioSrc, /lazy\(\(\) => import\('\.\/LiveModel'\)\)/);
  assert.match(studioSrc, /lazy\(\(\) => import\('\.\/extras'\)/);
  // One language's words at a time: the Personalize chunk carries none of the three files.
  assert.match(studioSrc, /use\(studioWords\(lang\)\)/);
  for (const l of ['ar', 'en', 'ckb']) assert.match(code(`${DIR}/strings.ts`), new RegExp(`import\\('\\./strings\\.${l}'\\)`), l);
  assert.match(code(`${DIR}/taste.ts`), /import\('\.\.\/\.\.\/\.\.\/packages\/catalog\/src\/personalize\/themes'\)/);
  // The SPA imports the engine by path (tests/store-isolation.test.ts: @levonis/* is type-only in src/).
  for (const f of FILES) assert.doesNotMatch(read(f), /from '@levonis\//, f);
  assert.match(code(`${DIR}/live.ts`), /import\('\.\.\/\.\.\/lib\/viewer\/studio'\)/);
  // normalizeConfig is the Worker's gate, never run per tap.
  for (const f of FILES) assert.doesNotMatch(code(f), /\bnormalizeConfig\b|\bnormalizeBlueprint\b|\bpublicSpecOf\b/, f);
});

// ------------------------------------------------------------------ the row

const ALL = Object.values(FIXTURES);
const community = { open: true, takes_requests: true };

test('the row is exactly what the engine compiled — tiles + one door, ≤ 5 for every blueprint, exactly 5 for the name stand', () => {
  for (const f of ALL) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const s = initState(f.pub);
      const d = derive(f.pub, s.config, s.assets, community);
      const out = html(
        createElement(ControlRow, {
          plan: d.plan,
          active: null,
          onTile: () => undefined,
          value: () => 'v',
          doorWould: 'add_to_cart',
          onDoor: () => undefined,
          t: studioStrings(lang),
          price: null,
          panelId: 'p',
        }),
        lang
      );
      const controls = [...out.matchAll(/data-control="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(controls, [...d.plan.tiles.map((x) => x.id), 'door'], `${f.name} ${lang}`);
      assert.ok(controls.length <= 5, `${f.name}: ≤ 5 row controls`);
      assert.equal((out.match(/data-door=/g) ?? []).length, 1, 'one door');
      if (f.tiles) assert.deepEqual(d.plan.tiles.map((x) => x.id), f.tiles, `${f.name}: the survey's archetype`);
    }
  }
  const a = initState(FIXTURES.nameStand.pub);
  assert.equal(derive(FIXTURES.nameStand.pub, a.config, {}, community).plan.tiles.length + 1, 5, 'archetype A = 5 row controls');
});

test('the door says what the engine decided — blocked stays in place, aria-disabled, named by its line', () => {
  const pub = FIXTURES.nameStand.pub;
  const s = initState(pub);
  const blocked = derive(pub, s.config, {}, community);
  assert.equal(blocked.plan.door.kind, 'disabled');
  const t = studioStrings('en');
  const props = { plan: blocked.plan, active: null, onTile: () => undefined, value: () => '', doorWould: 'add_to_cart' as const, onDoor: () => undefined, t, price: null, panelId: 'p', describedBy: 'line' };
  const off = html(createElement(ControlRow, props), 'en');
  assert.match(off, /data-door="disabled"[^>]*aria-disabled="true"[^>]*aria-describedby="line"/);
  assert.match(off, /Add to cart/);
  const ready = derive(pub, reduce(pub, s, { type: 'text', area: 'name', index: 0, raw: 'ALI' }).config, {}, community);
  const on = html(createElement(ControlRow, { ...props, plan: ready.plan, t: studioStrings('ar') }), 'ar');
  assert.match(on, /data-door="add_to_cart"/);
  assert.doesNotMatch(on, /aria-disabled/);
  assert.match(on, /أضف إلى السلة/);
  const lamp = FIXTURES.photoLamp.pub;
  const l = derive(lamp, initState(lamp).config, {}, community);
  assert.match(html(createElement(ControlRow, { ...props, plan: l.plan, doorWould: 'request', t: studioStrings('ckb') }), 'ckb'), /داوای چاپکردنی بکە/);
});

// ------------------------------------------------------------------ the markers

test('the simplified slot markers — glow, ring and badge declared, drawn only while the slot is filled', () => {
  assert.equal(SLOT_MARKERS.glow, 'glow');
  assert.equal(SLOT_MARKERS.ring, 'ring');
  assert.equal(SLOT_MARKERS.badge, 'badge');
  const anchor = { o: [0, -30, -40] as [number, number, number], n: [0, -1, 0] as [number, number, number], u: [0, 0, 1] as [number, number, number], w: 15, h: 15 };
  assert.equal(markerFor({ kind: 'magnet', show: { effect: 'ring', anchor } }), 'ring');
  assert.equal(markerFor({ kind: 'led', show: { effect: 'marker', anchor } }), 'glow');
  assert.equal(markerFor({ kind: 'magnet', show: { effect: 'marker', anchor } }), 'ring');
  assert.equal(markerFor({ kind: 'motor', show: { effect: 'marker', anchor } }), 'badge');
  assert.equal(markerFor({ kind: 'led', show: { effect: 'visible', part: 2 } }), null, 'a modelled part is shown, not a marker');
  const pub = FIXTURES.nameStand.pub;
  const rgb = () => [128, 128, 128];
  const empty = viewOf(pub, initState(pub).config, 3, rgb, {});
  assert.deepEqual(empty.markers, [], 'no marker while the magnet slot is empty');
  const filled = viewOf(pub, { ...initState(pub).config, slots: { magnet: { option: 'm15' } } }, 3, rgb, {});
  assert.deepEqual(filled.markers, [{ kind: 'ring', at: [0, -30, -40], n: [0, -1, 0], size: 15 }]);
  // The rotating display's light: a modelled part, visible only while lit.
  const disp = FIXTURES.rotatingDisplay.pub;
  const dark = viewOf(disp, { ...initState(disp).config, slots: { ...initState(disp).config.slots, lighting: { option: null } } }, 3, rgb, {});
  const lit = viewOf(disp, { ...initState(disp).config, slots: { ...initState(disp).config.slots, lighting: { option: 'rgb' } } }, 3, rgb, {});
  assert.equal(dark.visible[2], false);
  assert.equal(lit.visible[2], true);
  assert.deepEqual(lit.markers.map((m) => m.kind).sort(), ['badge', 'ring'], 'the motor badge and the magnet ring');
  assert.equal(FINISH_OF.silk, 'silk');
});

// ------------------------------------------------------------------ the state

test('the reducer keeps the configuration valid — the text rule, the letters, the colours, the variants, the options', () => {
  const pub = FIXTURES.nameStand.pub;
  let s = initState(pub);
  assert.equal(s.config.p, pub.product.id);
  assert.equal(s.config.variant, 'pv_m_classic', 'the recommended size in stock');
  // Emoji, bidi controls and diacritics are dropped; the letters stop at the area's max (12).
  s = reduce(pub, s, { type: 'text', area: 'name', index: 0, raw: 'A‮LI😀' });
  assert.deepEqual(s.config.texts.name.value, ['ALI']);
  s = reduce(pub, s, { type: 'text', area: 'name', index: 0, raw: 'ALEXANDRIA THE GREAT' });
  assert.equal(s.drafts.name[0], 'ALEXANDRIA T');
  assert.deepEqual(cleanTyping('عَلي', 12), { text: 'علي', dropped: true });
  assert.equal(cleanTyping('ئەڤین', 3).text, 'ئەڤ', 'Sorani letters count as letters');
  // A trailing space while typing is kept in the field and trimmed in the configuration.
  s = reduce(pub, s, { type: 'text', area: 'name', index: 0, raw: 'ALI ' });
  assert.equal(s.drafts.name[0], 'ALI ');
  assert.deepEqual(s.config.texts.name.value, ['ALI']);
  // A colour the part may not wear (not on the shelf / not in its list) is refused.
  assert.equal(reduce(pub, s, { type: 'colour', target: 'plate', key: 'red' }), s);
  s = reduce(pub, s, { type: 'colour', target: 'plate', key: 'gold' });
  assert.equal(s.config.colors.plate, 'gold');
  assert.equal(reduce(pub, s, { type: 'variant', variant: 'pv_x' }), s, 'an unknown variant');
  s = reduce(pub, s, { type: 'variant', variant: 'pv_l_classic' });
  assert.equal(s.config.variant, 'pv_l_classic');
  assert.equal(reduce(pub, s, { type: 'slot', slot: 'magnet', option: 'm99' }), s, 'an undeclared option');
  s = reduce(pub, s, { type: 'slot', slot: 'magnet', option: 'm15' });
  assert.equal(s.config.slots.magnet.option, 'm15');
  assert.equal(reduce(pub, s, { type: 'style', area: 'name', style: 'nope' as never }), s);
  // Undo: typing in one field is one step.
  const before = s.config;
  s = reduce(pub, s, { type: 'text', area: 'name', index: 0, raw: 'S' });
  s = reduce(pub, s, { type: 'text', area: 'name', index: 0, raw: 'SA' });
  s = reduce(pub, s, { type: 'undo' });
  assert.deepEqual(s.config, before);
  assert.deepEqual(s.drafts.name, ['ALI']);
  // Never a price in the configuration.
  assert.doesNotMatch(JSON.stringify(s.config), /price|iqd|total|fee|amount/i);
  // An outside configuration is carried over choice by choice.
  const carried = rebase(pub, { ...NAME_STAND_CONFIG, colors: { ...NAME_STAND_CONFIG.colors, body: 'pink' } });
  assert.deepEqual(carried.texts.name, { style: 'gaming', value: ['ALI'] });
  assert.equal(carried.colors.body, 'black', 'a colour off the shelf falls back to the default');
  assert.equal(carried.slots.magnet.option, 'm15');
});

test('QR and the tag: a target is kept as typed and set only in its canonical form', () => {
  const pub = FIXTURES.qrMenuStand.pub;
  // The editor (./extras.tsx) sends what was typed with the engine's canonical value; the reducer checks the kind.
  const put = (st: typeof s, area: string, kind: string, raw: string) =>
    reduce(pub, st, { type: 'target', area, kind, raw, value: normalizeTarget(kind as never, raw, area === 'nfc') });
  let s = initState(pub);
  s = put(s, 'qr', 'instagram', '@Levo.Prints');
  assert.deepEqual(s.config.qr.qr, { kind: 'instagram', value: 'levo.prints' });
  s = put(s, 'qr', 'instagram', 'no spaces allowed');
  assert.equal(s.config.qr.qr, undefined, 'an invalid handle is not set');
  assert.equal(s.targets.qr.raw, 'no spaces allowed', 'but the field keeps what was typed');
  assert.equal(put(s, 'qr', 'tiktok', 'x'), s, 'a kind the area does not offer');
  assert.equal(reduce(pub, s, { type: 'target', area: 'qr', kind: 'instagram', raw: 'x', value: 'x'.repeat(201) }).config.qr.qr, undefined, 'an overlong value is never set');
  s = put(s, 'nfc', 'website', 'levo.example');
  assert.deepEqual(s.config.nfc, { kind: 'website', value: 'https://levo.example/' });
  assert.match(code(`${DIR}/extras.tsx`), /value: normalizeTarget\(/, 'the editor sends the canonical value');
});

test('the derivation is synchronous and fast — < 2 ms a change over every fixture', () => {
  const times: number[] = [];
  for (const f of ALL) {
    let s = initState(f.pub);
    const name = f.pub.areas.find((a) => a.text);
    if (name) s = reduce(f.pub, s, { type: 'text', area: name.id, index: 0, raw: 'ALI' });
    for (let i = 0; i < 20; i++) derive(f.pub, s.config, s.assets, community);
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      derive(f.pub, s.config, s.assets, community);
      times.push(performance.now() - t0);
    }
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`derive: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms over ${times.length} changes`);
  assert.ok(median < 2, `median ${median} ms`);
});

// ------------------------------------------------------------------ the line

test('the verdict line — ready with a light word for an automatic fix, one priced tap for a suggestion, the editor for what is missing', () => {
  const pub = FIXTURES.nameStand.pub;
  const t = studioStrings('en');
  let s = initState(pub);
  let d = derive(pub, s.config, {}, community);
  let line = readyLine(pub, d.made, d.check.verdict, d.check.issues, d.blocking, t, 'en');
  assert.equal(line.text, 'Type the name to continue.');
  assert.deepEqual(line.action, { kind: 'open', label: t.fixIt, target: { id: 'text', ref: 'name' } });
  s = reduce(pub, s, { type: 'text', area: 'name', index: 0, raw: 'ALEXANDRIAAA' });
  s = reduce(pub, s, { type: 'variant', variant: 'pv_s_classic' });
  d = derive(pub, s.config, {}, community);
  line = readyLine(pub, d.made, d.check.verdict, d.check.issues, d.blocking, t, 'en');
  assert.equal(d.check.verdict, 'blocked');
  assert.equal(line.text, t.check.SIZE_UP_FOR_TEXT);
  assert.equal(line.action?.kind, 'apply');
  assert.equal(line.action?.label, 'Use Medium');
  assert.equal(line.action?.kind === 'apply' && line.action.delta, 3000, 'a priced fix is a tap that says its price');
  const ckb = readyLine(pub, d.made, d.check.verdict, d.check.issues, d.blocking, studioStrings('ckb'), 'ckb');
  assert.equal(ckb.action?.label, 'مامناوەند بەکاربهێنە');
  s = reduce(pub, s, { type: 'variant', variant: 'pv_m_classic' });
  d = derive(pub, s.config, {}, community);
  line = readyLine(pub, d.made, d.check.verdict, d.check.issues, d.blocking, t, 'en', { better: t.better });
  assert.match(line.text, /^Ready to print/);
  assert.equal(line.action?.kind, 'better');
  assert.equal(readyLine(pub, d.made, d.check.verdict, d.check.issues, d.blocking, t, 'en', { undo: true }).action?.kind, 'undo', 'Undo right after a one-tap change');
  // Every check code has a sentence through the line in every language, in the verdict its group gives.
  const other = { ...d.made, variant: 'pv_l_classic' };
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const code of CHECK_CODES) {
      const g = checkGroup(code);
      const i: CheckFinding = {
        code,
        path: code === 'CONTENT_MISSING' ? 'texts.name' : code === 'COMPONENT_OUT' ? 'slots.magnet' : 'colors.body',
        from: code === 'COMPONENT_OUT' ? 'm15' : 'navy',
        to: /SIZE|QR_ENLARGED|TOO_BIG|TEXT_FITTED/.test(code) ? 'ov_l' : 'black',
        say: 'fewer_colors',
        ...(g === 'fixed' ? { fix: { kind: 'auto' as const, delta_iqd: 0 } } : g === 'suggest' ? { fix: { kind: 'suggest' as const, delta_iqd: 3000, config: other } } : {}),
      };
      const verdict = g === 'fixed' ? 'adjusted' : g === 'review' ? 'review' : 'blocked';
      const out = readyLine(pub, d.made, verdict, [i], g === 'fixed' || g === 'review' ? undefined : i, studioStrings(lang), lang);
      assert.ok(out.text.length > 4 && !/\{\w+\}/.test(out.text), `${lang} ${code}: «${out.text}»`);
      if (g === 'fixed') assert.ok(out.text.startsWith(STUDIO_STRINGS[lang].ready), `${lang} ${code}: ready, and what was done`);
      if (g === 'suggest') assert.equal(out.action?.kind === 'apply' && out.action.delta, 3000, `${lang} ${code}: one priced tap`);
    }
  }
  assert.deepEqual(targetOf('slots.magnet'), { id: 'addons' });
  assert.deepEqual(targetOf('variant'), { id: 'size' });
  assert.equal(targetOf('rules.x'), null);
});

test('the size words — Small · Medium · Large, never a percentage', () => {
  assert.deepEqual([0, 1, 2].map((r) => sizeWordIndex(r, 3)), [1, 2, 3]);
  assert.deepEqual([0, 1].map((r) => sizeWordIndex(r, 2)), [1, 3]);
  assert.equal(sizeWordIndex(0, 6), -1);
  for (const lang of ['ar', 'en', 'ckb'] as const) for (const w of STUDIO_STRINGS[lang].sizes) assert.doesNotMatch(w, /%/);
});

test('the swatches — out not offered, a matched colour says what prints', () => {
  const pub = FIXTURES.nameStand.pub;
  const s = initState(pub);
  const silk = { ...s.config, variant: 'pv_m_silk' };
  const body = swatchesFor(pub, silk, 'body').map((x) => x.key);
  // The silk shelf: black, gold, silver in; blue stands in by navy; the rule limits the body to black/gold/silver/blue.
  assert.ok(!body.includes('white'), 'out = not offered');
  assert.ok(body.includes('black'));
  assert.match(colorsAttr(s.config), /^base:white,body:black,name:black,plate:white$/);
});

// ------------------------------------------------------------------ the look card

test('the look card — the id map survives its codec, a frame lands in its quad, the photo follows the chosen part colour', () => {
  const ids = new Uint8Array(64 * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) ids[y * 64 + x] = x < 10 ? 0 : x < 40 ? 1 : y < 16 ? 2 : 3;
  const b64 = encodeIdMap(ids, 64, 32);
  const back = decodeIdMap(b64)!;
  assert.equal(back.w, 64);
  assert.equal(back.h, 32);
  assert.deepEqual([...back.ids], [...ids]);
  assert.equal(decodeIdMap('bm9wZQ=='), null, 'not an id map');
  const long = new Uint8Array(300 * 300).fill(5);
  assert.deepEqual([...decodeIdMap(encodeIdMap(long, 300, 300))!.ids], [...long], 'runs past 127 (LEB128)');
  // Width = up × n: a front frame (n = −y, up = +z) reads along +x, as the studio's decals do.
  const f = { o: [0, -40, 20], n: [0, -1, 0], u: [0, 0, 1], w: 62, h: 18 };
  assert.deepEqual(frameWidthAxis(f).map((v) => Math.round(v * 1000) / 1000 + 0), [1, 0, 0]);
  assert.deepEqual(decalFrame(f as never).u.map((v) => Math.round(v * 1000) / 1000 + 0), [1, 0, 0]);
  // An orthographic camera looking down −y (x right, z up), 100 mm across.
  const m = [0.02, 0, 0, 0, 0, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 1];
  const q = frameQuad(f, m);
  const r = (p: readonly number[]) => p.map((v) => Math.round(v * 1000) / 1000);
  assert.deepEqual(q.map(r), [[0.19, 0.21], [0.81, 0.21], [0.81, 0.39], [0.19, 0.39]], 'top-left, top-right, bottom-right, bottom-left');
  const sign = FIXTURES.photoOnlySign.pub as PublicBlueprint;
  const photos = { ...sign, photos: sign.photos.map((p) => ({ ...p, url: p.media_id })) };
  const c = initState(photos).config;
  assert.equal(photoFor(photos, c)?.media_id, 'pm_wood', 'the default wood board');
  assert.equal(photoFor(photos, { ...c, colors: { ...c.colors, board: 'black', name: 'wood' as never } } as DesignConfig)?.media_id, 'pm_black', "a text's colour never picks the photo");
});

test('the icon set is lucide’s own — every engine icon key, path for path', async () => {
  const { ICON_KEYS } = await import('../packages/catalog/src/personalize/vocab');
  assert.deepEqual(Object.keys(ICON_PATHS).sort(), [...ICON_KEYS].sort());
  for (const k of ICON_KEYS) {
    const src = readFileSync(join(ROOT, 'node_modules/lucide-react/dist/esm/icons', `${k}.js`), 'utf8');
    const node = new Function(`return ${/const __iconNode = (\[[\s\S]*?\n\]);/.exec(src)![1]}`)() as Array<[string, Record<string, string>]>;
    assert.equal(ICON_PATHS[k].length, node.length, `${k}: one path per lucide element`);
    node.forEach(([tag, a], i) => {
      if (tag === 'path') assert.equal(ICON_PATHS[k][i], a.d, `${k}[${i}]`);
      else assert.match(ICON_PATHS[k][i], /^M[\d.-]+ [\d.-]+/, `${k}[${i}]: ${tag} as path data`);
    });
  }
});

// ------------------------------------------------------------------ the pins in the source

test('the stage and its hooks, in the source', () => {
  const studioSrc = code(`${DIR}/Studio.tsx`);
  for (const hook of ['data-studio', 'data-colors', 'data-config-hash', 'data-region']) assert.match(studioSrc, new RegExp(hook), hook);
  assert.match(code(`${DIR}/LiveModel.tsx`), /data-spin=/, 'the turntable hook sits on the live model');
  assert.match(code(`${DIR}/ControlRow.tsx`), /data-control=\{tile\.id\}[\s\S]*data-control="door"[\s\S]*data-door=\{plan\.door\.kind\}/);
  assert.match(code(`${DIR}/ReadyLine.tsx`), /role="status"[\s\S]*aria-live="polite"[\s\S]*data-verdict=\{verdict\}/);
  assert.match(code(`${DIR}/PriceLine.tsx`), /aria-live="polite" data-price-iqd=/);
  assert.match(code(`${DIR}/NamePanel.tsx`), /data-fit-lines=/);
  assert.match(code(`${DIR}/MoreSheet.tsx`), /data-sheet=[\s\S]*data-more-row=/);
  assert.match(studioSrc, /role="img" aria-label=\{sentence\}/, 'the canvas is an image with a sentence');
  assert.match(studioSrc, /get\('gl'\) === 'off'/);
  assert.match(studioSrc, /get\('dstream'\) === 'off'/);
  assert.match(studioSrc, /saveData/);
  assert.match(code(`${DIR}/MoreSheet.tsx`), /detents=\{\['medium', 'large'\]\}/, 'Sheet v2 with two detents');
  assert.match(code(`${DIR}/live.ts`), /webglcontextlost/);
  assert.match(studioSrc, /data-show-live/, '«Show the live preview» where it can help');
  // The door's words are the engine's decision: three words, one door.
  assert.match(code(`${DIR}/ControlRow.tsx`), /t\.door\[kind\]/);
});
