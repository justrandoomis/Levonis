/**
 * «التخصيص» — THE BLUEPRINT BUILDER (Programme C, phase C1, lane L9;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 1, §B.2 items 1–5 and the look
 * card, §0 rows 5 and 39) — src/components/merchant/catalog/blueprint/**.
 *
 *   the words      every key in ar, en AND written Sorani, the same holes,
 *                  Sorani never the Arabic pasted across (≥ 90 % carry Kurdish
 *                  letters), no OWNER marker; one lazy table per language
 *   the craft      theme tokens only, no hex, no `dark:`, logical utilities,
 *                  no native dialog, no motion proxy (`Motion.*` from
 *                  motion/react-m under <MotionFeatures>, springs from
 *                  useMotion), refusals as sentences
 *   the weight     ProductEditorSheet mounts ONE lazy door (and the part door)
 *                  and only when /api/merchant/me says `can.customize`; the
 *                  builder is lazy behind the door; the engine's spec.ts is
 *                  imported only by the lazy builder; CatalogManager's
 *                  «من ليفونيس» is dark too
 *   the look card  the RLE id map round-trips through the studio's own reader
 *                  and stays ≤ 8 KB (256², stepping down when busy); the
 *                  poster steps down until ≤ 400 KB; quads from a known camera
 *                  agree with the studio's `frameQuad`
 *   the model      parts → regions, a tap → a frame the engine accepts, «أضف
 *                  مقاسات» as the product's own variant model, what a
 *                  blueprint cannot use is not offered (no size rule without a
 *                  size axis, no marker on a photo, no parts step on a
 *                  photo-only product, no size rows without a size group)
 *
 * Run: node --import tsx --test tests/blueprintBuilderUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { LanguageProvider } from '../src/LanguageContext';
import AR from '../src/components/merchant/catalog/blueprint/strings.ar';
import EN from '../src/components/merchant/catalog/blueprint/strings.en';
import CKB from '../src/components/merchant/catalog/blueprint/strings.ckb';
import {
  POSTER_LADDER, POSTER_MAX_BYTES, IDMAP_MAX_BYTES, bytesBase64, fitIdMap, fitPoster, idMapBytes, idsOf, quadOf, shrinkIds,
} from '../src/components/merchant/catalog/blueprint/capture';
import {
  SIZE_WORDS, afterNewModel, blankSpec, fill, fitsBed, frameAt, ifKinds, markerEffects, newArea, photoQuad, pruneValues, regionOfPart, regionsFrom, sayFor,
  setPartRole, sizeAxis, sizeRows, stepOf, stepsFor, suggestMax, thenKinds, toPhotoOnly, widthAxis, withSizeGroup, type CompiledPart,
} from '../src/components/merchant/catalog/blueprint/model';
import { decodeIdMap, frameQuad } from '../src/components/personalize/lookcard';
import { normalizeBlueprint } from '../packages/catalog/src/personalize/spec';
import type { BlueprintSpec, Frame } from '../packages/catalog/src/personalize/types';
import { FIXTURES } from './fixtures/personalizeBlueprints';

// The builder's components import the catalogue's swatch stylesheet through the editor; node has no CSS loader.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) {
         if (specifier.endsWith('.css')) return { url: 'data:text/javascript,', shortCircuit: true };
         return next(specifier, context);
       }`
    )
);

const DIR = 'src/components/merchant/catalog/blueprint';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments, so a rule in a comment never passes or fails a check. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const walk = (d: string): string[] =>
  readdirSync(join(ROOT, d)).flatMap((f) => (statSync(join(ROOT, d, f)).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`]));
const FILES = walk(DIR).filter((f) => /\.tsx?$/.test(f));
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;

// ------------------------------------------------------------------ words

test('every key in ar, en and written Sorani; the same holes; the Sorani is Sorani, never the Arabic or the English', () => {
  const keys = Object.keys(AR).sort();
  assert.deepEqual(Object.keys(EN).sort(), keys, 'en has the same keys');
  assert.deepEqual(Object.keys(CKB).sort(), keys, 'ckb has the same keys');
  let kurdish = 0;
  const holes = (t: string) => (t.match(/\{\w+\}/g) ?? []).sort();
  for (const k of keys) {
    const [ar, en, ckb] = [AR, EN, CKB].map((x) => (x as Record<string, string>)[k]);
    for (const v of [ar, en, ckb]) assert.ok(typeof v === 'string' && v.trim(), `${k} is written`);
    assert.notEqual(ckb, ar, `${k}: ckb is a copy of the Arabic`);
    assert.notEqual(ckb, en, `${k}: ckb is a copy of the English`);
    assert.deepEqual(holes(en), holes(ar), `${k}: en holes`);
    assert.deepEqual(holes(ckb), holes(ar), `${k}: ckb holes`);
    if (KURDISH.test(ckb)) kurdish++;
  }
  assert.ok(kurdish / keys.length >= 0.9, `${kurdish}/${keys.length} ckb values carry Kurdish letters`);
  for (const f of ['strings.ar.ts', 'strings.en.ts', 'strings.ckb.ts', 'strings.ts', 'BlueprintDoor.tsx']) assert.doesNotMatch(read(`${DIR}/${f}`), /OWNER: Sorani/);
  assert.equal(fill(EN.fileParts, { n: 3, dims: '150 × 100 × 120 mm' }), 'Your file has 3 parts · 150 × 100 × 120 mm');
  assert.equal(fill('{a} {b}', { a: 1 }), '1 {b}', 'an unfilled hole stays visible rather than vanishing');
});

test('one lazy word table per language: the door and the builder load only the merchant\'s own', () => {
  const s = code(`${DIR}/strings.ts`);
  for (const l of ['ar', 'en', 'ckb']) assert.match(s, new RegExp(`${l}: \\(\\) => import\\('\\./strings\\.${l}'\\)`));
  for (const f of FILES) {
    if (/strings\.(ar|en|ckb)\.ts$/.test(f)) continue;
    assert.doesNotMatch(code(f), /^import (?!type)[^;]*from '(?:\.\.\/|\.\/)strings\.(?:ar|en|ckb)'/m, `${f} imports a word table statically`);
  }
  assert.match(code(`${DIR}/BlueprintDoor.tsx`), /useWords\(lang\)/);
  assert.match(code(`${DIR}/Builder.tsx`), /useWords\(lang\)/);
  // The product's own names «أضف مقاسات» writes: Arabic and English, as every product name.
  assert.deepEqual(SIZE_WORDS.values.map((v) => v.name), ['Small', 'Medium', 'Large']);
});

// ------------------------------------------------------------------ craft

test('tokens only, logical utilities, no native dialog, no motion proxy; springs from useMotion under MotionFeatures', () => {
  const physical = /(?:^|[\s"'`{])(?:[a-z-]+:)*(?:pl|pr|ml|mr|left|right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)-[\w[\]/.-]+/;
  const rawColour = /(?:^|[\s"'`])(?:[a-z-]+:)*(?:text|bg|border|fill|stroke)-(?:zinc|gray|slate|neutral|stone|red|green|blue|amber|yellow|orange|purple|pink|sky|emerald|white|black)(?:-\d+)?(?:\/[\d.[\]]+)?(?=[\s"'`])/;
  for (const f of FILES) {
    const src = code(f);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${f} hard-codes a hex colour`);
    assert.doesNotMatch(src, /(?:^|[\s"'`{])(?:[a-z-]+:)*dark:[a-z-]/, `${f} uses the dark: variant`);
    assert.doesNotMatch(src, physical, `${f} uses a physical left/right utility`);
    assert.doesNotMatch(src, rawColour, `${f} uses a raw colour utility instead of a theme token`);
    assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\(|(?:^|[^.\w])(alert|confirm|prompt)\(['"`]/, `${f} uses a native dialog`);
    assert.doesNotMatch(src, /\bmotion\b(?!\/)[^\n]*from 'motion\/react'|useReducedMotion/, `${f} imports the motion proxy`);
    assert.doesNotMatch(src, /transition=\{\{\s*duration/, `${f} invents a duration`);
    assert.doesNotMatch(src, /e\.message|err\.message/, `${f} shows the server's raw sentence`);
    assert.doesNotMatch(src, /\btracking-|\buppercase\b/, `${f} spaces or uppercases Arabic`);
  }
  const b = code(`${DIR}/Builder.tsx`);
  assert.match(b, /import \* as Motion from 'motion\/react-m';/);
  assert.match(b, /const m = useMotion\(\)/);
  assert.match(b, /<MotionFeatures>/);
  assert.match(b, /transition=\{m\.spring\('ui'\)\}/);
  assert.match(b, /x: m\.travel\(m\.inline\(12\)\)/, 'a step slides forward in the reading direction, and not at all under reduced motion');
  // Refusals are sentences, loaded on the first one; confirmations are the kit's.
  for (const f of [`${DIR}/Builder.tsx`, `${DIR}/BlueprintDoor.tsx`]) assert.match(code(f), /await import\('(?:\.\.\/)+lib\/refusalStrings'\)|import\('(?:\.\.\/)+lib\/refusalStrings'\)/);
  assert.match(code(`${DIR}/BlueprintDoor.tsx`), /useConfirm\(\)/);
});

test('the stage reads its colours from the palette, and a colour pick is the swatch of its key', () => {
  const stage = code(`${DIR}/Stage.tsx`);
  assert.match(stage, /PALETTE_RGB/);
  assert.match(stage, /import\('\.\.\/\.\.\/\.\.\/\.\.\/lib\/viewer\/studio'\)/, 'the viewer is loaded lazily, never a static import');
  assert.doesNotMatch(stage, /^import (?!type)[^;]*lib\/viewer\//m, 'the stage imports the viewer statically');
  assert.match(code(`${DIR}/steps/Parts.tsx`), /className="lv-swatch text-\[22px\]" data-swatch=\{c\}/);
});

// ------------------------------------------------------------------ weight and the dark doors

test('the editor mounts ONE lazy customization door, and it and the part door only when /api/merchant/me says can.customize', () => {
  const sheet = code('src/components/merchant/catalog/ProductEditorSheet.tsx');
  assert.match(sheet, /const BlueprintDoor = lazy\(\(\) => import\('\.\/blueprint\/BlueprintDoor'\)\);/);
  assert.match(sheet, /import \{ useCanCustomize \} from '\.\/blueprint\/gate';/);
  assert.match(sheet, /const customize = useCanCustomize\(\);/);
  assert.match(sheet, /\{customize && \(\s*<Suspense fallback=\{null\}>\s*<PartDoor /, 'the part door is dark with the builder');
  assert.match(sheet, /\{customize && \(\s*<Suspense fallback=\{null\}>\s*<BlueprintDoor product=\{original\} dirty=\{dirty\} onReload=\{\(\) => setReload\(\(n\) => n \+ 1\)\} \/>/);
  // Nothing else from the builder's folder: no step, no engine, no word table in the editor's chunk.
  const imports = [...sheet.matchAll(/(?:import\(|from )'(\.\/blueprint\/[^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./blueprint/BlueprintDoor', './blueprint/gate']);
  const catalog = code('src/components/merchant/catalog/CatalogManager.tsx');
  assert.match(catalog, /const customize = useCanCustomize\(\);/);
  assert.match(catalog, /\.\.\.\(customize \? \[\{ id: 'from_levonis'/, '«من ليفونيس» is dark with the builder');
  assert.match(code(`${DIR}/gate.ts`), /\?\.me\.can as \{ customize\?: boolean \}[^\n]*\)\?\.customize === true/);
});

test('the builder is lazy behind the door; its later steps are chunks of their own; spec.ts rides only the lazy builder', () => {
  const door = code(`${DIR}/BlueprintDoor.tsx`);
  assert.match(door, /const Builder = lazy\(\(\) => import\('\.\/Builder'\)\);/);
  assert.doesNotMatch(door, /^import (?!type)[^;]*'\.\/(Builder|model|capture|Stage|api|steps\/[^']+)'/m, 'the door imports the builder statically');
  const builder = code(`${DIR}/Builder.tsx`);
  for (const s of ['Addons', 'Rules', 'Publish']) assert.match(builder, new RegExp(`const ${s} = lazy\\(\\(\\) => import\\('\\./steps/${s}'\\)\\);`));
  // No file outside the lazy builder imports the engine's normaliser (≈ 8 KB), and no file anywhere in src imports it statically but the builder.
  const all = walk('src').filter((f) => /\.tsx?$/.test(f));
  const specImporters = all.filter((f) => /personalize\/spec'/.test(code(f)));
  assert.deepEqual(specImporters, [`${DIR}/Builder.tsx`]);
  for (const f of [`${DIR}/BlueprintDoor.tsx`, `${DIR}/gate.ts`, `${DIR}/strings.ts`]) assert.doesNotMatch(code(f), /packages\/catalog\/src\/personalize\//, `${f} pulls the engine into the editor`);
  // The studio's preview is lazy too, and only the preview step asks for it.
  assert.match(code(`${DIR}/steps/Publish.tsx`), /const Studio = lazy\(\(\) => import\('\.\.\/\.\.\/\.\.\/\.\.\/personalize\/Studio'\)\);/);
  // The model files go up through the shared tile as the merchant's product_file — never a product_files row (P16).
  const source = code(`${DIR}/steps/Source.tsx`);
  assert.match(source, /<UploadTile\s+key=\{u\.id\}\s+file=\{u\.file\}\s+purpose="product_file"/);
  assert.doesNotMatch(source, /productFilesApi|\/files'\)/);
});

test('the door says off · draft · live (rev n) · paused from the builder\'s state', async () => {
  const { doorState } = await import('../src/components/merchant/catalog/blueprint/BlueprintDoor');
  const rev = (n: number) => ({ rev: n }) as never;
  assert.deepEqual(doorState({ draft: null, live: null, retired: [] }), { state: 'off', rev: null });
  assert.deepEqual(doorState({ draft: rev(1), live: null, retired: [] }), { state: 'draft', rev: 1 });
  assert.deepEqual(doorState({ draft: rev(4), live: rev(3), retired: [] }), { state: 'live', rev: 3 });
  assert.deepEqual(doorState({ draft: null, live: null, retired: [{ id: 'bp', rev: 3, published_at: null, retired_at: null }] }), { state: 'paused', rev: 3 });
  assert.match(AR.doorLive, /\{rev\}/);
});

// ------------------------------------------------------------------ the look card

/** An id map shaped like the fixture's stand seen from the front: a base, a body, a name plate, the rest empty. */
function standIds(n = 256): Uint8Array {
  const ids = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [u, v] = [x / n, y / n];
      let id = 0;
      if (v > 0.72 && v < 0.84 && u > 0.12 && u < 0.88) id = 2;
      else if (v > 0.2 && v <= 0.72 && u > 0.2 && u < 0.8) id = 1;
      if (v > 0.52 && v < 0.66 && u > 0.3 && u < 0.7) id = 3;
      ids[y * n + x] = id;
    }
  }
  return ids;
}

