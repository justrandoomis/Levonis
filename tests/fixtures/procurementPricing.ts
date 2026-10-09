/**
 * THE PROCUREMENT CARD'S PRICING WORLD (USD design §12 P-C tests): the 41
 * census products, the owner, the brief's rates (1 USD = 1,600 IQD,
 * EUR/USD 1.1, CNY/USD 0.14) applied as the FX commit would, central shipping
 * rates, and the two routers the card talks to — the purchase documents and
 * the pricing door — mounted as worker/index.ts mounts them.
 *
 * `lp_08` (bambu-lab-ams-ht) is the brief's example product: one model
 * (`lp_08_o0`), sold direct and by land pre-order, no stored pricing input.
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, put, stubApp, type StubUser } from './app';
import { seedLegacyCatalogue, seedProfileRates } from './legacyCatalogue';
import { OWNER_ROW_SQL, applyRate } from './fx';
import { adminPricingRoutes } from '../../worker/routes/adminPricing';
import { adminProcurementRoutes } from '../../worker/routes/adminProcurement';
import { noStoreUnlessSet } from '../../worker/lib/edgePolicy';

export const OWNER_USER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
export const AMS = 'lp_08';
export const AMS_MODEL = 'lp_08_o0';

export function pricingWorld(opts: { rates?: boolean; raw?: DatabaseSync; user?: StubUser | null; sessionAgeSeconds?: number } = {}) {
  const raw = opts.raw ?? freshDb();
  if (!opts.raw) {
    raw.exec(OWNER_ROW_SQL);
    seedLegacyCatalogue(raw);
    seedProfileRates(raw);
  }
  if (opts.rates !== false && !opts.raw) {
    applyRate(raw, 'USD_IQD', '1600');
    applyRate(raw, 'EUR_USD', '1.1');
    applyRate(raw, 'CNY_USD', '0.14');
    raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND';
              UPDATE pricing_shipping_rates SET rate_iqd = '20000', version = version + 1 WHERE profile = 'CHINA_AIR';
              UPDATE pricing_shipping_rates SET rate_iqd = '400000', version = version + 1 WHERE profile = 'CHINA_SEA';`);
  }
  const user = opts.user === undefined ? OWNER_USER : opts.user;
  const app = stubApp(
    asD1(raw),
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route('/api/admin/procurement', adminProcurementRoutes);
    },
    opts.sessionAgeSeconds === undefined ? {} : { sessionAgeSeconds: opts.sessionAgeSeconds }
  );
  const profileVersion = (id = 'germany_land') =>
    Number((raw.prepare('SELECT version FROM procurement_cost_profiles WHERE id = ?').get(id) as { version: number }).version);
  /** The brief's purchase: 2 × AMS HT at EUR 450, 2.5 kg packed, Germany by land (the document's own rate 1,760 IQD/EUR). */
  const draft = (extra: Record<string, unknown> = {}) => ({
    operation_id: `op_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    currency: 'EUR',
    exchange_rate: 1760,
    cost_profile_id: 'germany_land',
    cost_profile_version: profileVersion(),
    shipping_rate_iqd: 5000,
    status: 'ordered',
    cost_state: 'final',
    lines: [{ product_id: AMS, scope: 'option', scope_id: AMS_MODEL, qty_ordered: 2, source_unit_amount: 450, weight_g: 2500, volume_mm3: 0 }],
    charges: [],
    ...extra,
  });
  const preview = async (body: Record<string, unknown>) => {
    const res = await post(app, '/api/admin/pricing/procurement/preview', body);
    return { status: res.status, headers: res.headers, body: await json(res) };
  };
  const save = async (body: Record<string, unknown>) => {
    const res = await post(app, '/api/admin/procurement/documents', body);
    const out = await json(res);
    if (res.status !== 200) throw new Error(`save ${res.status} ${JSON.stringify(out)}`);
    return String(out.id);
  };
  const apply = async (productId: string, body: Record<string, unknown>) => {
    const res = await post(app, `/api/admin/pricing/products/${productId}/apply-purchase`, body);
    return { status: res.status, body: await json(res) };
  };
  const putRules = async (productId: string, body: Record<string, unknown>) => {
    const res = await put(app, `/api/admin/pricing/products/${productId}/rules`, body);
    return { status: res.status, body: await json(res) };
  };
  const getInputs = async (productId: string) => {
    const res = await get(app, `/api/admin/pricing/products/${productId}/inputs`);
    return { status: res.status, headers: res.headers, body: await json(res) };
  };
  const previewInputs = async (productId: string, draft: Record<string, unknown>) => {
    const res = await post(app, `/api/admin/pricing/products/${productId}/preview`, { draft });
    return { status: res.status, body: await json(res) };
  };
  const putInputs = async (productId: string, body: Record<string, unknown>) => {
    const res = await put(app, `/api/admin/pricing/products/${productId}/inputs`, body);
    return { status: res.status, body: await json(res) };
  };
  const receive = async (purchaseId: string, operationId: string) => {
    const doc = await json(await get(app, `/api/admin/procurement/documents/${purchaseId}`));
    const res = await post(app, `/api/admin/procurement/documents/${purchaseId}/receive`, {
      operation_id: operationId,
      lines: (doc.lines as Array<{ line_id: string; qty_ordered: number }>).map((l) => ({ line_id: l.line_id, qty: l.qty_ordered, rejected_qty: 0 })),
    });
    return { status: res.status, body: await json(res) };
  };
  return { raw, db: asD1(raw), app, draft, preview, save, apply, putRules, getInputs, previewInputs, putInputs, receive, profileVersion };
}
