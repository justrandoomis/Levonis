/**
 * OWNER DECISION 6 AT CHECKOUT: THE ENGINE PRICE AND THE RATE A LINE IS BOUGHT
 * AT (ODP §5.1 items 8-10; USD design §6.6).
 *
 * One query per checkout over the engine's private results. A line gets the
 * snapshot only when its product is engine-priced AND the regular price the
 * resolver charged it is exactly the stored engine price of its model ×
 * channel; every other line keeps the exact INSERT it always had (all six
 * columns NULL, migration 0181's shape trigger). The snapshot is written once,
 * with the line, and frozen by 0181's trigger; accounting never reads it.
 *
 * The line's channel is the one the engine priced it on: a line priced from
 * the direct ladder (a direct sale, or a pre-order paid cash on delivery) is
 * `direct_sale`; a prepaid pre-order is `pre_order_<route>`.
 *
 * Base USD at purchase = the engine price ÷ the U it was computed at (policy
 * `price_protection` v5's definition), rounded up at 6 places — a record for
 * the claim screen, never re-priced from.
 *
 * Feature-detected: on a database without migration 0181 the engine tables do
 * not exist, no line is engine-priced, and the INSERT is byte-identical. This
 * module returns column values only; it names no accounting table.
 */
import { ceilToPlaces, procurementExact, procurementExactText, quotientProcurementExact } from '@levonis/contracts/procurementCost';
import { channelOfRoute, skuComboKey, type PreorderRoute, type SkuChannel } from '@levonis/pricing/skuChannel';
import { isMissingTable } from '../fx/pairs';

export interface LineForBasis {
  /** The caller's line id. */
  key: string;
  product_id: string;
  /** The model (the option value the line was priced from); '' = the product itself. */
  option_id: string;
  /** 'direct' when the line was priced from the direct ladder, else 'preorder'. */
  pricing_basis: 'direct' | 'preorder';
  /** The pre-order route the line travels, when priced as a pre-order. */
  route: string | null;
  /** The regular price the resolver charged (before membership). */
  regular_iqd: number;
}

/** The six columns of an engine-priced line (migration 0181 §12). */
export interface EngineLineBasis {
  price_basis: 'engine';
  engine_combo_key: string;
  engine_channel: SkuChannel;
  engine_regular_iqd: number;
  usd_iqd_at_purchase: string;
  base_usd_at_purchase: string;
}

const ROUTES: readonly string[] = ['air', 'sea', 'land'];

export function channelOfLine(line: Pick<LineForBasis, 'pricing_basis' | 'route'>): SkuChannel | null {
  if (line.pricing_basis === 'direct') return 'direct_sale';
  return line.route && ROUTES.includes(line.route) ? channelOfRoute(line.route as PreorderRoute) : null;
}

/** Base USD = price ÷ U, rounded up at 6 places (decimal text). */
export function baseUsdOf(priceIqd: number, usdIqd: string): string {
  return procurementExactText(ceilToPlaces(quotientProcurementExact(procurementExact(priceIqd), procurementExact(usdIqd)), 6));
}

/** The engine snapshot of each line that was bought at an engine price (see the file header). */
export async function engineBasisOf(db: D1Database, lines: readonly LineForBasis[]): Promise<Map<string, EngineLineBasis>> {
  const out = new Map<string, EngineLineBasis>();
  const wanted = lines.filter((l) => l.product_id && Number.isSafeInteger(l.regular_iqd) && l.regular_iqd > 0 && channelOfLine(l) !== null);
  if (!wanted.length) return out;
  let rows: Array<{ product_id: string; combo_key: string; channel: string; computed_price_iqd: number; usd_iqd_rate: string }>;
  try {
    const res = await db
      .prepare(
        `SELECT c.product_id, c.combo_key, c.channel, c.computed_price_iqd, c.usd_iqd_rate
           FROM pricing_sku_costs c
           JOIN product_pricing_state s ON s.product_id = c.product_id AND s.mode = 'engine'
          WHERE c.product_id IN (SELECT value FROM json_each(?))`
      )
      .bind(JSON.stringify([...new Set(wanted.map((l) => l.product_id))]))
      .all<{ product_id: string; combo_key: string; channel: string; computed_price_iqd: number; usd_iqd_rate: string }>();
    rows = res.results ?? [];
  } catch (e) {
    if (isMissingTable(e)) return out;
    throw e;
  }
  for (const l of wanted) {
    const channel = channelOfLine(l)!;
    const combo = skuComboKey({ option_value_ids: l.option_id ? [l.option_id] : [], color_id: null });
    const r = rows.find((x) => x.product_id === l.product_id && x.combo_key === combo && x.channel === channel);
    if (!r || Number(r.computed_price_iqd) !== l.regular_iqd) continue;
    out.set(l.key, {
      price_basis: 'engine',
      engine_combo_key: combo,
      engine_channel: channel,
      engine_regular_iqd: l.regular_iqd,
      usd_iqd_at_purchase: r.usd_iqd_rate,
      base_usd_at_purchase: baseUsdOf(l.regular_iqd, r.usd_iqd_rate),
    });
  }
  return out;
}