test('the RLE id map round-trips through the studio\'s own reader and stays within 8 KB at 256²', () => {
  const ids = standIds();
  const fit = fitIdMap(ids, 256);
  assert.ok(fit, 'the stand fits');
  assert.equal(fit!.size, 256);
  assert.ok(fit!.bytes <= IDMAP_MAX_BYTES, `${fit!.bytes} B`);
  const back = decodeIdMap(fit!.b64);
  assert.ok(back);
  assert.equal(back!.w, 256);
  assert.equal(back!.h, 256);
  assert.deepEqual([...back!.ids], [...ids], 'every pixel back');
  // Runs longer than 127 take LEB128 bytes; the reader agrees.
  const long = idMapBytes(new Uint8Array(40_000).fill(4), 200, 200);
  assert.deepEqual([...decodeIdMap(bytesBase64(long))!.ids.slice(0, 5)], [4, 4, 4, 4, 4]);
  // The red channel of an RGBA capture is the id.
  assert.deepEqual([...idsOf(Uint8Array.from([3, 9, 9, 255, 0, 1, 1, 0]), 1)], [3]);
});

test('a busy id map steps down (192², then 128²) and keeps its labels; beyond that, nothing is sent', () => {
  // Stripes 12 px wide: ≈ 22 runs a row — 11 KB at 256², 8.4 KB at 192², 5.6 KB at 128².
  const busy = new Uint8Array(256 * 256).map((_, i) => (Math.floor((i % 256) / 12) % 2) + 1);
  const fit = fitIdMap(busy, 256);
  assert.ok(fit && fit.size < 256 && fit.bytes <= IDMAP_MAX_BYTES, `stepped down to ${fit?.size}`);
  const small = shrinkIds(standIds(256), 256, 128);
  assert.deepEqual(new Set(small), new Set([0, 1, 2, 3]), 'nearest neighbour keeps every region, blends none');
  const noise = new Uint8Array(256 * 256).map((_, i) => (i * 7919) % 17);
  assert.equal(fitIdMap(noise, 256), null, 'a map that no size can carry is refused here, not by the server');
});

