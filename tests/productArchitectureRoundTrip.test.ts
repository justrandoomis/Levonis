import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, json, row } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { deleteProductPermanently, ownedMediaKeys } from '../worker/lib/productDeletion';
import { applyRelations, loadRelationsView } from '../worker/lib/productOverlay';
import { parseProductRow } from '../worker/lib/productModel';
import { docToEntries } from '../worker/lib/template';
import { freezeOrderSelections } from '../worker/lib/orderSelectionSnapshot';
import { resolveUnitPrice } from '../worker/lib/pricing';
import type { Env } from '../worker/lib/types';
import type { ShippingQuote } from '../worker/lib/shipping';

class BytesBucket {
  objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  async put(key: string, bytes: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: new Uint8Array(bytes), mime: opts?.httpMetadata?.contentType ?? 'image/webp' });
    return this.head(key);
  }
  async get(key: string) {
    const o = this.objects.get(key); if (!o) return null;
    return { key, size: o.bytes.length, httpMetadata: { contentType: o.mime }, arrayBuffer: async () => o.bytes.slice().buffer };
  }
  async head(key: string) { const o = this.objects.get(key); return o ? { key, size: o.bytes.length } : null; }
  async delete(key: string) { this.objects.delete(key); }
}

const source = `template_version=2
name_en=A1 mini
name_ar=A1 mini
slug=architecture-portable
catalogs=printers
price_iqd=499000
prime_price_iqd=479000
pro_price_iqd=449000
product_cost_iqd=300000
selling_type=mixed
standard_delivery_enabled=true
standard_delivery_quantity_step=2
standard_delivery_fee_iqd=10000
personal_delivery_enabled=true
personal_delivery_quantity_step=1
personal_delivery_fee_iqd=25000
options.1.id=mini
options.1.name_en=A1 mini
options.1.variant_key=a1-mini
options.1.direct.enabled=true
options.1.direct.regular_price_iqd=549000
options.1.direct.prime_price_iqd=529000
options.1.direct.pro_price_iqd=449000
options.1.direct.stock=5
options.1.preorder.enabled=true
options.1.preorder.regular_price_iqd=499000
options.1.preorder.pro_price_iqd=449000
options.1.preorder.transports.1.method=sea
options.1.preorder.transports.1.enabled=true
options.1.preorder.transports.1.surcharge_iqd=0
options.1.preorder.transports.1.lead_time_min_days=21
options.1.preorder.transports.1.lead_time_max_days=28
options.1.preorder.transports.2.method=land
options.1.preorder.transports.2.enabled=true
options.1.preorder.transports.2.surcharge_iqd=30000
options.1.preorder.transports.3.method=air
options.1.preorder.transports.3.enabled=true
options.1.preorder.transports.3.surcharge_iqd=80000
options.2.id=combo
options.2.name_en=A1 mini Combo
options.2.variant_key=a1-mini-combo
options.2.regular_adjust_iqd=180000
options.2.direct.enabled=true
options.2.direct.regular_price_iqd=699000
options.2.direct.stock=3
options.2.preorder.enabled=true
options.2.preorder.regular_price_iqd=679000
images.1.id=image-one
images.1.key=products/source/front.webp
images.1.url=/files/products/source/front.webp
images.1.primary=true
spec_groups.1.id=specs
spec_groups.1.title_ar=المواصفات
spec_groups.1.title_en=Technical
spec_groups.1.rows.1.id=dimension
spec_groups.1.rows.1.label_ar=حجم الطباعة
spec_groups.1.rows.1.label_en=Build volume
spec_groups.1.rows.1.value_en=180x180x180
warranty_plans.1.id=two-years
warranty_plans.1.title_ar=سنتان
warranty_plans.1.title_en=Two years
warranty_plans.1.duration_months=12
warranty_plans.1.duration_kind=extension
warranty_plans.1.fee_iqd=0
warranty_plans.1.fee_percent=5
usage_steps.1.kind=setup
usage_steps.1.title=Setup
usage_steps.1.body=Connect power before starting.
`;

