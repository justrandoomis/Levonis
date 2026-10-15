/**
 * THE PAYLOAD ALLOW-LIST (Bambu import spec §C.10 layer 2, §A.4 step 1) AND
 * THE PUBLIC FINGERPRINT (§I.1.2).
 *
 * assertImportPayload is the same code in the runner and the Worker. It
 * refuses, with IMPORT_PAYLOAD_KEY_REFUSED and the JSON path:
 *   - any key the closed schema does not name, at any depth;
 *   - any key matching the money / stock / supplier / freight pattern, anywhere;
 *   - any customer-facing string the classifier labels money, promotion, US
 *     shipping policy or warranty (owner-only rows may carry a withheld
 *     warranty sentence, never money).
 * Every FINANCIAL_FIELDS key and every source "do not import" key, injected
 * at every object depth of real payloads, is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertImportPayload,
  buildImportPayload,
  FORBIDDEN_KEY,
  ImportPayloadRefused,
  schemaKeys,
  type ImportPayload,
} from '../packages/catalog/src/bambuImport/payload';
import {
  extractionFingerprint,
  projectionFingerprint,
  projectionFromPayload,
  projectionFromSite,
  type KnowledgeAnswer,
  type MediaResult,
  type SiteRelations,
} from '../packages/catalog/src/bambuImport/fingerprint';
import type { Extraction } from '../packages/catalog/src/bambuImport/extract';
import { FINANCIAL_FIELDS } from '../packages/platform-kit/src/scope';
import { page, sample, SAMPLE_HANDLES } from './fixtures/bambu/load';

const SOURCE_DO_NOT_IMPORT = [
  'price', 'discountPrice', 'discountOffText', 'gradientDiscountSkus', 'flashSaleVO', 'priceExplanation', 'pointsInfo', 'minimum', 'maximum',
  'quantityLimitType', 'quantityLimitValue', 'productSkuPreSale', 'productSkuBuyAndGetVO', 'trackingQuantity', 'availableStock',
  'stock', 'low_stock_threshold', 'reserved', 'prices', 'cost', 'package_weight_g', 'package_length_mm', 'net_weight_g', 'cbm', 'freight_usd',
  'supplier_id', 'lot_id', 'currency', 'msrp', 'coupon', 'wallet_credit', 'margin', 'profit', 'quantity', 'qty_available', 'landing_cost', 'fifo_layer',
];

function build(x: Extraction): ImportPayload {
  return buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), targets: null, retrievedAt: '2026-10-15T00:00:00Z' }).payload;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function refusal(p: unknown): ImportPayloadRefused | null {
  try {
    assertImportPayload(p);
    return null;
  } catch (e) {
    if (e instanceof ImportPayloadRefused) return e;
    throw e;
  }
}

/** Every object position of a payload, as a JSON path and the object itself. */
function objectsOf(v: unknown, path = '$', out: Array<[string, Record<string, unknown>]> = []): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(v)) v.slice(0, 1).forEach((x, i) => objectsOf(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    out.push([path, v as Record<string, unknown>]);
    for (const [k, x] of Object.entries(v)) objectsOf(x, `${path}.${k}`, out);
  }
  return out;
}

test('every fixture builds a payload the validator accepts, from defaults only', () => {
  for (const h of SAMPLE_HANDLES) {
    const p = clone(build(sample(h)));
    assert.equal(refusal(p), null, h);
    const json = JSON.stringify(p);
    assert.ok(!/"(price|stock|cost|discount)[a-z_]*"\s*:/i.test(json), `${h}: a money or stock key`);
  }
  const fromPage = clone(build(page().extraction));
  assert.equal(refusal(fromPage), null);
  assert.ok(!JSON.stringify(fromPage).includes('PLANTED-'), 'a planted value reached the payload');
});

test('the closed schema names no forbidden key and no FINANCIAL_FIELDS key', () => {
  const keys = schemaKeys();
  assert.ok(keys.size > 80);
  for (const k of keys) assert.ok(!FORBIDDEN_KEY.test(k), `schema key ${k} matches the forbidden pattern`);
  for (const f of FINANCIAL_FIELDS) assert.ok(!keys.has(f), `schema key ${f} is a financial field`);
});