test('the poster steps down until it is within 400 KB; a 256² PNG always is', async () => {
  const sizes: string[] = [];
  const blob = (n: number) => new Blob([new Uint8Array(n)]);
  // PNG at 1024 is 900 KB, WebP 0.9 at 1024 is 520 KB, WebP 0.85 at 768 is 390 KB.
  const got = await fitPoster(async (size, type, q) => {
    sizes.push(`${size}:${type}:${q ?? ''}`);
    return blob(size === 1024 ? (type === 'image/png' ? 900_000 : 520_000) : 390_000);
  });
  assert.equal(got?.size, 768);
  assert.ok(got!.blob.size <= POSTER_MAX_BYTES);
  assert.deepEqual(sizes, ['1024:image/png:', '1024:image/webp:0.9', '768:image/webp:0.85']);
  // Whatever the browser does, every rung is tried and the last is a 256² PNG — 256² × 4 B raw is under the cap.
  assert.deepEqual(POSTER_LADDER[POSTER_LADDER.length - 1], [256, 'image/png']);
  assert.ok(256 * 256 * 4 < POSTER_MAX_BYTES);
  assert.equal(await fitPoster(async () => blob(POSTER_MAX_BYTES + 1)), null, 'nothing within the cap: nothing is sent');
  for (const [, , q] of POSTER_LADDER) assert.ok(q === undefined || (q > 0 && q <= 1));
});

