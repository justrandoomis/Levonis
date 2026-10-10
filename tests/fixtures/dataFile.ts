/**
 * «ملف بيانات المنتج» — the shared harness of the data-file tests: a fresh
 * database with every migration, the real template router behind a stubbed
 * session, a rich product created through the old TXT door, and the three
 * doors of the round trip (download, preview, apply).
 */
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get } from './app';
import { templateRoutes } from '../../worker/routes/template';

export const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null as string | null };

export function setup(user: { id: string; role: 'admin'; email: string; admin_scope: string | null } = OWNER, raw: DatabaseSync = freshDb()) {
  const db = asD1(raw);
  const app = stubApp(db, user, (a) => a.route('/api/admin/template', templateRoutes));
  return { raw, db, app };
}
export type App = ReturnType<typeof setup>['app'];

export const PRODUCT = `template_version=2
slug=x1-printer
name_ar=طابعة اكس
name_en=X1 Printer
name_ckb=چاپکەری ئێکس
status=active
description_ar=<<<END
سطر أول
سطر ثانٍ
END
price_iqd=1000000
original_price_iqd=1200000
product_cost_iqd=700000
selling_type=direct_sale
sku=X1-BASE
hashtags=printer,fast
is_featured=false
display_order=5
package_weight_g=8200
package_width_mm=500
package_depth_mm=400
package_height_mm=300
options.1.id=opt_std
options.1.group=Model
options.1.name_ar=قياسي
options.1.name_en=Standard
options.1.active=true
options.1.cost_iqd=650000
options.1.stock=4
options.1.direct.enabled=true
options.1.preorder.enabled=true
options.1.preorder.lead_time_text_en=3-4 weeks
options.1.preorder.transports.1.method=air
options.1.preorder.transports.1.surcharge_iqd=80000
options.1.preorder.transports.2.method=sea
options.1.preorder.transports.2.surcharge_iqd=30000
options.2.id=opt_combo
options.2.group=Model
options.2.name_ar=كومبو
options.2.name_en=Combo
options.2.active=true
options.2.regular_adjust_iqd=150000
options.2.stock=2
options.2.direct.enabled=true
options.3.id=opt_kit
options.3.group=Model
options.3.name_ar=عدة
options.3.name_en=Kit
options.3.active=true
options.3.regular_adjust_iqd=50000
options.3.stock=1
options.3.direct.enabled=true
colors.1.id=col_black
colors.1.name_ar=أسود
colors.1.name_en=Black
colors.1.hex=#000000
colors.1.active=true
colors.2.id=col_white
colors.2.name_ar=أبيض
colors.2.name_en=White
colors.2.hex=#ffffff
colors.2.active=true
spec_groups.1.id=sg_main
spec_groups.1.title_ar=أساسي
spec_groups.1.title_en=Main
spec_groups.1.rows.1.id=sr_vol
spec_groups.1.rows.1.label_ar=حجم الطباعة
spec_groups.1.rows.1.label_en=Build volume
spec_groups.1.rows.1.value_en=256 mm
labels.1.id=lbl_new
labels.1.text_ar=جديد
labels.1.text_en=New
labels.1.visible=true
content_blocks.1.id=cb_intro
content_blocks.1.kind=text
content_blocks.1.body_ar=نص تعريفي
membership.pro.discount_mode=percent
membership.pro.percent=5
`;

/** A filament whose stock lives on exact option × colour combinations. */
export const VARIANT_PRODUCT = `template_version=2
slug=pla-v
name_ar=فلمنت
name_en=PLA
price_iqd=25000
selling_type=direct_sale
inventory_mode=VARIANT_COMBINATION
options.1.id=opt_1kg
options.1.group=Size
options.1.name_en=1 kg
options.1.active=true
options.1.direct.enabled=true
options.1.stock=__NULL__
colors.1.id=col_black
colors.1.name_en=Black
colors.1.hex=#000000
colors.1.option_id=__NULL__
colors.1.active=true
colors.2.id=col_white
colors.2.name_en=White
colors.2.hex=#ffffff
colors.2.option_id=__NULL__
colors.2.active=true
variants.1.id=pv_black
variants.1.option_value_ids=opt_1kg
variants.1.color_id=col_black
variants.1.active=true
variants.1.stock=3
variants.2.id=pv_white
variants.2.option_value_ids=opt_1kg
variants.2.color_id=col_white
variants.2.active=true
variants.2.stock=5
`;

export async function create(app: App, text = PRODUCT): Promise<string> {
  const res = await post(app, '/api/admin/template/apply', { text, mode: 'draft', confirm: true });
  const body = (await res.json()) as { product_id?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.product_id!;
}

export function addImages(raw: DatabaseSync, productId: string) {
  raw.exec(`
    INSERT INTO product_images (id, product_id, url, r2_key, content_type, bytes, width, height, sort_order, is_primary, alt_en, alt_ar)
    VALUES ('img_a', '${productId}', '/files/products/a.webp', 'products/a.webp', 'image/webp', 1234, 800, 600, 0, 1, 'Front', 'أمام'),
           ('img_b', '${productId}', '/files/products/b.webp', 'products/b.webp', 'image/webp', 2345, 800, 600, 1, 0, 'Side', 'جانب');
  `);
}

export async function download(app: App, productId: string): Promise<string> {
  const res = await get(app, `/api/admin/template/data-export/${productId}`);
  assert.equal(res.status, 200, await res.clone().text());
  return res.text();
}

export interface PreviewField {
  key: string;
  /** The comparison's own key for the line (items by id: `options[opt_x].preorder.transports[air].…`). */
  nkey?: string;
  status: string;
  before: string | null;
  after: string | null;
  message?: string;
  private: boolean;
}
export interface PreviewProduct {
  product_id: string;
  error: { code: string } | null;
  counts: { changes: number; refused: number; stale: number; derived: number };
  fields: PreviewField[];
  derived: Array<{ key: string }>;
  token: string | null;
  pricing: { kind: string; preview_hash: string | null; large_change: boolean } | null;
}

export async function preview(app: App, text: string, productId?: string): Promise<PreviewProduct[]> {
  const res = await post(app, '/api/admin/template/data-preview', { text, ...(productId ? { product_id: productId } : {}) });
  const body = (await res.json()) as { products?: PreviewProduct[] };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.products!;
}

export async function apply(app: App, text: string, p: PreviewProduct, extra: Record<string, unknown> = {}) {
  return post(app, '/api/admin/template/data-apply', { text, product_id: p.product_id, token: p.token, ...extra });
}

/** Replace one `key=value` line of a file. */
export function edit(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key.replace(/[.[\]]/g, '\\$&')}=.*$`, 'm');
  assert.ok(re.test(text), `the file has ${key}`);
  return text.replace(re, `${key}=${value}`);
}


/** Replace one `key=value` line inside one product's block of a bulk file. */
export function editIn(text: string, productId: string, key: string, value: string): string {
  const start = text.indexOf(`=== product ${productId} ===`);
  const end = text.indexOf(`=== end ${productId} ===`, start);
  assert.ok(start >= 0 && end > start, `the file has the block of ${productId}`);
  return text.slice(0, start) + edit(text.slice(start, end), key, value) + text.slice(end);
}
