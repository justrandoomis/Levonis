/**
 * «اختر شكل متجرك» — THE TEMPLATES, SEEN BEFORE THEY ARE CHOSEN (review of
 * the store builder, 2026-09-28).
 *
 * The gallery draws each starter with the merchant's own rows (POST
 * /api/merchant/store/layout/preview — its server half is pinned in
 * tests/storeLayoutRoutes.test.ts «THE TEMPLATE GALLERY»), marks the one that
 * fits the store, and offers the whole page or its look only. Here: the
 * suggestion rule, and the wiring. The pages run in scripts/e2e-store-builder.mjs.
 *
 * Run: node --import tsx --test tests/templateGallery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recommendStarter } from '../src/components/merchant/storeDesign/templatePick';
import { emptyBlockData, type BlockData, type ShowcaseData } from '../packages/storeLayout/src/data';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const rows = (patch: Partial<BlockData>): BlockData => ({ ...emptyBlockData(), ...patch });
const n = <T,>(k: number, make: (i: number) => T) => Array.from({ length: k }, (_, i) => make(i));
const work = (i: number): ShowcaseData => ({ id: `w${i}`, kind: 'work', title: `Work ${i}`, details: '', imageUrl: null });

test('the suggestion follows what the store has', () => {
  const services = n(2, (i) => ({ id: `s${i}`, title: 's', description: '', kind: 'print_service', price_from_iqd: null, price_unit: '', materials: [], imageUrl: null }));
  assert.deepEqual(recommendStarter({ product_count: 2 }, { workshop: rows({ services: services as BlockData['services'] }) }), { theme: 'workshop', reason: 'workshop' });
  assert.deepEqual(recommendStarter({ product_count: 1 }, { portfolio: rows({ showcase: n(4, work) }) }), { theme: 'portfolio', reason: 'portfolio' });
  assert.deepEqual(recommendStarter({ product_count: 30 }, { workshop: rows({ services: services as BlockData['services'] }) }), { theme: 'product_focused', reason: 'products' }, 'a shop with many products is a shop first');
  const collections = n(3, (i) => ({ id: `c${i}`, name: 'c', name_ar: 'c', product_count: 2 }));
  assert.deepEqual(recommendStarter({ product_count: 6 }, { modern: rows({ collections }) }), { theme: 'modern', reason: 'collections' });
  assert.deepEqual(recommendStarter({ product_count: 3 }, {}), { theme: 'minimal', reason: 'start' });
  assert.deepEqual(recommendStarter({ product_count: 0 }, {}), { theme: 'classic', reason: 'start' }, 'nothing yet: the page customers know');
});

test('the gallery replaces the colour strips: first run and the template sheet', () => {
  const flows = code('src/components/merchant/storeDesign/flows.tsx');
  assert.doesNotMatch(flows, /function StarterGrid/, 'the colour-strip grid is gone');
  assert.match(flows, /<TemplateGallery store=\{store\} onChoose=\{\(t\) => onChoose\(t\)\} busy=\{busy\} canUseLook=\{false\} \/>/);
  assert.match(flows, /\{open && \(\s*<TemplateGallery/);
  const gallery = code('src/components/merchant/storeDesign/TemplateGallery.tsx');
  assert.match(gallery, /storeLayoutApi\s*\.previewLayout\(starterLayout\(t\)\)/, 'each starter is drawn with the store\'s own rows');
  assert.match(gallery, /<StoreRenderer store=\{store\} layout=\{layout\} data=\{data\} \/>/);
  assert.match(gallery, /data-sd-recommended/);
  assert.match(gallery, /onChoose\(looked\.theme, 'look'\)/);
  assert.match(gallery, /data-sd-starter=\{theme\}/, 'the e2e hook stays on «use this template»');
});

test('the look alone dresses the merchant\'s sections; a whole page asks before it replaces a draft', () => {
  const panel = code('src/components/merchant/storeDesign/StoreDesignPanel.tsx');
  assert.match(panel, /if \(use === 'look'\) \{\s*ed\.change\(setPreset\(layout, t\)\);/);
  assert.match(panel, /if \(!first && renderableBlocks\(layout\)\.length > 0\) \{\s*const ok = await confirm\(/);
  assert.match(panel, /\{confirmDialog\}/);
  assert.match(code('src/components/merchant/storeDesign/storeLayoutApi.ts'), /previewLayout: \(layout: StoreLayout\) =>\s*api\.post/);
  assert.match(code('worker/routes/storeLayout.ts'), /storeLayoutRoutes\.post\('\/preview', async \(c\) => \{\s*const ctx = await requireStoreOwner\(c\);\s*await rateLimit\(c, 'store-layout-preview', 240, 900\);/);
});