test('quads from a known camera: an orthographic front view maps a front frame to its own rectangle, as the studio reads it', () => {
  // clip = (x/100, z/100, *, 1): the model's x across, its z up, the camera looking along +y.
  const m = [0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0, 1];
  const f: Frame = { o: [0, -40, 20], n: [0, -1, 0], u: [0, 0, 1], w: 60, h: 20 };
  const q = quadOf(f, m);
  // Width axis = up × n = +x: top-left is (−30, 30) → (0.35, 0.35).
  assert.deepEqual(q, [[0.35, 0.35], [0.65, 0.35], [0.65, 0.45], [0.35, 0.45]]);
  assert.deepEqual(widthAxis(f).map((x) => x + 0), [1, 0, 0]);
  // The studio's look card reads the same four corners in the same order.
  const theirs = frameQuad(f, m).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
  assert.deepEqual(q, theirs);
  // A corner off the poster is held at its edge (the server takes 0..1 only).
  const big = quadOf({ ...f, w: 400 }, m);
  assert.ok(big.flat().every((x) => x >= 0 && x <= 1));
});

// ------------------------------------------------------------------ the model

const PARTS: CompiledPart[] = [
  { n: 0, name: 'Base', triangles: 12, bbox_mm: [-75, -50, -60, 75, 50, -48], share: 0.41 },
  { n: 1, name: 'Body', triangles: 24, bbox_mm: [-60, -36, -48, 60, 40, 60], share: 0.55 },
  { n: 2, name: 'Name plate', triangles: 12, bbox_mm: [-42, -42, -40, 42, -36, -14], share: 0.04 },
];
const ROLES = [{ n: 0, role: 'base' }, { n: 1, role: 'body' }, { n: 2, role: 'name' }];
const OPTS = { partCount: 3, bboxMm: [150, 100, 120] as [number, number, number] };

