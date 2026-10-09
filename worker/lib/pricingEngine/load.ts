/**
 * «التسعير والشحن» P1 — READS ONLY (MVP plan §6 P1).
 *
 * Every product is loaded the way the cart loads it — the `products` row, the
 * relational views of `loadRelationsViews`, `applyRelations(parseProductRow(row),
 * view)` — and priced in the pricing context the cart builds for a guest
 * (`pricingContextFrom` over the same two settings), so "what a customer pays
 * today" on the owner's screen is the cart's own number, not a re-derivation.
 *
 * The rate reference is the central rates the owner applied (FX-1, migration
 * 0179) and, for one not set yet, the value read live from
 * `procurement_cost_profiles` with the master plan v2 seeding rule: EUR from
 * Germany land, CNY from the more recently updated China profile, no USD, a
 * value out of range is missing — and every purchase-screen value UNCONFIRMED.
 *
 * Nothing here writes: every statement is a SELECT
 * (tests/pricingPreviewNoWrite.test.ts records them).
 */
import { getSettings } from '../settings';
import { applyRelations, loadRelationsViews, type ProductRelationsView } from '../productOverlay';
import { parseProductRow, type ProductDoc } from '../productModel';
import { pricingContextFrom, type PricingContext } from '../../routes/cart';
import type { CentralRate, CentralRates, SupplierCurrency } from '@levonis/pricing/costToPrice';
import type { ShippingProfile } from '@levonis/pricing/skuChannel';

/** One product as the cart reads it. */
export interface LoadedProduct {
  id: string;
  row: Record<string, unknown>;
  doc: ProductDoc;
  view: ProductRelationsView | undefined;
}

/** A product of the engine's catalogue: ordinary (no bundle, no mystery), any status. */
export interface PricedProductRef {
  id: string;
  status: string;
}

/** Bounded: the relational views bind one json_each list per chunk. */
const LOAD_CHUNK = 50;

/** The pricing context of a guest's cart: the PRO policy and the route defaults, no member benefit. */
export async function loadPreviewContext(db: D1Database): Promise<PricingContext> {
  const settings = await getSettings(db, ['proPricingPolicy', 'preorderTransportDefaults']);
  return pricingContextFrom(settings);
}

/**
 * Every ordinary product, active first, then hidden, then drafts, each by
 * name. Compositions are priced from their members and never by the engine
 * (COMPOSITION_NOT_PRICEABLE), so they are not listed.
 */
export async function listPricedProducts(db: D1Database): Promise<PricedProductRef[]> {
  const { results } = await db
    .prepare(
      `SELECT id, status FROM products
        WHERE COALESCE(composition, '') = ''
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'hidden' THEN 1 ELSE 2 END,
                 LOWER(COALESCE(NULLIF(name, ''), NULLIF(name_ar, ''), slug)), id`
    )
    .all<{ id: string; status: string }>();
  return (results ?? []).map((r) => ({ id: String(r.id), status: String(r.status ?? '') }));
}