test('real TXT export -> permanent D1/R2 delete -> same TXT import restores model/routes/prices/content and exact image bytes', async () => {
  const raw = freshDb(); raw.prepare("UPDATE catalogs SET is_printer_catalog=1 WHERE slug='printers'").run(); const db = asD1(raw); const bucket = new BytesBucket();
  const env = { DB: db, BUCKET: bucket, APP_ORIGIN: 'https://levonis-iq.com' } as unknown as Env;
  const app = stubApp(db, { id: 'owner', role: 'admin', email: 'boss@x.co' }, a => a.route('/api/admin/template', templateRoutes), { env: { BUCKET: bucket, APP_ORIGIN: env.APP_ORIGIN } });
  const bytes = Uint8Array.from(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
  await bucket.put('products/source/front.webp', bytes);
  const first = await post(app, '/api/admin/template/apply', { text: source, mode: 'draft', confirm: true });
  const firstBody = await json(first); assert.equal(first.status, 200, JSON.stringify(firstBody));
  const id = firstBody.product_id as string;
  const before = applyRelations(parseProductRow(row(raw, 'SELECT * FROM products WHERE id=?', id)!), await loadRelationsView(db, id, 'BASE'));
  const exported = await get(app, `/api/admin/template/export/${id}`);
  const text = await exported.text(); assert.equal(exported.status, 200, text);
  assert.match(text, /^# levonis_asset_v1=/m);
  assert.doesNotMatch(text, /^options\.\d+\.availability_type=/m);
  const deletion = await deleteProductPermanently(env, id, 'owner');
  assert.equal(deletion.product_deleted, true); assert.equal(deletion.r2_objects_deleted, 1);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM products WHERE id=?', id)?.n, 0);
  assert.equal(bucket.objects.size, 0);
  const second = await post(app, '/api/admin/template/apply', { text, mode: 'draft', confirm: true });
  const secondBody = await json(second); assert.equal(second.status, 200, JSON.stringify(secondBody));
  assert.notEqual(secondBody.product_id, id);
  const after = applyRelations(parseProductRow(row(raw, 'SELECT * FROM products WHERE id=?', secondBody.product_id)!), await loadRelationsView(db, secondBody.product_id, 'BASE'));
  assert.equal(after.options.length, 2);
  assert.deepEqual(after.delivery_options, before.delivery_options);
  assert.deepEqual(after.spec_groups, before.spec_groups);
  assert.deepEqual(after.warranty_plans, before.warranty_plans);
  assert.deepEqual(after.usage_guide, before.usage_guide);
  const restoredKey = [...ownedMediaKeys(after, env.APP_ORIGIN)][0];
  assert.notEqual(restoredKey, 'products/source/front.webp');
  assert.deepEqual(bucket.objects.get(restoredKey)?.bytes, bytes);
  // Compare every serialized model field, ignoring relational IDs generated
  // for the parent and immutable media paths intentionally replaced on restore.
  const options = (doc: typeof before) => docToEntries(doc).filter(e => e.key.startsWith('options.'));
  assert.deepEqual(options(after), options(before));
  for (const tier of ['free', 'prime', 'pro'] as const) for (const method of [null, 'air', 'sea', 'land']) {
    const input = { optionId: 'mini', transportMethod: method, tier, tierActive: true };
    const a = resolveUnitPrice({ product: before, ...input }); const b = resolveUnitPrice({ product: after, ...input });
    assert.deepEqual(b.errors, []); assert.equal(b.unit_subtotal_iqd, a.unit_subtotal_iqd);
  }
  // Reuse the identical exported bytes again after deletion: no fingerprint,
  // slug, option ID or image relation from the prior import may block it.
  await deleteProductPermanently(env, after.id, 'owner');
  const third = await post(app, '/api/admin/template/apply', { text, mode: 'draft', confirm: true });
  assert.equal(third.status, 200, JSON.stringify(await json(third)));
});

test('order snapshots allocate exactly the quoted local delivery fee and remain self-contained', () => {
  const lines = [1, 2].map(qty => ({ product_id: 'p', qty, unit: 499000, name: 'A1 mini', name_ar: '', variant: 'Combo', option_id: 'combo', color_id: '', image: '/files/products/p/a.webp', pricing_snapshot: '{}', warranty_snapshot: '{"months":24}', transport_snapshot: '{"method":"air"}', selection_snapshot: '{"resolved_product_base":449000,"resolved_option_delta":50000,"resolved_fulfillment_delta":0,"resolved_transport_delta":0,"resolved_membership_adjustment":0,"membership_tier":"pro","variant_key":"combo","lead_time":{"text":"7 days","min_days":7,"max_days":7}}' }));
  const shipping = { total_iqd: 10001, components: [{ product_id: 'p', fee_iqd: 10001, waived: false }], waiver_source: null } as unknown as ShippingQuote;
  freezeOrderSelections(lines, shipping, 'standard');
  const snapshots = lines.map(l => JSON.parse(l.selection_snapshot));
  assert.equal(snapshots.reduce((n,s) => n+s.resolved_delivery_fee, 0), 10001);
  assert.equal(snapshots.reduce((n,s) => n+s.resolved_final_price, 0), 499000*3+10001);
  assert.equal(snapshots[0].local_delivery_method, 'standard');
  assert.equal(snapshots[0].transport_method, 'air');
  assert.equal(snapshots[0].option_name, 'Combo');
  assert.equal(snapshots[0].membership_tier, 'pro');
});