test('parts → regions: one region per role from the file\'s names; a role change moves the part and its areas follow', () => {
  const spec = { ...blankSpec(), regions: regionsFrom(PARTS, ROLES) };
  assert.deepEqual(spec.regions.map((r) => [r.id, r.role, r.parts, r.tone]), [['body', 'body', [1], 'primary'], ['base', 'base', [0], 'secondary'], ['name', 'name', [2], 'text']]);
  assert.ok(normalizeBlueprint(spec, OPTS).ok, 'the suggested regions are a valid draft');
  // A name area on the plate; the plate becomes an accent: its region goes, the area follows it.
  const hit = frameAt([0, -42, -27], [0, -1, 0], 'text', 'name', PARTS[2].bbox_mm);
  const withArea = { ...spec, areas: [newArea(spec, 'text', 'name', 'name', { frame: hit })] };
  const moved = setPartRole(withArea, 2, 'accent');
  assert.equal(regionOfPart(moved, 2)?.role, 'accent');
  assert.equal(moved.regions.some((r) => r.id === 'name'), false);
  assert.equal(moved.areas[0].region, regionOfPart(moved, 2)?.id);
  assert.ok(normalizeBlueprint(moved, OPTS).ok);
  // Hidden = in no region (the publish strips it); fixed keeps one colour.
  const hidden = setPartRole(spec, 0, null);
  assert.equal(regionOfPart(hidden, 0), undefined);
  assert.deepEqual(setPartRole(spec, 0, 'fixed').regions.find((r) => r.role === 'fixed')?.paint.allowed, ['gray']);
});

