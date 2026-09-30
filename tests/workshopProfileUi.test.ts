/**
 * THE WORKSHOP PROFILE, BOTH SIDES (docs/COMMUNITY_ECOSYSTEM.md §9.5, Client
 * 5d): «ملف الورشة» in the merchant's store settings
 * (src/components/merchant/dashboard/StoreSettingsTab.tsx) and the workshop's
 * facts on the storefront (blocks/Hero.tsx → blocks/workshopFacts.tsx, blocks/Stats.tsx).
 *
 *   the words: every key in ar, en AND real Sorani (the settings table and
 *   the storefront's own, which rides its own small lazy chunk);
 *   the PUT: PUT /api/merchant/request-prefs keeps every key a body does not
 *   name (review 2026-09-30), so the payload carries the two fields this
 *   section owns, as edited, and NOTHING else — never a filter «as read»
 *   (a stale read could rewrite the row and lift the owner's pause), never
 *   the derived technologies / build, which the server recomputes;
 *   the render: the derived facts are text with doors, never a control; the
 *   doors keep the host's base; the storefront draws the facts only for a
 *   store whose read carries them, one line of chips whose figure is a
 *   left-to-right island, and the two figures on the stats block.
 *
 * Run: node --import tsx --test tests/workshopProfileUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { RequestPrefsV2 } from '../src/components/community/requests/api';

let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const settings = await import('../src/components/merchant/dashboard/StoreSettingsTab');
const { WorkshopProfileForm, workshopPayload, technologyLine, buildLine, workshopDoors, WORKSHOP_INTRO_MAX, TURNAROUND_MIN, TURNAROUND_MAX } = settings;
const { WORKSHOP_STRINGS } = await import('../src/components/merchant/dashboard/strings');
const { hostPath } = await import('../packages/contracts/src/merchantRoutes');
const { workshopOf, default: HeroBlock } = await import('../src/components/storefront/blocks/Hero');
const { WorkshopFacts } = await import('../src/components/storefront/blocks/workshopFacts');
const { WORKSHOP_WORDS, default: StatsBlock } = await import('../src/components/storefront/blocks/Stats');
const { StorefrontRuntimeProvider } = await import('../src/components/storefront/runtime');
const { previewRuntime } = await import('../src/components/storefront/preview');
const { normalizeLayout } = await import('../packages/storeLayout/src/normalize');
const { emptyBlockData } = await import('../packages/storeLayout/src/data');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;
const LRI = '⁦';
const PDI = '⁩';
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }));
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const attrs = (h: string, name: string) => [...h.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

const PREFS: RequestPrefsV2 = {
  processes: ['fdm'],
  materials: ['pla', 'petg'],
  colors: ['#000000'],
  capabilities: ['multicolor'],
  governorates: ['baghdad', 'erbil'],
  delivery: ['courier'],
  min_job_iqd: 10_000,
  max_job_iqd: null,
  min_size_mm: 0,
  max_size_mm: 250,
  workload: 'busy',
  paused: false,
  paused_until: '2026-10-05T00:00:00.000Z',
  turnaround_days: 4,
  workshop_intro: 'ورشة في بغداد',
  technologies: ['fdm', 'resin'],
  max_build_mm: { x: 256, y: 256, z: 300 },
};

const flat = (o: Record<string, unknown>, prefix = ''): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'function') out[`${prefix}${k}`] = String((v as (n: number | string) => string)(3));
    else if (v && typeof v === 'object') Object.assign(out, flat(v as Record<string, unknown>, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = String(v);
  }
  return out;
};

// ------------------------------------------------------------------ words

test('every word of «ملف الورشة» and of the storefront facts exists in ar, en and real Sorani', () => {
  for (const [name, table] of [
    ['settings', WORKSHOP_STRINGS],
    ['storefront', WORKSHOP_WORDS],
  ] as const) {
    const ar = flat(table.ar as unknown as Record<string, unknown>);
    const en = flat(table.en as unknown as Record<string, unknown>);
    const ckb = flat(table.ckb as unknown as Record<string, unknown>);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort(), `${name}: en carries every key`);
    assert.deepEqual(Object.keys(ckb).sort(), Object.keys(ar).sort(), `${name}: ckb carries every key`);
    for (const k of Object.keys(ar)) {
      assert.ok(ar[k].trim() && en[k].trim() && ckb[k].trim(), `${name}.${k} is empty somewhere`);
      assert.notEqual(en[k], ar[k], `${name}: en.${k} is the Arabic`);
      assert.notEqual(ckb[k], ar[k], `${name}: ckb.${k} is the Arabic pasted across`);
      assert.match(ckb[k], KURDISH, `${name}: ckb.${k} has no Sorani letter`);
    }
  }
  // Arabic counts agree with their number.
  const days = WORKSHOP_WORDS.ar.usually;
  assert.deepEqual([1, 2, 3, 10, 11, 30].map(days), ['عادةً خلال يوم', 'عادةً خلال يومين', 'عادةً خلال 3 أيام', 'عادةً خلال 10 أيام', 'عادةً خلال 11 يومًا', 'عادةً خلال 30 يومًا']);
  assert.equal(WORKSHOP_WORDS.en.usually(1), 'Usually within a day');
});

// ------------------------------------------------------------------ the PUT

test('the PUT carries the two workshop fields as edited and NOTHING else — never a filter as read, never the derived pair', () => {
  const body = workshopPayload(PREFS, { intro: '  ورشة   في\nبغداد  ', turnaround: 7 });
  // Review 2026-09-30: the server keeps every key a body does not name, so the section sends its own two
  // alone — sending the filters back «as read» rewrote the row from a read that could be stale.
  assert.deepEqual(Object.keys(body).sort(), ['turnaround_days', 'workshop_intro']);
  assert.equal(body.turnaround_days, 7);
  assert.equal(body.workshop_intro, 'ورشة في بغداد', 'whitespace collapsed, as the server keeps it');
  assert.equal(workshopPayload(PREFS, { intro: '', turnaround: null }).turnaround_days, null, 'an empty field is «not stated»');
  assert.equal(WORKSHOP_INTRO_MAX, 300);
  assert.deepEqual([TURNAROUND_MIN, TURNAROUND_MAX], [1, 60], 'the server\'s bounds (PREFS_TURNAROUND_INVALID)');
  // The server's rule, for EVERY column: a key the body leaves out keeps its stored value
  // (pinned end to end in tests/workshopFactsSeams.test.ts).
  const printersRoute = read('worker/routes/merchantPrinters.ts');
  assert.match(printersRoute, /\$\{col\} = CASE WHEN json_extract\(\?\$\{flag\}, '\$\.\$\{col\}'\) = 1 THEN excluded\.\$\{col\} ELSE merchant_request_prefs\.\$\{col\} END/);
});

// ------------------------------------------------------------------ the render

test('the derived facts are text with doors — never a control — and the doors keep the host\'s base', () => {
  const h = html(createElement(WorkshopProfileForm, { prefs: PREFS }));
  const derived = h.slice(h.indexOf('data-workshop-derived'), h.lastIndexOf('<', h.indexOf('data-workshop-save')));
  assert.doesNotMatch(derived, /<(input|textarea|select|button)\b/, 'nothing in the derived block can be edited');
  assert.equal((h.match(/<textarea\b/g) ?? []).length, 1, 'the intro');
  assert.equal((h.match(/<input\b/g) ?? []).length, 1, 'the turnaround');
  assert.match(h, /maxLength="300"/);
  assert.match(h, /data-workshop-intro="true"/);
  assert.match(h, /data-workshop-turnaround="true"/);
  const t = text(h);
  assert.ok(t.includes('FDM · ريزن'), 'the technologies in words');
  assert.ok(t.includes(`${LRI}256 × 256 × 300${PDI} مم`), 'the build, the figure a left-to-right island');
  assert.ok(t.includes('ورشة في بغداد'), 'the intro as read');
  assert.deepEqual(attrs(h, 'data-workshop-door'), ['printers', 'stock', 'prefs']);
  assert.deepEqual(attrs(h, 'href'), ['/merchant/printers', '/merchant/printers#stock', '/merchant/printers#preferences']);
  // On the store's own subdomain the workspace is under /admin.
  const own = html(createElement(WorkshopProfileForm, { prefs: PREFS, hrefFor: (p: string) => hostPath(p, true) }));
  assert.deepEqual(attrs(own, 'href'), ['/admin/printers', '/admin/printers#stock', '/admin/printers#preferences']);
  assert.deepEqual(workshopDoors().map((d) => d.id), ['printers', 'stock', 'prefs']);
  // A clean form has nothing to save.
  assert.match(h, /data-workshop-save="true"[^>]*disabled=""|disabled=""[^>]*data-workshop-save="true"/);
  // No printers yet: the facts say so instead of drawing nothing.
  const none = text(html(createElement(WorkshopProfileForm, { prefs: { ...PREFS, technologies: [], max_build_mm: {} } }), 'en'));
  assert.ok(none.includes('No active printers yet'));
  assert.equal(buildLine({ x: 256, y: 0, z: 300 }, WORKSHOP_STRINGS.en), '', 'a side unknown: no figure');
  assert.equal(technologyLine(['resin', 'fdm'], WORKSHOP_STRINGS.ckb), 'ڕەزین · FDM');
  const ckb = text(html(createElement(WorkshopProfileForm, { prefs: PREFS }), 'ckb'));
  assert.ok(ckb.includes('پرۆفایلی وۆرکشۆپ پاشەکەوت بکە') && ckb.includes('چاپکەرەکانم'));
});

test('the section is its own card after the form\'s save bar, reads and writes request-prefs, and never spends the shell\'s budget', () => {
  const src = read('src/components/merchant/dashboard/StoreSettingsTab.tsx');
  const mount = src.indexOf('<WorkshopProfileCard />');
  assert.ok(mount > src.indexOf('data-settings-savebar') && mount < src.indexOf('<ShareStore key={shareKey} />'), 'after the form\'s save, before the share kit — its own actions');
  assert.match(src, /offersV2Api\s*\.requestPrefs\(\)/);
  assert.match(src, /await offersV2Api\.saveRequestPrefs\(workshopPayload\(prefs, form\)\);/);
  assert.match(src, /code === 'PREFS_TURNAROUND_INVALID' \? 'turnaround' : code === 'PREFS_INTRO_TOO_LONG' \? 'intro'/, 'a refusal lands on its field');
  assert.doesNotMatch(read('src/components/merchant/counter/strings.ts'), /ملف الورشة/, 'the shell\'s table carries none of these words');
});

// ------------------------------------------------------------------ the storefront

const STORE = {
  id: 'st_1',
  slug: 'raf3d',
  url: 'https://raf3d.levonis-iq.com',
  name: 'ورشة رف',
  tagline: '',
  description: '',
  logoUrl: null,
  bannerUrl: null,
  accent: 'default',
  categories: [],
  governorate: 'baghdad',
  service_areas: [],
  contact_phone: null,
  business_hours: [],
  policies: {},
  social_links: {},
  profile_links: [],
  profile_facts: [],
  delivery_settings: {},
  accepts_custom_requests: true,
  sells_direct_products: true,
  open: true,
  status: 'active',
  merchant: { id: 'm_1', name: 'رف', verified: false, badge: 'new', rating: null, rating_count: 0, completed_orders: 3 },
  created_at: '2025-01-01T00:00:00.000Z',
  product_count: 4,
  followers: 12,
  positive_pct: null,
} as unknown as Parameters<typeof workshopOf>[0];
const WORKSHOP = { technologies: ['fdm', 'resin', 'sla'], materials: ['pla'], max_build_mm: { x: 256, y: 256, z: 300 }, turnaround_days: 3, governorates: [], delivery: [], custom_enabled: true, intro: '' };

test('the store read\'s workshop block is read defensively; a store without facts draws nothing', () => {
  assert.equal(workshopOf(STORE), null, 'no block, no row');
  assert.deepEqual(workshopOf({ ...STORE, workshop: WORKSHOP } as typeof STORE), { technologies: ['fdm', 'resin'], build: [256, 256, 300], turnaround: 3, custom: true });
  assert.equal(workshopOf({ ...STORE, workshop: { technologies: [], max_build_mm: {}, turnaround_days: null, custom_enabled: false } } as typeof STORE), null, 'nothing a visitor could use');
  assert.deepEqual(workshopOf({ ...STORE, workshop: { technologies: 'fdm', max_build_mm: { x: 200, y: 0, z: 100 }, turnaround_days: 99, custom_enabled: 'yes' } } as unknown as typeof STORE), null, 'a malformed block is not believed');
});

test('the hero holds the row\'s place only for a store with facts; the row is one line of chips with an isolated figure', () => {
  const layout = normalizeLayout({ schema_version: 1, blocks: [{ id: 'h', type: 'hero', variant: 'profile', settings: {} }] }, { ownerUserId: 'owner' }).layout;
  const hero = layout.blocks[0] as Parameters<typeof HeroBlock>[0]['block'];
  const render = (store: typeof STORE, node: (s: typeof STORE) => ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') =>
    html(createElement(StorefrontRuntimeProvider, { value: previewRuntime() }, node(store)), lang);
  const bare = render(STORE, (s) => createElement(HeroBlock, { block: hero, store: s, data: emptyBlockData() }));
  assert.doesNotMatch(bare, /class="h-7"/, 'no frame for a store without facts — nothing to wait for');
  const withFacts = render({ ...STORE, workshop: WORKSHOP } as typeof STORE, (s) => createElement(HeroBlock, { block: hero, store: s, data: emptyBlockData() }));
  assert.match(withFacts, /<div class="h-7" aria-hidden="true"><\/div>/, 'the row\'s own height is held while the chunk is on its way');

  const row = render({ ...STORE, workshop: WORKSHOP } as typeof STORE, (s) => createElement(WorkshopFacts, { workshop: workshopOf(s)! }));
  assert.match(row, /class="-mx-4 flex h-7 items-center gap-1\.5 overflow-x-auto px-4 hide-scrollbar"/, 'one line, the height the frame held, edge to edge');
  assert.deepEqual(attrs(row, 'data-store-workshop-fact'), ['custom', 'fdm', 'resin', 'build', 'turnaround']);
  const t = text(row);
  assert.ok(t.includes('يستقبل طلبات مخصصة') && t.includes('FDM') && t.includes('ريزن') && t.includes('عادةً خلال 3 أيام'));
  assert.ok(t.includes(`حتى ${LRI}256 × 256 × 300${PDI} مم`), 'the build runs left to right inside the Arabic sentence');
  assert.match(row, /aria-label="عن الورشة"/);
  const en = text(render({ ...STORE, workshop: WORKSHOP } as typeof STORE, (s) => createElement(WorkshopFacts, { workshop: workshopOf(s)! }), 'en'));
  assert.ok(en.includes('Takes custom requests') && en.includes('Resin') && en.includes(`Up to ${LRI}256 × 256 × 300${PDI} mm`) && en.includes('Usually within 3 days'));
  const ckb = text(render({ ...STORE, workshop: WORKSHOP } as typeof STORE, (s) => createElement(WorkshopFacts, { workshop: workshopOf(s)! }), 'ckb'));
  assert.ok(ckb.includes('داواکاری تایبەت وەردەگرێت') && ckb.includes('ڕەزین') && ckb.includes('بە زۆری لە ماوەی 3 ڕۆژدا'));
});

test('the stats block adds the workshop\'s two figures after the chosen metrics — only when the read carries them', () => {
  const layout = normalizeLayout({ schema_version: 1, blocks: [{ id: 's', type: 'stats', variant: 'row', settings: { metrics: ['products', 'followers'] } }] }, { ownerUserId: 'owner' }).layout;
  const block = layout.blocks[0] as Parameters<typeof StatsBlock>[0]['block'];
  const render = (store: typeof STORE) =>
    html(createElement(StorefrontRuntimeProvider, { value: previewRuntime() }, createElement(StatsBlock, { block, store, data: emptyBlockData() })));
  assert.deepEqual(attrs(render(STORE), 'data-stat'), ['products', 'followers']);
  const h = render({ ...STORE, workshop: WORKSHOP } as typeof STORE);
  assert.deepEqual(attrs(h, 'data-stat'), ['products', 'followers', 'turnaround', 'build']);
  const t = text(h);
  assert.ok(t.includes('256×256×300') && t.includes('أكبر حجم طباعة (مم)') && t.includes('أيام للتنفيذ عادةً'));
});

test('the facts ride their own small lazy chunk: the hero imports them lazily, the words never join the store closure', () => {
  const hero = read('src/components/storefront/blocks/Hero.tsx');
  assert.match(hero, /const WorkshopFacts = lazy\(\(\) => import\('\.\/workshopFacts'\)\.then\(\(m\) => \(\{ default: m\.WorkshopFacts \}\)\)\);/);
  assert.doesNotMatch(hero, /WORKSHOP_WORDS|from '\.\/Stats'|from '\.\/workshopFacts'/, 'the words are not a static import of the hero');
  assert.doesNotMatch(read('src/components/storefront/strings.ts'), /يستقبل طلبات مخصصة/, 'not in the table every store visit downloads');
  const facts = read('src/components/storefront/blocks/workshopFacts.tsx');
  assert.match(facts, /export function WorkshopFacts\(/);
  // Review 2026-09-30: a classic workshop store fetches this small module, never the 9 KB of non-classic blocks.
  assert.doesNotMatch(facts, /from '\.\/extra'|from '\.\/Stats'/, 'the facts chunk pulls in the non-classic blocks');
  assert.doesNotMatch(read('src/components/storefront/blocks/extra.tsx'), /WorkshopFacts/, 'the non-classic chunk carries the facts row');
});
