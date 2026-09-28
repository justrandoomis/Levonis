/**
 * THE STORE BUILDER'S FIRST-PRIORITY FIXES (review of the store builder,
 * 2026-09-28) — the rules as data, and the wiring pinned; the pages
 * themselves run in scripts/e2e-storefront-views.mjs and
 * scripts/e2e-store-builder.mjs.
 *
 *   S1   an address on a page with no tab strip gets its part as a page
 *   S2   the reviews block draws the variant picked; no «no reviews» on a
 *        live page
 *   S3   the profile hero draws the merchant's own button
 *   S4   a hero field the variant does not draw is not offered
 *   S5   the showcase follows the kinds' order
 *   S6   «add a section below» — the picker says where it goes
 *   S13  «older versions» survives a publish
 *   S14  the first-run template is saved, not the page before it
 *   S15  «keep mine» always saves (tests/storeDesignEditor.test.ts)
 *   S16  nothing to publish is «live as is», first open included
 *   S17  a failed save before publishing says why; cleaned refs are said
 *   S18  tabs without Products: a picked collection shows its products
 *
 * Run: node --import tsx --test tests/storefrontViews.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addressedView } from '../src/components/storefront/addressedView';
import { shownSettings } from '../src/components/merchant/storeDesign/BlockInspector';
import { makeBlock } from '../packages/storeLayout/src/normalize';
import { starterLayout, STARTER_THEMES } from '../packages/storeLayout/src/starters';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('S1: on a page with no tab strip, the address picks the part; with one, the strip does', () => {
  const plain = [{ type: 'hero' as const }, { type: 'products_grid' as const }];
  assert.equal(addressedView(plain, { section: '', initialTab: null }), null, 'the home page: the blocks');
  assert.equal(addressedView(plain, { section: '', initialTab: 'about' }), 'about');
  assert.equal(addressedView(plain, { section: '', initialTab: 'services' }), 'services');
  assert.equal(addressedView(plain, { section: 'sec1', initialTab: null }), 'products', 'a collection is its products');
  assert.equal(addressedView(plain, { section: 'sec1', initialTab: 'about' }), 'products');
  const tabs = [{ type: 'hero' as const }, { type: 'tabs' as const }];
  assert.equal(addressedView(tabs, { section: 'sec1', initialTab: 'about' }), null, 'the strip answers it itself');
  // Six of the seven starters have no strip: every one of their links needed this.
  const withoutTabs = STARTER_THEMES.filter((t) => !starterLayout(t).blocks.some((b) => b.type === 'tabs'));
  assert.equal(withoutTabs.length, 6);
  const renderer = code('src/components/storefront/StoreRenderer.tsx');
  assert.match(renderer, /const view = addressedView\(blocks, rt\);/);
  assert.match(renderer, /<StoreViewPage kind=\{view\} store=\{store\} data=\{data\} header=\{layout\.header\.variant\} \/>/);
  assert.match(renderer, /const StoreViewPage = lazy\(\(\) => import\('\.\/StoreViewPage'\)\);/, 'the part-page is its own lazy chunk');
});

test('S2/S3/S5/S18: variants, the profile hero\'s button, the kinds\' order, tabs without Products', () => {
  const reviews = code('src/components/storefront/blocks/Reviews.tsx');
  assert.match(reviews, /variant=\{block\.variant === 'cards' \? 'cards' : 'list'\}/);
  assert.match(reviews, /data-reviews-variant="cards"/);
  assert.match(reviews, /if \(rows && !rows\.count && rt\.mode === 'live'\) return null;/, 'no «لا توجد تقييمات» on a live page');
  const hero = code('src/components/storefront/blocks/Hero.tsx');
  assert.match(hero, /<HeroCta block=\{block\} data=\{data\} className="mb-4 w-full" \/>/);
  const showcase = code('src/components/storefront/blocks/Showcase.tsx');
  assert.match(showcase, /\.sort\(\(a, b\) => kinds\.indexOf\(a\.kind\) - kinds\.indexOf\(b\.kind\)\)/);
  assert.match(showcase, /kinds\.indexOf\(a\.r\.kind\) - kinds\.indexOf\(b\.r\.kind\) \|\| a\.i - b\.i/);
  const tabs = code('src/components/storefront/blocks/Tabs.tsx');
  assert.match(tabs, /current === 'collections' && sectionFilter && !wants\('products'\)/);
  assert.match(tabs, /if \(wants\('products'\)\) setTab\('products'\);/);
});

test('S4: the inspector offers only what the chosen hero variant draws', () => {
  const names = (variant: string) => shownSettings(makeBlock('hero', 'h', { variant })).map(([k]) => k);
  assert.ok(!names('minimal').includes('image'), 'the minimal hero has no picture');
  assert.ok(names('minimal').includes('align'));
  assert.ok(!names('split').includes('align'), 'the split hero always sets its words beside the picture');
  assert.ok(names('split').includes('image'));
  assert.ok(names('cover').includes('align') && names('cover').includes('image'));
  assert.ok(!names('profile').includes('align') && names('profile').includes('show_cover'));
  // The button fields are drawn by every variant now, the profile hero included.
  for (const v of ['profile', 'cover', 'split', 'minimal']) assert.ok(names(v).includes('cta_label') && names(v).includes('cta_link'), v);
});

test('S6/S13/S14/S16/S17: the builder\'s wiring', () => {
  const panel = code('src/components/merchant/storeDesign/StoreDesignPanel.tsx');
  assert.match(panel, /onAddAfter=\{\(id\) => openPicker\(id\)\}/);
  assert.match(panel, /position=\{position\}/);
  assert.doesNotMatch(panel, /const at = selected \?/, 'the insert point is the row asked, not a selection the add button never has');
  assert.match(panel, /const ok = await ed\.changeAndSave\(starterLayout\(t\)\);/);
  assert.match(panel, /const nothingToPublish = !!changes\?\.none;/);
  assert.match(panel, /onMore=\{ed\.revCursor !== null \? \(\) => ed\.loadMoreRevisions\(\) : null\}/);
  assert.match(panel, /r\.issues\.some\(\(i\) => i\.code === 'unknown_ref' \|\| i\.code === 'media_not_found'\)/);
  const hook = code('src/components/merchant/storeDesign/useLayoutEditor.ts');
  assert.equal((hook.match(/adoptServer\(s\);/g) ?? []).length, 5, 'every fresh GET resets the paging cursor');
  assert.equal((hook.match(/\bsetServer\(s\);/g) ?? []).length, 1, 'only adoptServer takes a fresh answer in');
  assert.match(hook, /st\?\.errorCode \|\| 'DRAFT_SAVE_FAILED'/);
  assert.match(code('src/components/merchant/storeDesign/refusal.ts'), /case 'DRAFT_SAVE_FAILED':/);
  const list = code('src/components/merchant/storeDesign/BlockList.tsx');
  assert.match(list, /id: 'add-after'/);
  assert.doesNotMatch(code('src/components/merchant/storeDesign/BlockPicker.tsx'), /يُضاف بعد القسم المحدد، أو في آخر الصفحة/);
});

test('S7: the colour chips draw the storefront\'s own colours in a store island', () => {
  const sample = code('src/components/merchant/AccentSample.tsx');
  assert.match(sample, /data-store-theme=""/);
  assert.match(sample, /ACCENTS\[accent\] \?\? ACCENTS\.default/);
  assert.match(code('src/components/merchant/storeDesign/panels.tsx'), /<AccentSample accent=/);
  assert.match(code('src/components/merchant/dashboard/StoreSettingsTab.tsx'), /import \{ AccentSample \} from '\.\.\/AccentSample';/);
});