test('a tap → a frame the engine accepts: on the surface, facing out, up is the model\'s up, sized from the part', () => {
  const front = frameAt([0, -42, -27], [0, -1, 0], 'text', 'name', PARTS[2].bbox_mm);
  assert.deepEqual(front.n, [0, -1, 0]);
  assert.deepEqual(front.u, [0, 0, 1]);
  assert.ok(front.w > front.h && front.w <= 84 * 0.7 + 0.5, `${front.w} × ${front.h}`);
  // A face looking up takes the model's depth as its up; n and u stay square.
  const top = frameAt([10, 5, 60], [0, 0, 1], 'qr', 'qr', PARTS[1].bbox_mm);
  assert.deepEqual(top.u, [0, 1, 0]);
  assert.equal(top.w, top.h);
  const tilted = frameAt([0, 0, 0], [0.3, -0.8, 0.2], 'logo', 'logo');
  assert.ok(Math.abs(tilted.n[0] * tilted.u[0] + tilted.n[1] * tilted.u[1] + tilted.n[2] * tilted.u[2]) < 1e-3);
  const spec = { ...blankSpec(), regions: regionsFrom(PARTS, ROLES) };
  const areas = [newArea(spec, 'text', 'name', 'name', { frame: front }), newArea({ ...spec, areas: [newArea(spec, 'text', 'name', 'name', { frame: front })] }, 'qr', 'text', 'body', { frame: top })];
  const r = normalizeBlueprint({ ...spec, areas }, OPTS);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  assert.equal(suggestMax(60, 4), 18);
  assert.equal(suggestMax(10, 8), 1);
});

test('«بالصور فقط»: one region with no part, the photos\' colours, areas on a photo — and back to the model', () => {
  const spec = { ...blankSpec(), regions: regionsFrom(PARTS, ROLES) };
  const withName = { ...spec, areas: [newArea(spec, 'text', 'name', 'name', { frame: frameAt([0, -42, -27], [0, -1, 0], 'text', 'name', PARTS[2].bbox_mm) })] };
  const photo = toPhotoOnly(withName, [{ media_id: 'pm_black', colour: 'black' }, { media_id: 'pm_wood', colour: 'wood' }]);
  assert.deepEqual(photo.regions.map((r) => [r.parts, r.paint.allowed, r.paint.default]), [[[], ['black', 'wood'], 'black']]);
  assert.equal(photo.areas[0].frame, undefined);
  assert.deepEqual(photo.areas[0].photo_frame, { media_id: 'pm_black', quad: photoQuad('text') });
  const r = normalizeBlueprint(photo, { mediaIds: ['pm_black', 'pm_wood'] });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  const again = afterNewModel(photo, PARTS, ROLES);
  assert.equal(again.areas.length, 0, 'a photo\'s area has no frame on the model: it is placed again');
  assert.ok(normalizeBlueprint({ ...again, photos: [] }, OPTS).ok);
});

test('«أضف مقاسات»: Small / Medium / Large as the product\'s own group — ×0.8 / ×1 / ×1.35 rounded to 250, new sizes at stock 0', () => {
  const simple = { option_groups: [], variants: [], variant_mode: 'simple' as const, price_iqd: 20_000, stock: 7, sku: 'ST-1' };
  const m = withSizeGroup(simple, SIZE_WORDS)!;
  assert.deepEqual(m.groups.map((g) => [g.name, g.name_ar, g.values.map((v) => v.name_ar)]), [['Size', 'المقاس', ['صغير', 'وسط', 'كبير']]]);
  assert.deepEqual(m.variants.map((v) => [v.price_iqd, v.stock, v.sku]), [[16_000, 0, ''], [null, 7, 'ST-1'], [27_000, 0, '']]);
  const looks = {
    option_groups: [{ id: 'og_look', name: 'Look', name_ar: 'المظهر', kind: 'choice' as const, values: [{ id: 'ov_c', name: 'Classic', name_ar: 'كلاسيكي', swatch: '' }, { id: 'ov_s', name: 'Silk', name_ar: 'حريري', swatch: '' }] }],
    variants: [
      { id: 'pv_c', value_ids: ['ov_c'], label: '', price_iqd: null, compare_at_iqd: null, stock: 3, sku: '', active: true, image_key: null, low_stock_threshold: null },
      { id: 'pv_s', value_ids: ['ov_s'], label: '', price_iqd: 23_100, compare_at_iqd: null, stock: 2, sku: '', active: true, image_key: null, low_stock_threshold: null },
    ],
    variant_mode: 'variants' as const, price_iqd: 20_000, stock: 0, sku: '',
  };
  const two = withSizeGroup(looks, SIZE_WORDS)!;
  assert.equal(two.groups.length, 2);
  assert.equal(two.groups[0].ref, 'og_look', 'the existing group keeps its id: the server keeps it');
  assert.deepEqual(two.variants.map((v) => v.values.length), [2, 2, 2, 2, 2, 2]);
  assert.deepEqual(two.variants.filter((v) => v.values[0] === 'ov_s').map((v) => v.price_iqd), [18_500, 23_100, 31_250]);
  const full = { ...looks, option_groups: [looks.option_groups[0], looks.option_groups[0], looks.option_groups[0]] };
  assert.equal(withSizeGroup(full, SIZE_WORDS), null, 'three groups is the product\'s limit');
  // The new group annotated at once: Medium recommended, dims from the model's.
  const axis = sizeAxis({ id: 'og_size', values: [{ id: 's' }, { id: 'm' }, { id: 'l' }] }, [150, 100, 120]);
  assert.deepEqual(Object.values(axis.values).map((v) => [v.scale, v.dims_mm, !!v.recommended]), [[0.8, [120, 80, 96], false], [1, [150, 100, 120], true], [1.35, [203, 135, 162], false]]);
  assert.ok(fitsBed([203, 135, 162], [256, 256, 256]) && !fitsBed([300, 10, 10], [256, 256, 256]) && fitsBed([10, 250, 10], [256, 256, 20]));
});