test('fuzz: every financial and do-not-import key, at every object depth of real payloads, is refused with its path', () => {
  const payloads = ['a1', 'pla-basic-filament', 'bambu-textured-pei-plate'].map((h) => clone(build(sample(h as never))));
  const keys = [...new Set([...FINANCIAL_FIELDS, ...SOURCE_DO_NOT_IMPORT])];
  let checked = 0;
  for (const p of payloads) {
    for (const [path, obj] of objectsOf(p)) {
      for (const k of keys) {
        obj[k] = 0;
        const r = refusal(p);
        delete obj[k];
        assert.ok(r, `${k} at ${path} was accepted`);
        assert.equal(r!.code, 'IMPORT_PAYLOAD_KEY_REFUSED');
        assert.equal(r!.path, `${path}.${k}`);
        assert.equal(r!.reason, FORBIDDEN_KEY.test(k) ? 'forbidden_key' : 'unknown_key', `${k} at ${path}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 1000, `fuzzed ${checked}`);
  // carton.pieces and package.volume_m3 live as spec VALUES: accepted.
  const a1 = payloads[0];
  assert.ok(a1.specs.some((s) => s.key === 'package.volume_m3'));
  assert.equal(refusal(a1), null);
});

test('customer-facing text classed money, promotion, shipping policy or warranty is refused; owner rows may hold warranty only', () => {
  const base = clone(build(sample('a1')));
  const at = (mut: (p: ImportPayload) => void) => {
    const p = clone(base);
    mut(p);
    return refusal(p);
  };
  let r = at((p) => (p.product.title_en = 'Bambu Lab A1 — now $50 off'));
  assert.deepEqual([r?.path, r?.reason, r?.textClass], ['$.product.title_en', 'refused_text', 'money']);
  assert.ok(!r!.message.includes('$50'), 'the refusal never echoes the text');
  r = at((p) => (p.groups[0].values[0].name_en = 'Bundle Deals'));
  assert.deepEqual([r?.reason, r?.textClass], ['refused_text', 'promotion']);
  r = at((p) => (p.content_blocks[0].body_en = 'Packaging may vary, shipping costs are the same for all orders placed at the same time.'));
  assert.deepEqual([r?.reason, r?.textClass], ['refused_text', 'shipping_policy']);
  const publicRow = base.specs.findIndex((s) => s.visibility === 'public');
  r = at((p) => (p.specs[publicRow].value_text = '2-year warranty & 30-day returns.'));
  assert.deepEqual([r?.path, r?.textClass], [`$.specs[${publicRow}].value_text`, 'warranty']);
  r = at((p) => {
    p.specs[publicRow].visibility = 'owner';
    p.specs[publicRow].value_text = '2-year warranty & 30-day returns.';
  });
  assert.equal(r, null, 'an owner-only row may keep a withheld warranty sentence');
  r = at((p) => {
    p.specs[publicRow].visibility = 'owner';
    p.specs[publicRow].value_text = 'Add only $50 to the A1 Combo.';
  });
  assert.equal(r?.textClass, 'money', 'money is refused even owner-only');
});

test('unknown, missing, mistyped and out-of-list values are refused with their path', () => {
  const base = clone(build(sample('h2d')));
  const at = (mut: (p: Record<string, unknown> & ImportPayload) => void) => {
    const p = clone(base) as Record<string, unknown> & ImportPayload;
    mut(p);
    return refusal(p);
  };
  const u = at((p) => ((p.groups[0] as unknown as Record<string, unknown>).hint = 'x'));
  assert.deepEqual([u?.path, u?.reason], ['$.groups[0].hint', 'unknown_key']);
  assert.equal(at((p) => delete (p.product as Record<string, unknown>).title_en)?.reason, 'missing_key');
  assert.equal(at((p) => ((p.specs[0] as unknown as Record<string, unknown>).value_num = '465'))?.reason, 'wrong_type');
  assert.equal(at((p) => ((p as Record<string, unknown>).protocol = 3))?.reason, 'not_allowed_value');
  assert.equal(at((p) => (p.specs[0].status = 'guessed'))?.reason, 'not_allowed_value');
  assert.equal(at((p) => (p.product.title_en = 'x'.repeat(301)))?.reason, 'too_long');
  assert.equal(refusal([])?.reason, 'wrong_type');
  assert.equal(refusal(null)?.path, '$');
});

// ---------------------------------------------------------------- the public fingerprint

/** What the Worker's anonymous site answer and /knowledge would say about a payload once written (lists in another order). */
function liveAnswers(p: ImportPayload, media: readonly MediaResult[]): { site: SiteRelations; knowledge: KnowledgeAnswer } {
  const url = new Map(media.map((m) => [m.source_media_id, `https://levonis.example/files/${m.r2_key}?v=1`]));
  return {
    site: {
      option_groups: [...p.groups].reverse().map((g) => ({ id: g.id, sort: g.sort, default_value_id: g.default_value_id, values: [...g.values].reverse().map((v) => ({ id: v.id, sort: v.sort })) })),
      variants: [...p.variants].reverse().map((v) => ({ id: v.id, combo_key: v.combo_key })),
      images: [...p.images].reverse().map((i) => ({ id: i.id, url: url.get(i.source_media_id) ?? '', is_primary: i.is_primary, option_value_id: i.option_value_id, variant_id: i.variant_id })),
    },
    knowledge: {
      swatches: p.swatches.map((s) => ({ option_value_id: s.value_id, url: url.get(s.source_media_id) ?? '' })),
      specs: p.specs.filter((s) => s.visibility === 'public').reverse().map((s) => ({ key: s.key, scope_kind: s.scope_kind, scope_id: s.scope_id, region: s.region, status: s.status, unit: s.unit, value_num: s.value_num })),
      documents: p.documents.map((d) => ({ kind: d.kind, url: d.url })),
      relations: p.relations.map((r) => ({ relation: r.relation, scope_kind: r.scope_kind, scope_id: r.scope_id, target_label: r.target_label, state: r.state, target_product_id: r.target_product_id, target_source_handle: r.target_source_handle })),
    },
  };
}

test('fingerprint: the expected value from the payload equals the live answers; any changed binding changes it', () => {
  for (const h of ['h2d', 'pla-basic-filament', 'bambu-textured-pei-plate'] as const) {
    const p = build(sample(h));
    const media: MediaResult[] = [...new Set([...p.images.map((i) => i.source_media_id), ...p.swatches.map((s) => s.source_media_id)])].map((id, i) => ({ source_media_id: id, r2_key: `products/import/gallery/${i}.webp` }));
    const expected = projectionFingerprint(projectionFromPayload(p, media));
    const { site, knowledge } = liveAnswers(p, media);
    assert.equal(projectionFingerprint(projectionFromSite(site, knowledge)), expected, h);
    const moved = clone(site);
    const bound = moved.images.find((i) => i.option_value_id || i.variant_id)!;
    bound.option_value_id = null;
    bound.variant_id = null;
    assert.notEqual(projectionFingerprint(projectionFromSite(moved, knowledge)), expected, `${h}: an unbound image must change the fingerprint`);
    const extra = clone(knowledge);
    extra.specs.push({ key: 'x.extra', scope_kind: 'product', scope_id: '', region: '', status: 'unverified', unit: '', value_num: null });
    assert.notEqual(projectionFingerprint(projectionFromSite(site, extra)), expected);
  }
});

test('the extraction fingerprint is stable and changes with the source', () => {
  const x = sample('a1');
  assert.equal(extractionFingerprint(x), extractionFingerprint(sample('a1')));
  assert.match(extractionFingerprint(x), /^[0-9a-f]{64}$/);
  assert.notEqual(extractionFingerprint({ ...x, title: `${x.title} ` }), extractionFingerprint(x));
});