/** The products named, as the cart reads them, in chunks; an unknown id is simply absent. */
export async function loadProducts(db: D1Database, ids: readonly string[]): Promise<Map<string, LoadedProduct>> {
  const out = new Map<string, LoadedProduct>();
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  for (let i = 0; i < unique.length; i += LOAD_CHUNK) {
    const chunk = unique.slice(i, i + LOAD_CHUNK);
    const { results } = await db
      .prepare('SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(chunk))
      .all<Record<string, unknown>>();
    const rows = results ?? [];
    const views = await loadRelationsViews(
      db,
      rows.map((r) => ({ id: String(r.id), inventory_mode: r.inventory_mode }))
    );
    for (const row of rows) {
      const id = String(row.id);
      const view = views.get(id);
      const doc = view ? applyRelations(parseProductRow(row), view) : parseProductRow(row);
      out.set(id, { id, row, doc, view });
    }
  }
  return out;
}

// ------------------------------------------------------------ the rate reference

/**
 * Where a rate came from: the central rates the owner applied (FX-1,
 * `pricing_fx_rates` / `pricing_shipping_rates`), the purchase profiles (P1,
 * and the fallback while a central rate is not set), or the owner's what-if.
 */
export type RateOrigin = 'central' | 'procurement_profiles' | 'what_if';

export interface RateReferenceEntry {
  rate: string | null;
  origin: RateOrigin;
}

export interface RateReference {
  fx: Record<SupplierCurrency, RateReferenceEntry>;
  shipping: Record<ShippingProfile, RateReferenceEntry>;
}

interface ProfileRow {
  id: string;
  fx_text: string | null;
  ship_text: string | null;
  updated_at: string | null;
}

const asText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * THE RATE REFERENCE (FX plan §1 C1): each central rate the owner applied —
 * `pricing_fx_rates` (IQD per USD, EUR = E×U, CNY = C×U) and
 * `pricing_shipping_rates` — and, for a rate not set there yet (or on a
 * database without migration 0179), the purchase screens' value. A central
 * rate is applied or absent, so it counts as confirmed (critique L5).
 */
export async function loadRateReference(db: D1Database): Promise<RateReference> {
  const ref = await loadProcurementReference(db);
  try {
    const [fx, ship] = await Promise.all([
      db.prepare('SELECT currency, rate_iqd FROM pricing_fx_rates').all<{ currency: string; rate_iqd: string | null }>(),
      db.prepare('SELECT profile, rate_iqd FROM pricing_shipping_rates').all<{ profile: string; rate_iqd: string | null }>(),
    ]);
    for (const r of fx.results ?? []) {
      const rate = asText(r.rate_iqd);
      if (rate && (r.currency === 'USD' || r.currency === 'EUR' || r.currency === 'CNY')) ref.fx[r.currency] = { rate, origin: 'central' };
    }
    for (const r of ship.results ?? []) {
      const rate = asText(r.rate_iqd);
      if (rate && (r.profile === 'GERMANY_LAND' || r.profile === 'CHINA_AIR' || r.profile === 'CHINA_SEA')) ref.shipping[r.profile] = { rate, origin: 'central' };
    }
  } catch {
    // No central rates (a database without 0179): the purchase screens' values stand.
  }
  return ref;
}

/**
 * The rates the purchase screens hold — never confirmed. A missing table (a
 * database older than 0172) is all missing.
 */
export async function loadProcurementReference(db: D1Database): Promise<RateReference> {
  const empty = (): RateReferenceEntry => ({ rate: null, origin: 'procurement_profiles' });
  const ref: RateReference = {
    fx: { USD: empty(), EUR: empty(), CNY: empty() },
    shipping: { GERMANY_LAND: empty(), CHINA_AIR: empty(), CHINA_SEA: empty() },
  };
  let rows: ProfileRow[] = [];
  try {
    const { results } = await db
      .prepare(
        `SELECT id,
                CASE WHEN exchange_rate >= 0.000001 AND exchange_rate < 10000000
                     THEN rtrim(rtrim(printf('%.6f', exchange_rate), '0'), '.') END AS fx_text,
                CASE WHEN shipping_rate_iqd IS NULL OR shipping_rate_iqd <= 0 OR shipping_rate_iqd >= 1000000000 THEN NULL
                     ELSE rtrim(rtrim(printf('%.6f', shipping_rate_iqd), '0'), '.') END AS ship_text,
                updated_at
           FROM procurement_cost_profiles
          WHERE id IN ('germany_land', 'china_air', 'china_sea')`
      )
      .all<ProfileRow>();
    rows = results ?? [];
  } catch {
    return ref;
  }
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  ref.fx.EUR.rate = asText(byId.get('germany_land')?.fx_text);
  // CNY: the more recently updated China profile with a usable rate; a tie goes to air (0179 part 10).
  const china = rows
    .filter((r) => (r.id === 'china_air' || r.id === 'china_sea') && asText(r.fx_text))
    .sort((a, b) => {
      const ta = String(a.updated_at ?? '');
      const tb = String(b.updated_at ?? '');
      if (ta !== tb) return ta < tb ? 1 : -1;
      return a.id === 'china_air' ? -1 : b.id === 'china_air' ? 1 : 0;
    });
  ref.fx.CNY.rate = asText(china[0]?.fx_text);
  ref.shipping.GERMANY_LAND.rate = asText(byId.get('germany_land')?.ship_text);
  ref.shipping.CHINA_AIR.rate = asText(byId.get('china_air')?.ship_text);
  ref.shipping.CHINA_SEA.rate = asText(byId.get('china_sea')?.ship_text);
  return ref;
}

/**
 * The reference as E1's central rates: version 0; a central rate is confirmed
 * exactly when present (critique L5), a purchase-screen or what-if rate never
 * is (`allowUnconfirmedRates` previews only).
 */
export function centralRatesOf(ref: RateReference): CentralRates {
  const rate = (e: RateReferenceEntry): CentralRate => ({ rate: e.rate, version: 0, confirmed: e.origin === 'central' && e.rate !== null });
  return {
    fx: { USD: rate(ref.fx.USD), EUR: rate(ref.fx.EUR), CNY: rate(ref.fx.CNY) },
    shipping: {
      GERMANY_LAND: rate(ref.shipping.GERMANY_LAND),
      CHINA_AIR: rate(ref.shipping.CHINA_AIR),
      CHINA_SEA: rate(ref.shipping.CHINA_SEA),
    },
  };
}