test('what a blueprint cannot use is not offered', async () => {
  // A photo-only product has no parts step and no marker on its add-ons.
  assert.deepEqual(stepsFor(true), ['source', 'areas', 'sizes', 'addons', 'rules', 'publish']);
  assert.deepEqual(stepsFor(false), ['source', 'parts', 'areas', 'sizes', 'addons', 'rules', 'publish']);
  assert.deepEqual(markerEffects(true), ['']);
  assert.deepEqual(markerEffects(false), ['', 'glow', 'ring', 'badge', 'visible']);
  // Rules: only what the spec has.
  const bare = { ...blankSpec(), regions: regionsFrom(PARTS, ROLES) };
  assert.deepEqual(ifKinds(bare), []);
  assert.deepEqual(thenKinds(bare), ['only_colors', 'max_colors'], 'no size rule without a size axis, no add-on rule without add-ons');
  const stand = FIXTURES.nameStand.spec;
  assert.deepEqual(ifKinds(stand), ['text', 'slot', 'value']);
  assert.deepEqual(thenKinds(stand), ['size_at_least', 'requires', 'excludes', 'only_colors', 'max_colors']);
  assert.equal(sayFor({ text: 'name', longer_than: 10 }, { size_at_least: 'ov_m' }), 'text_needs_size');
  assert.equal(sayFor({ slot: 'magnet', is: 'm15' }, { excludes: { slot: 'x', is: 'y' } }), 'addons_conflict');
  // Size rows only for the group annotated as the size axis.
  const groups = { option_groups: [{ id: 'og_size', name: 'Size', name_ar: 'المقاس', kind: 'choice' as const, values: [{ id: 'ov_s', name: 'S', name_ar: 'ص', swatch: '' }] }] };
  assert.equal(sizeRows(bare, groups), null);
  assert.deepEqual(sizeRows(stand, { option_groups: [{ ...groups.option_groups[0], values: [{ id: 'ov_s', name: 'S', name_ar: 'ص', swatch: '' }, { id: 'ov_m', name: 'M', name_ar: 'و', swatch: '' }, { id: 'ov_l', name: 'L', name_ar: 'ك', swatch: '' }] }] })?.map((r) => r.id), ['ov_s', 'ov_m', 'ov_l']);
  // An axis let go of: the rules and photos that named its values let go too.
  const pruned = pruneValues({ ...stand, axes: {} } as BlueprintSpec);
  assert.deepEqual(pruned.rules.map((r) => r.id), [], 'every rule of the stand named a size or a look value');
  assert.deepEqual(pruneValues(stand).rules.map((r) => r.id), stand.rules.map((r) => r.id), 'nothing goes while its axis stays');
  // The rendered steps: no size table and no rows without a size axis; the Sizes step offers «أضف مقاسات» instead.
  const { Sizes } = await import('../src/components/merchant/catalog/blueprint/steps/Sizes');
  const html = (spec: BlueprintSpec, groupsOf: typeof groups.option_groups) =>
    renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(Sizes, { k: kit(spec, groupsOf) }) }));
  const none = html(bare, []);
  assert.doesNotMatch(none, /data-size-rows/);
  assert.match(none, /data-add-sizes/);
  const withSize = html({ ...bare, axes: { size: sizeAxis({ id: 'og_size', values: [{ id: 'ov_s' }] }, [150, 100, 120]) } }, groups.option_groups);
  assert.match(withSize, /data-size-rows/);
  assert.doesNotMatch(withSize, /data-add-sizes/, 'a product with a size axis is not offered another');
  assert.doesNotMatch(withSize, /data-look-rows|data-tier-rows/, 'no look or quality rows without those axes');
});

