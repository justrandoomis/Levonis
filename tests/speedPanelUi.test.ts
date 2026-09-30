/**
 * «سرعة متجري» ON THE SCREEN — the builder's «السرعة» tab (merchant P4, the
 * client half; docs/MERCHANT_PLATFORM_V2.md storefront §3.9 / §3.10, §4.5
 * S4–S7): src/components/merchant/storeDesign/speed/{SpeedPanel,
 * DistributionBar, WeightList}.tsx and the speed table of
 * src/components/merchant/storeDesign/strings.ts.
 *
 * What must not quietly come back:
 *   · every word in Arabic, English AND real Sorani, one key set, the same
 *     placeholders in all three, and a sentence for every closed key the
 *     server sends (finding codes, first-view labels, buckets);
 *   · under the server's 50 readings there is NO verdict and no tile — the
 *     EmptyState says how many came — while the weight audit still renders;
 *   · the verdict and each vital are a WORD in a StatusChip (word + tone),
 *     never a colour alone and never an interpolated percentile;
 *   · the weight rows: one per place, heaviest first, the fixed row last and
 *     without a door; each bar's inline width is its share of the heaviest;
 *   · the PSI link is its own tile, `target="_blank"` and `rel` noopener, and
 *     absent when the server has no https address to test;
 *   · «افتح القسم» calls the section selector with the block's id; a door to
 *     a section gone from the draft is not drawn, and says so;
 *   · the wiring: the panel is a lazy chunk of the builder, `?tab=speed`
 *     opens it, the store pages import the reporter only dynamically; tokens
 *     only, logical utilities, springs from the motion kit.
 *
 * Run: node --import tsx --test tests/speedPanelUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { RumSummary, SpeedFinding, SpeedReport, VitalsDay, WeightAudit } from '../src/components/merchant/storeDesign/speed/api';

// The language provider reads `levo_lang` from localStorage on mount; a stub
// lets each render pick its language the way the browser fixtures do.
let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const panel = await import('../src/components/merchant/storeDesign/speed/SpeedPanel');
const { SpeedView, slotDoor, findingDoor, findingGone, openDoor, canOpen, findingText, goodShareSeries, vitalHint, vitalFigure } = panel;
const { weightRows, barPercent, weightTotal, formatOf } = await import('../src/components/merchant/storeDesign/speed/WeightList');
const { bandShares } = await import('../src/components/merchant/storeDesign/speed/DistributionBar');
const { SPEED_STRINGS, fillSpeed } = await import('../src/components/merchant/storeDesign/strings');
const { SPEED_FINDING_CODES, FIRST_VIEW_LABELS } = await import('../src/components/merchant/storeDesign/speed/api');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }));
};
const count = (h: string, needle: string) => h.split(needle).length - 1;
const SPEED = 'src/components/merchant/storeDesign/speed';

// ------------------------------------------------------------------ fixtures

const zero = { good: 0, ok: 0, poor: 0 };
function day(d: string, lcp: [number, number, number], inp: [number, number, number] = [0, 0, 0]): VitalsDay {
  const c = ([good, ok, poor]: [number, number, number]) => ({ good, ok, poor });
  return { day: d, samples: lcp[0] + lcp[1] + lcp[2], lcp: c(lcp), inp: c(inp), cls: c(lcp), ttfb: c(lcp) };
}

const AUDIT: WeightAudit = {
  first_view: [
    { block_id: 'header', label_key: 'logo', key: 'u/owner/logo.webp', bytes: 40_000, mime: 'image/webp' },
    { block_id: 'hero', label_key: 'hero_image', key: 'u/owner/hero.gif', bytes: 6_500_000, mime: 'image/gif' },
    { block_id: 'products', label_key: 'product_image', key: 'u/owner/p1.jpg', bytes: 500_000, mime: 'image/jpeg', product_id: 'p1' },
    { block_id: 'products', label_key: 'product_image', key: 'u/owner/p2.jpg', bytes: 500_000, mime: 'image/jpeg', product_id: 'p2' },
    { block_id: 'products', label_key: 'product_image', key: 'u/owner/p3.jpg', bytes: 500_000, mime: 'image/jpeg', product_id: 'p3' },
    { block_id: 'products', label_key: 'product_image', key: 'u/owner/p4.jpg', bytes: 500_000, mime: 'image/jpeg', product_id: 'p4' },
    { block_id: 'old-gallery', label_key: 'block_image', key: 'u/owner/g1.png', bytes: null, mime: null },
  ],
  fixed: { app_kb: 226, font_kb: 31 },
  findings: [
    { code: 'HERO_GIF', block_id: 'hero', params: { bytes: 6_500_000 } },
    { code: 'HERO_HEAVY', block_id: 'hero', params: { bytes: 6_500_000, max_bytes: 1_572_864 } },
    { code: 'POSTER_MISSING', block_id: 'old-gallery', params: {} },
    { code: 'PRODUCT_IMAGES_LARGE', block_id: 'products', params: { avg_bytes: 500_000, count: 4, max_bytes: 409_600 } },
    { code: 'ABOVE_FOLD_BLOCKS', params: { count: 5, max: 3 } },
  ],
};

const COLLECTING: RumSummary = {
  device: 'phone',
  window_days: 28,
  from: '2026-09-03',
  min_samples: 50,
  samples: 12,
  days: [day('2026-09-29', [5, 2, 1]), day('2026-09-30', [3, 1, 0])],
  totals: { lcp: { good: 8, ok: 3, poor: 1 }, inp: zero, cls: { good: 8, ok: 3, poor: 1 }, ttfb: { good: 8, ok: 3, poor: 1 } },
  p75_bucket: { lcp: null, inp: null, cls: null, ttfb: null },
  mean_ms: { lcp: 3100, ttfb: 700 },
  verdict: 'collecting',
};

const MEASURED: RumSummary = {
  device: 'phone',
  window_days: 7,
  from: '2026-09-24',
  min_samples: 50,
  samples: 312,
  days: [day('2026-09-28', [60, 30, 10], [80, 10, 2]), day('2026-09-29', [70, 20, 10], [90, 5, 1]), day('2026-09-30', [50, 40, 22], [85, 10, 5])],
  totals: { lcp: { good: 180, ok: 90, poor: 42 }, inp: { good: 255, ok: 25, poor: 8 }, cls: { good: 300, ok: 10, poor: 2 }, ttfb: { good: 20, ok: 10, poor: 2 } },
  p75_bucket: { lcp: 'ok', inp: 'good', cls: 'good', ttfb: null },
  mean_ms: { lcp: 2934, ttfb: 640 },
  verdict: 'ok',
};

const report = (rum: RumSummary, psi: string | null = 'https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fraf3d.levonis-iq.com'): SpeedReport => ({
  generated_at: '2026-09-30T10:00:00.000Z',
  rum,
  weight: AUDIT,
  weight_source: 'published',
  psi_url: psi,
});

const BLOCKS = [
  { id: 'hero', type: 'hero' as const },
  { id: 'collections', type: 'collections' as const },
  { id: 'products', type: 'products_grid' as const },
];

function view(r: SpeedReport | null, over: Partial<Parameters<typeof SpeedView>[0]> = {}) {
  const calls: string[] = [];
  const props: Parameters<typeof SpeedView>[0] = {
    report: r,
    error: null,
    loading: false,
    onRetry: () => undefined,
    days: r?.rum.window_days === 7 ? 7 : 28,
    onDays: () => undefined,
    device: 'phone',
    onDevice: () => undefined,
    weight: r ? { audit: r.weight, source: r.weight_source } : null,
    source: null,
    blocks: BLOCKS,
    actions: {
      openBlock: (id) => calls.push(`block:${id}`),
      openPage: () => calls.push('page'),
      openSections: () => calls.push('sections'),
      openSettings: () => calls.push('settings'),
      openProducts: () => calls.push('products'),
    },
    ...over,
  };
  return { props, calls, el: createElement(SpeedView, props) };
}

// --------------------------------------------------------------------- words

test('every speed word exists in ar, en and real Sorani, with the same placeholders; every closed key has its words', () => {
  const flat = (o: unknown, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) Object.assign(out, flat(v, `${prefix}${k}.`));
    else out[prefix.replace(/\.$/, '')] = String(o);
    return out;
  };
  const ar = flat(SPEED_STRINGS.ar);
  const en = flat(SPEED_STRINGS.en);
  const ckb = flat(SPEED_STRINGS.ckb);
  const keys = Object.keys(ar);
  assert.ok(keys.length >= 70, `only ${keys.length} keys`);
  assert.deepEqual(Object.keys(en).sort(), keys.slice().sort(), 'en keys differ from ar');
  assert.deepEqual(Object.keys(ckb).sort(), keys.slice().sort(), 'ckb keys differ from ar');
  let same = 0;
  let kurdish = 0;
  const vars = (t: string) => (t.match(/\{\w+\}/g) ?? []).sort().join(',');
  for (const k of keys) {
    for (const [lang, table] of [['ar', ar], ['en', en], ['ckb', ckb]] as const) assert.ok(table[k].trim().length > 0, `${lang}.${k} is empty`);
    if (ckb[k] === ar[k]) same += 1;
    assert.notEqual(ckb[k], en[k], `ckb.${k} is the English`);
    if (/[ەۆێڕڵڤگچپژیک]/.test(ckb[k])) kurdish += 1;
    assert.equal(vars(en[k]), vars(ar[k]), `${k}: ar/en placeholders differ`);
    assert.equal(vars(ckb[k]), vars(ar[k]), `${k}: ar/ckb placeholders differ`);
  }
  assert.equal(same, 0, 'a Sorani string is the Arabic pasted across');
  assert.ok(kurdish / keys.length >= 0.9, `only ${kurdish} of ${keys.length} Sorani strings use a Kurdish letter`);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = SPEED_STRINGS[lang];
    for (const c of SPEED_FINDING_CODES) assert.ok(s.finding[c], `${lang}: no sentence for ${c}`);
    for (const l of FIRST_VIEW_LABELS) assert.ok(s.label[l], `${lang}: no label for ${l}`);
    for (const b of ['good', 'ok', 'poor'] as const) assert.ok(s.bucket[b], `${lang}: no word for ${b}`);
    assert.equal(Object.keys(s.finding).length, SPEED_FINDING_CODES.length, `${lang}: a finding sentence for a code the server never sends`);
    assert.equal(Object.keys(s.label).length, FIRST_VIEW_LABELS.length, `${lang}: a label for a slot the server never sends`);
  }
  // The three bucket words are three different words in every language.
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(new Set(Object.values(SPEED_STRINGS[lang].bucket)).size, 3, lang);
  assert.equal(fillSpeed('{n} زيارة · {period}', { n: 312, period: 'آخر 7 أيام' }), '312 زيارة · آخر 7 أيام');
  assert.equal(fillSpeed('a {missing} b', {}), 'a b', 'a missing value leaves no double space');
  // The builder's tab label is the table's, verbatim (the table arrives with the tab's chunk).
  const builder = code('src/components/merchant/storeDesign/StoreDesignPanel.tsx');
  assert.ok(builder.includes(`loc('${SPEED_STRINGS.ar.tab}', '${SPEED_STRINGS.en.tab}', '${SPEED_STRINGS.ckb.tab}')`), 'the «السرعة» tab label is not the table\'s');
});

// ----------------------------------------------------------- the empty state

test('under 50 readings: the EmptyState says how many came, no verdict and no tile are drawn — and the weight audit still renders', () => {
  const { el } = view(report(COLLECTING));
  const h = html(el);
  const s = SPEED_STRINGS.ar;
  assert.match(h, /data-speed-collecting/);
  assert.ok(h.includes(s.empty.title));
  assert.ok(h.includes(fillSpeed(s.empty.body, { min: '50', n: '12' })), 'the body names the threshold and what came in');
  assert.doesNotMatch(h, /data-speed-tiles|data-speed-verdict|data-speed-vital|data-speed-spread/, 'no word is claimed from 12 visits');
  assert.doesNotMatch(h, /data-status-chip/);
  // The audit needs no visitor.
  assert.match(h, /data-speed-weight/);
  assert.match(h, /data-weight-row="hero_image"/);
  assert.match(h, /data-weight-row="fixed"/);
  assert.match(h, /data-speed-finding="HERO_GIF"/);
  assert.match(h, /data-speed-honesty/);
  assert.ok(h.includes(s.honesty));
  // Still loading: skeletons, not an empty claim; failed: one ErrorState, no skeleton under it.
  const loading = html(view(null, { loading: true }).el);
  assert.match(loading, /data-sd-speed/);
  assert.doesNotMatch(loading, /data-speed-collecting|data-speed-weight=|data-speed-lab/);
  const failed = html(view(null, { error: Object.assign(new Error('x'), { code: 'NETWORK' }) }).el);
  assert.doesNotMatch(failed, /data-speed-weight|data-speed-hints/);
  assert.match(failed, /role="alert"|role="status"/);
});

// ------------------------------------------------------------ verdict words

test('the verdict and each vital are a WORD in a StatusChip, in every language; a vital under 50 readings has no word', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = SPEED_STRINGS[lang];
    const h = html(view(report(MEASURED)).el, lang);
    assert.match(h, /data-speed-tiles/);
    assert.match(h, new RegExp(`data-speed-verdict="ok"><span data-status-chip="warning"[^>]*>(?:<span[^>]*></span>)?<span class="min-w-0">${s.bucket.ok}</span>`), `${lang}: the verdict chip`);
    assert.match(h, new RegExp(`data-speed-vital="lcp" data-speed-word="ok"><span data-status-chip="warning"`), `${lang}: LCP`);
    assert.match(h, new RegExp(`data-speed-vital="inp" data-speed-word="good"><span data-status-chip="success"[^>]*>(?:<span[^>]*></span>)?<span class="min-w-0">${s.bucket.good}</span>`), `${lang}: INP`);
    assert.match(h, /data-speed-vital="cls" data-speed-word="good"/);
    assert.doesNotMatch(h, /data-speed-vital="ttfb"/, 'TTFB under 50 readings has no word');
    assert.ok(h.includes(s.collecting), `${lang}: the collecting word stands in for TTFB`);
    // The visits line, the window's mean as context, where «good» ends.
    assert.ok(h.includes(fillSpeed(s.visits, { n: '312', period: s.days.d7 })), `${lang}: the visits line`);
    assert.ok(h.includes(vitalHint(MEASURED, 'lcp', s)), `${lang}: the LCP hint`);
    // A percentile is never a number: no raw milliseconds anywhere.
    assert.doesNotMatch(h, /2934|2\.934/);
    assert.match(h, /data-speed-spread/);
    assert.equal(count(h, 'data-speed-band='), 3, 'three bands');
  }
  const s = SPEED_STRINGS.ar;
  assert.equal(vitalHint(MEASURED, 'lcp', s), 'المتوسط 2.9 ث · جيد حتى 2.5 ث');
  assert.equal(vitalHint(MEASURED, 'inp', SPEED_STRINGS.en), 'Good up to 200 ms');
  assert.equal(vitalHint(MEASURED, 'cls', SPEED_STRINGS.en), 'Good up to 0.1');
  assert.equal(vitalHint(MEASURED, 'ttfb', SPEED_STRINGS.en), SPEED_STRINGS.en.collecting);
  assert.equal(vitalFigure('ttfb', 800, SPEED_STRINGS.ckb), '0.8 چرکە');
  // The trend is the daily share of good readings, oldest first; a day without a reading of the vital is left out.
  assert.deepEqual(goodShareSeries(MEASURED.days, 'lcp'), [0.6, 0.7, 50 / 112]);
  assert.deepEqual(goodShareSeries([day('2026-09-30', [1, 0, 0])], 'inp'), []);
  // The poor verdict is the danger tone, with its word.
  const poor = html(view(report({ ...MEASURED, verdict: 'poor', p75_bucket: { ...MEASURED.p75_bucket, lcp: 'poor' } })).el, 'en');
  assert.match(poor, /data-speed-verdict="poor"><span data-status-chip="danger"[^>]*>(?:<span[^>]*><\/span>)?<span class="min-w-0">Poor<\/span>/);
});

test('the bands: whole shares that add up to 100, a word beside every bar, the bar\'s width the share', () => {
  assert.deepEqual(bandShares({ good: 1, ok: 1, poor: 1 }), { good: 34, ok: 33, poor: 33 });
  assert.deepEqual(bandShares({ good: 180, ok: 90, poor: 42 }), { good: 58, ok: 29, poor: 13 });
  assert.equal(bandShares(zero), null, 'no readings, no bands');
  const h = html(view(report(MEASURED)).el, 'en');
  for (const [band, word, pct] of [['good', 'Good', 58], ['ok', 'Fair', 29], ['poor', 'Poor', 13]] as const) {
    assert.match(h, new RegExp(`data-speed-band="${band}"[^>]*><span class="[^"]*text-(success|warning|danger)[^"]*">${word}</span><div role="img" aria-label="${word}: ${pct}% of visits"`), band);
    assert.match(h, new RegExp(`data-speed-band-fill="true" class="h-full rounded-full bg-gold" style="width:${pct}%`), `${band} width`);
  }
});

// ------------------------------------------------------------- the weight

test('the weight rows: one per place, heaviest first, the fixed row last; each bar\'s width is its share of the heaviest', () => {
  const rows = weightRows(AUDIT);
  assert.deepEqual(rows.map((r) => r.id), ['hero_image:hero', 'product_image:products', 'logo:header', 'block_image:old-gallery', 'fixed']);
  const products = rows[1];
  assert.equal(products.count, 4, 'the first product row is ONE row');
  assert.equal(products.bytes, 2_000_000);
  assert.equal(products.format, 'JPEG');
  assert.equal(rows[0].format, 'GIF');
  assert.equal(rows[3].bytes, null, 'an unmeasured file is not a zero');
  assert.equal(rows[4].bytes, (226 + 31) * 1024);
  assert.equal(weightTotal(rows), 6_500_000 + 2_000_000 + 40_000 + 257 * 1024);
  assert.equal(barPercent(6_500_000, 6_500_000), 100);
  assert.equal(barPercent(2_000_000, 6_500_000), 30.8);
  assert.equal(barPercent(40_000, 6_500_000), 2, 'a light file keeps a sliver');
  assert.equal(barPercent(null, 6_500_000), 0);
  assert.equal(formatOf('image/gif'), 'GIF');
  assert.equal(formatOf('application/zip'), null);

  const h = html(view(report(COLLECTING)).el);
  const order = [...h.matchAll(/data-weight-row="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['hero_image', 'product_image', 'logo', 'block_image', 'fixed']);
  const widths = [...h.matchAll(/data-weight-bar="true" class="h-full rounded-full (bg-gold|bg-text-muted)" style="width:([\d.]+)%"/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(widths, [['bg-gold', 100], ['bg-gold', 30.8], ['bg-gold', 2], ['bg-text-muted', 4]], 'the unmeasured row draws no bar; the fixed row is muted');
  assert.match(h, /6\.2 MB/, 'sizes as a merchant reads them');
  assert.match(h, /×4/);
  // The fixed row carries no door; the others open where they are changed.
  const fixedRow = /data-weight-row="fixed"[\s\S]*?<\/li>/.exec(h)![0];
  assert.doesNotMatch(fixedRow, /<button/);
  assert.match(h, /data-weight-row="hero_image"[\s\S]*?data-speed-open="block" data-speed-block="hero"/);
  assert.match(h, /data-weight-row="logo"[\s\S]*?data-speed-open="settings"/);
  const gone = /data-weight-row="block_image"[\s\S]*?<\/li>/.exec(h)![0];
  assert.doesNotMatch(gone, /<button/, 'a section gone from the draft has no door');
  // A store that never published: the weight of the page customers see now, said so.
  const fresh = html(view(report(COLLECTING), { weight: { audit: AUDIT, source: 'default' } }).el);
  assert.ok(fresh.includes(SPEED_STRINGS.ar.weight.defaultPage));
  // No picture at all: said in words, the fixed row still there.
  const bare = html(view(report(COLLECTING), { weight: { audit: { ...AUDIT, first_view: [], findings: [] }, source: 'published' } }).el);
  assert.ok(bare.includes(SPEED_STRINGS.ar.weight.none));
  assert.ok(bare.includes(SPEED_STRINGS.ar.hints.none));
  assert.match(bare, /data-weight-row="fixed"/);
  // Files the ledger could not weigh are never called light: no finding, and it says why.
  const unweighed = html(view(report(COLLECTING), { weight: { audit: { ...AUDIT, first_view: [AUDIT.first_view[6]], findings: [] }, source: 'published' } }).el);
  assert.ok(unweighed.includes(SPEED_STRINGS.ar.hints.unmeasured));
  assert.ok(!unweighed.includes(SPEED_STRINGS.ar.hints.none));
  assert.ok(unweighed.includes(SPEED_STRINGS.ar.weight.unmeasured));
  // The format and the count are isolates with the separators outside them (no «المتجرGIF»).
  assert.match(h, /data-weight-meta="true"> · <bdi dir="ltr" class="tabular-nums">GIF<\/bdi><\/span>/);
  assert.match(h, /> · <bdi dir="ltr" class="tabular-nums">JPEG<\/bdi> · <bdi dir="ltr" class="tabular-nums">×4<\/bdi>/);
});

test('the published | draft switch shows only while the draft differs, and the draft\'s weight loads under it', () => {
  const without = html(view(report(MEASURED)).el);
  assert.doesNotMatch(without, /data-segmented="sd-speed-source"/);
  const withSwitch = html(view(report(MEASURED), { source: 'draft', onSource: () => undefined, weight: null }).el);
  assert.match(withSwitch, /data-segmented="sd-speed-source"/);
  assert.match(withSwitch, /data-speed-source="draft"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-speed-source="draft"/);
  assert.doesNotMatch(withSwitch, /data-weight-row=/, 'the draft\'s rows are not the published ones');
});

test('figures that answer another window or device are dimmed and name their own window; a failed refresh keeps them, with its retry', () => {
  const s = SPEED_STRINGS.ar;
  // 28 days asked while the 7-day answer is still on screen.
  const h = html(view(report(MEASURED), { days: 28 }).el);
  assert.match(h, /data-speed-real="true" data-speed-stale="true" class="opacity-60 /);
  assert.ok(h.includes(fillSpeed(s.visits, { n: '312', period: s.days.d7 })), 'the visits line names the window the figures answer');
  assert.ok(!h.includes(fillSpeed(s.visits, { n: '312', period: s.days.d28 })), 'never the window that was only asked for');
  assert.doesNotMatch(h, /role="alert"/, 'a read on its way is not a failure');
  // A computer asked: the phone's figures are dimmed the same way.
  assert.match(html(view(report(MEASURED), { device: 'desktop' }).el), /data-speed-stale="true"/);
  // The read failed: the figures stay, dimmed, under one ErrorState with its retry.
  const failed = html(view(report(MEASURED), { days: 28, error: Object.assign(new Error('x'), { code: 'NETWORK' }) }).el);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /data-speed-tiles/);
  assert.ok(failed.indexOf('role="alert"') < failed.indexOf('data-speed-tiles'), 'the notice stands above the figures it concerns');
  assert.equal(count(failed, 'role="alert"'), 1);
  // Figures that answer what is asked are not dimmed.
  assert.doesNotMatch(html(view(report(MEASURED)).el), /data-speed-stale/);
  assert.doesNotMatch(html(view(report(COLLECTING)).el), /data-speed-stale/);
});

// ---------------------------------------------------------------- the hints

test('the hints: numbered sentences from the closed codes, numbers filled in; the door fits the finding', () => {
  const s = SPEED_STRINGS.ar;
  // A size is isolated left-to-right inside the sentence (LRI … PDI): in an Arabic or Sorani line «6.2 MB» never reads «MB 6.2».
  const LRI = '⁦';
  const PDI = '⁩';
  const plain = (t: string) => t.replace(/[⁦-⁩]/g, '');
  assert.equal(findingText(AUDIT.findings[0], s), fillSpeed(s.finding.HERO_GIF, { size: `${LRI}6.2 MB${PDI}` }));
  assert.ok(findingText(AUDIT.findings[1], SPEED_STRINGS.ckb).includes(`${LRI}6.2 MB${PDI}`) && findingText(AUDIT.findings[1], SPEED_STRINGS.ckb).includes(`${LRI}1.5 MB${PDI}`), 'both sizes isolated');
  assert.equal(findingText(AUDIT.findings[4], s).includes(LRI), false, 'a bare count needs no isolate');
  assert.equal(plain(findingText(AUDIT.findings[1], SPEED_STRINGS.en)), 'Your header picture is 6.2 MB, heavier than 1.5 MB — compress it or pick a lighter one.');
  assert.equal(plain(findingText(AUDIT.findings[3], SPEED_STRINGS.en)), 'The first row of product pictures is heavy: 488 KB on average, where up to 400 KB is fine — upload lighter pictures for these products.');
  assert.equal(findingText(AUDIT.findings[4], SPEED_STRINGS.en), 'Sections before the first product: 5 — keep 3 or fewer above it so what you sell shows sooner.');
  assert.equal(plain(findingText({ code: 'AUTOPLAY_VIDEO_COUNT', params: { count: 2, bytes: 38 * 1024 * 1024 } }, SPEED_STRINGS.en)), 'Videos that play on their own on the first screen: 2 (38 MB) — turn autoplay off or move them lower.');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const c of SPEED_FINDING_CODES) {
      const t = findingText({ code: c, params: { bytes: 1000, max_bytes: 2000, count: 2, avg_bytes: 500, max: 3 } }, SPEED_STRINGS[lang]);
      assert.ok(t.length > 10 && !/\{\w+\}/.test(t), `${lang}.${c}: «${t}» left a placeholder`);
    }
  }
  const h = html(view(report(MEASURED)).el);
  const listed = [...h.matchAll(/<li data-speed-finding="([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed, ['HERO_GIF', 'HERO_HEAVY', 'POSTER_MISSING', 'PRODUCT_IMAGES_LARGE', 'ABOVE_FOLD_BLOCKS'], 'in the server\'s order, heaviest first');
  assert.match(h, /<li data-speed-finding="HERO_GIF"[\s\S]*?<button type="button" aria-describedby="sd-speed-finding-0" data-speed-open="block" data-speed-block="hero"[^>]*>افتح القسم<\/button>/);
  assert.match(h, /<li data-speed-finding="PRODUCT_IMAGES_LARGE"[\s\S]*?data-speed-open="products"[^>]*>افتح المنتجات</);
  assert.match(h, /<li data-speed-finding="ABOVE_FOLD_BLOCKS"[\s\S]*?data-speed-open="sections"[^>]*>افتح الأقسام</);
  const gone = /<li data-speed-finding="POSTER_MISSING"[\s\S]*?<\/li>/.exec(h)![0];
  assert.doesNotMatch(gone, /<button/);
  assert.ok(gone.includes(s.hints.gone), 'a section gone from the draft is said, not silently dropped');
  // OK_IMAGES closes the list with a check, never a door.
  const fine = html(view(report(MEASURED), { weight: { audit: { ...AUDIT, findings: [{ code: 'OK_IMAGES', params: { bytes: 420_000, count: 3 } }] }, source: 'published' } }).el, 'en');
  assert.match(fine, /<p data-speed-finding="OK_IMAGES"/);
  assert.ok(fine.includes(`The first screen’s pictures are a sensible size: 3 (${LRI}410 KB${PDI}).`));
  assert.doesNotMatch(fine, /<ol/);
});

test('«افتح القسم» calls the section selector with the block\'s id; the other doors go where each thing is changed', () => {
  const ids = new Set(BLOCKS.map((b) => b.id));
  const f = (code: SpeedFinding['code'], block_id?: string): SpeedFinding => ({ code, ...(block_id ? { block_id } : {}), params: {} });
  const { calls, props } = view(report(MEASURED));
  const door = findingDoor(f('HERO_GIF', 'hero'), ids)!;
  assert.deepEqual(door, { kind: 'block', id: 'hero' });
  assert.equal(openDoor(door, props.actions), true, 'a door inside the builder brings its top into view');
  assert.deepEqual(calls, ['block:hero'], 'the selector got the block id');
  assert.equal(openDoor({ kind: 'page' }, props.actions), true);
  assert.equal(openDoor({ kind: 'sections' }, props.actions), true);
  assert.equal(openDoor({ kind: 'settings' }, props.actions), false, 'store settings is out of the builder');
  assert.equal(openDoor({ kind: 'products' }, props.actions), false);
  assert.deepEqual(calls, ['block:hero', 'page', 'sections', 'settings', 'products']);
  // Where each finding is fixed.
  assert.deepEqual(findingDoor(f('BACKGROUND_VIDEO_ON_PHONE', 'background'), ids), { kind: 'page' });
  assert.deepEqual(findingDoor(f('POSTER_MISSING', 'header'), ids), { kind: 'settings' });
  assert.deepEqual(findingDoor(f('PRODUCT_IMAGES_LARGE', 'products'), ids), { kind: 'products' });
  assert.deepEqual(findingDoor(f('ABOVE_FOLD_BLOCKS'), ids), { kind: 'sections' });
  assert.equal(findingDoor(f('OK_IMAGES'), ids), null);
  assert.equal(findingDoor(f('AUTOPLAY_VIDEO_COUNT'), ids), null, 'several videos: no one section to open');
  assert.equal(findingDoor(f('HERO_GIF', 'deleted-hero'), ids), null);
  assert.equal(findingGone(f('HERO_GIF', 'deleted-hero'), ids), true);
  assert.equal(findingGone(f('HERO_GIF', 'hero'), ids), false);
  assert.equal(findingGone(f('BACKGROUND_VIDEO_ON_PHONE', 'background'), ids), false);
  assert.deepEqual(slotDoor('header', ids), { kind: 'settings' });
  assert.equal(slotDoor(null, ids), null);
  // Without a workspace the doors out of the builder are not drawn.
  const bare = { openBlock: () => undefined, openPage: () => undefined, openSections: () => undefined };
  assert.equal(canOpen({ kind: 'settings' }, bare), false);
  assert.equal(canOpen({ kind: 'block', id: 'hero' }, bare), true);
  const h = html(view(report(MEASURED), { actions: bare }).el);
  assert.doesNotMatch(h, /data-speed-open="(settings|products)"/);
  assert.match(h, /data-speed-open="block" data-speed-block="hero"/);
  assert.match(h, /data-speed-open="block" data-speed-block="products"/, 'the product list\'s pictures open their section');
  // The button is what calls it.
  const src = code(`${SPEED}/SpeedPanel.tsx`);
  assert.match(src, /onClick=\{\(\) => go\(door\)\}/);
  assert.match(src, /if \(!openDoor\(door, p\.actions\)\) return;/);
  assert.match(code('src/components/merchant/storeDesign/StoreDesignPanel.tsx'), /openBlock: select,/, 'the door is the builder\'s own section selector');
});

// ------------------------------------------------------------------ the lab

test('the PSI link is its own tile: a new tab without an opener; no tile without an https address', () => {
  const h = html(view(report(MEASURED)).el);
  const tile = /<section aria-labelledby="sd-speed-lab" data-speed-lab[\s\S]*?<\/section>/.exec(h)?.[0] ?? '';
  assert.ok(tile, 'the lab tile');
  assert.match(tile, /<a href="https:\/\/pagespeed\.web\.dev\/analysis\?url=https%3A%2F%2Fraf3d\.levonis-iq\.com" target="_blank" rel="noopener noreferrer" data-speed-psi/);
  assert.ok(tile.includes(SPEED_STRINGS.ar.lab.title) && tile.includes(SPEED_STRINGS.ar.lab.open));
  assert.doesNotMatch(tile, /data-status-chip|data-speed-verdict/, 'the lab never mixes with the real-user figures');
  assert.ok(h.indexOf('data-speed-tiles') < h.indexOf('data-speed-lab'), 'the real visitors first, the lab after');
  assert.doesNotMatch(html(view(report(MEASURED, null)).el), /data-speed-lab|pagespeed\.web\.dev/);
});

// ------------------------------------------------------------------ wiring

test('the wiring: a lazy chunk of the builder, `?tab=speed` opens it, the store pages load the reporter only dynamically', () => {
  const builder = code('src/components/merchant/storeDesign/StoreDesignPanel.tsx');
  assert.match(builder, /const SpeedPanel = lazy\(\(\) => import\('\.\/speed\/SpeedPanel'\)\);/);
  assert.doesNotMatch(builder, /^import[^;]*from '\.\/speed\/SpeedPanel'/m, 'the speed panel is imported statically');
  // The speed table arrives with the tab: the builder never names it (other parts of strings.ts may be the builder's own).
  assert.doesNotMatch(builder, /^import[^;]*\b(?:SPEED_STRINGS|useSpeedStrings|fillSpeed)\b[^;]*from '\.\/strings'/m, 'the builder imports the speed table');
  assert.match(builder, /type Tab = 'sections' \| 'theme' \| 'page' \| 'history' \| 'speed';/);
  assert.match(builder, /const TABS: readonly Tab\[\] = \['sections', 'theme', 'page', 'history', 'speed'\];/);
  assert.match(builder, /useState<Tab>\(\(\) => \(typeof window === 'undefined' \? 'sections' : tabFromSearch\(window\.location\.search\)\)\)/);
  assert.match(builder, /\{ id: 'speed', label: loc\(/);
  assert.match(builder, /<Suspense[\s\S]*?<SpeedPanel/);
  // ONE copy of the scheduling for both store pages (review 2026-09-30: the same effect twice cost the 47 KB budget ~270 B twice).
  for (const page of ['src/pages/Storefront.tsx', 'src/pages/StorefrontProduct.tsx']) {
    const src = code(page);
    assert.match(src, /useEffect\(\(\) => scheduleStoreVitals\(storeId\), \[storeId\]\);/, `${page} does not load the reporter`);
    assert.doesNotMatch(src, /import\('\.\.\/lib\/storeVitals'\)/, `${page} carries its own copy of the scheduling`);
    assert.doesNotMatch(src, /^import[^;]*from '\.\.\/lib\/storeVitals'/m, `${page} imports the reporter statically`);
  }
  const beacon = code('src/lib/storeBeacon.ts');
  assert.match(beacon, /import\('\.\/storeVitals'\)\.then\(\(m\) => live && m\.startStoreVitals\(store\)/, 'the shared scheduler does not load the reporter');
  assert.doesNotMatch(beacon, /^import[^;]*from '\.\/storeVitals'/m, 'the beacon imports the reporter statically');
  assert.match(beacon, /requestIdleCallback/, 'the reporter loads before the browser is idle');
  assert.match(beacon, /saveData/, 'the reporter ignores Save-Data');
});

test('tokens only, logical utilities, springs from the motion kit, no native dialog, no raw server text', () => {
  const physical = /(?:^|[\s"'`{])(?:[a-z-]+:)*(?:pl|pr|ml|mr|left|right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)-[\w[\]/.-]+/;
  for (const f of ['SpeedPanel.tsx', 'DistributionBar.tsx', 'WeightList.tsx']) {
    const src = code(`${SPEED}/${f}`);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${f} hard-codes a hex colour`);
    assert.doesNotMatch(src, /(?:^|[\s"'`{])(?:[a-z-]+:)*dark:[a-z-]/, `${f} uses the dark: variant`);
    assert.doesNotMatch(src, physical, `${f} uses a physical left/right utility`);
    assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\(|(?:^|[^.\w])alert\(/, `${f} uses a native dialog`);
    assert.doesNotMatch(src, /transition=\{\{\s*duration/, `${f} invents a duration`);
    assert.doesNotMatch(src, /e\.message|err\.message/, `${f} shows the server's raw sentence`);
    assert.doesNotMatch(src, /tracking-|uppercase/, `${f} spaces or uppercases Arabic`);
    assert.doesNotMatch(src, /bg-white|text-white|bg-zinc|text-zinc|bg-black/, `${f} uses a raw palette colour`);
  }
  const bar = code(`${SPEED}/DistributionBar.tsx`);
  assert.match(bar, /const m = useMotion\(\);/);
  assert.match(bar, /transition=\{m\.spring\('ui'\)\}/);
  assert.match(bar, /initial=\{m\.reduced \? false : \{ scaleX: 0 \}\}/, 'reduced motion: the bar is simply there');
  assert.match(bar, /import \* as Motion from 'motion\/react-m';/);
  assert.match(bar, /<MotionFeatures>/);
});