test('a refusal\'s path leads to the step that edits it', () => {
  assert.equal(stepOf('regions.0.paint.default', false), 'parts');
  assert.equal(stepOf('regions', true), 'source');
  assert.equal(stepOf('areas.1.text.max', false), 'areas');
  assert.equal(stepOf('axes.size.values.ov_l.dims_mm', false), 'sizes');
  assert.equal(stepOf('slots.0.options.1.part', false), 'addons');
  assert.equal(stepOf('rules.2.then', false), 'rules');
  assert.equal(stepOf('photos.0.media_id', true), 'source');
  assert.equal(stepOf('mesh', false), 'source');
  assert.equal(stepOf('sell', false), 'publish');
});

test('the builder starts from the draft (or the live version, whose first save opens the next draft), else from the model\'s suggested parts', async () => {
  const { startOf, whereOf } = await import('../src/components/merchant/catalog/blueprint/Builder');
  const stand = FIXTURES.nameStand.spec;
  const rev = (n: number, spec: BlueprintSpec | null) => ({ rev: n, spec }) as never;
  const base = { product_id: 'p', retired: [], retired_more: false, mesh_state: 'ready' as const, parts: PARTS, warnings: [], suggestions: { roles: ROLES, grams: {} }, preview: null, limits: { max_triangles: 60000, max_blueprints_per_store: 200, source_files: 12 } };
  const fromLive = startOf({ ...base, draft: null, live: rev(3, stand) });
  assert.equal(fromLive.rev, 3, 'the first save names version 3: the server opens version 4 from it');
  assert.equal(fromLive.kind, 'model');
  assert.ok(fromLive.saved.length > 0, 'nothing is saved until the merchant changes something');
  const fresh = startOf({ ...base, draft: rev(1, null), live: null });
  assert.deepEqual(fresh.spec.regions.map((r) => r.role), ['body', 'base', 'name']);
  assert.equal(fresh.saved, '');
  const off = startOf({ ...base, mesh_state: 'none', parts: [], draft: null, live: null });
  assert.equal(off.kind, null);
  assert.equal(off.rev, null);
  assert.equal(whereOf('areas.1.text.max', EN), 'Area 2');
  assert.equal(whereOf('slots.0.qty', CKB), 'زیادەی 1');
});

/** A step's kit, as the builder hands it. */
function kit(spec: BlueprintSpec, groups: Array<{ id: string; name: string; name_ar: string; kind: 'choice'; values: Array<{ id: string; name: string; name_ar: string; swatch: string }> }>) {
  const noop = () => undefined;
  return {
    t: AR, lang: 'ar' as const, spec, edit: noop, adopt: noop,
    st: { product_id: 'p', draft: null, live: null, retired: [], retired_more: false, mesh_state: 'ready' as const, parts: PARTS, warnings: [], suggestions: { roles: ROLES, grams: {} }, preview: null, limits: { max_triangles: 60000, max_blueprints_per_store: 200, source_files: 12 } },
    product: { id: 'p', option_groups: groups, variants: [], variant_mode: groups.length ? 'variants' : 'simple', price_iqd: 20000, stock: 3, sku: '', media: [], name: 'Stand', name_ar: 'حامل' } as never,
    reloadProduct: async () => null, kind: 'model' as const, setKind: noop, issues: [], sel: {}, setSel: noop, pick: null, setPick: noop, dirty: false,
    names: {}, setNames: noop, refuse: noop, go: noop, dims: [150, 100, 120] as [number, number, number],
  };
}

test('no file outside the folder is touched beyond the two lines of each editor', () => {
  // The builder's own files are the ones listed in the handoff; a stray new file would be caught by the budget.
  const rel = FILES.map((f) => relative(DIR, f)).sort();
  assert.deepEqual(rel, [
    'BlueprintDoor.tsx', 'Builder.tsx', 'Stage.tsx', 'api.ts', 'capture.ts', 'gate.ts', 'kit.ts', 'model.ts',
    'steps/Addons.tsx', 'steps/Areas.tsx', 'steps/Parts.tsx', 'steps/Publish.tsx', 'steps/Rules.tsx', 'steps/Sizes.tsx', 'steps/Source.tsx',
    'strings.ar.ts', 'strings.ckb.ts', 'strings.en.ts', 'strings.ts',
  ]);
});
