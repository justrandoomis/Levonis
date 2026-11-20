/**
 * «خدمات الطابعات والمطالبات» IN THE MONEY SCREENS — printer services phase 3 (owner rulings 2026-11-18;
 * DECISIONS row 347). Report-only arithmetic over figures the profit engine already computed: nothing
 * here changes an order, its profit, the journal or any share.
 *
 *   printerBreakdown(bases)      a serviced printer line's net goods split into the printer and its
 *                                services (pro rata of the frozen fee inside the line price), each
 *                                service by allocateExact; the kits', the add-ons' (phase 4) and the
 *                                membership's lines; the courier fee. The parts add up to the existing
 *                                net, exactly. Phase 4 also sums the owner's kit / add-on discounts
 *                                given (printer_discount_iqd) — already inside those prices, shown only.
 *   serviceClaimsSummary(db, r)  the period's claim costs (already inside general expenses — shown as a
 *                                line, never subtracted twice), the Care discount given, the co-pay
 *                                collected (service income, owner ruling D2) and the inspections done
 *                                × the owner's labour figure (report-only; null = not configured).
 */
import { allocateExact } from './operations';
import type { OrderProfitBase } from './orderProfit';
import { careClaimsInstalled } from './careClaims';
import { isSchemaMissing } from './membershipBenefits';
import { printerPartOf, servicesSnapshotOf } from './printerPart';

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export const PRINTER_SERVICE_KEYS = ['warranty', 'care', 'packaging', 'inspection', 'academy'] as const;
export type PrinterServiceKey = (typeof PRINTER_SERVICE_KEYS)[number];

export interface PrinterBreakdown {
  /** Serviced printer lines counted. */
  printer_lines: number;
  /** Phase 8: the orders that hold at least one serviced printer line (what the courier / delivery / membership rows are limited to). */
  printer_orders: number;
  /** «مبيعات الطابعات»: what those lines RETAIN (net goods − refunds) less the services' part — revenue, not a margin. */
  printer_net_iqd: number;
  /** Phase 8: the goods cost of those lines; null while any of them has no known cost. */
  printer_cogs_iqd: number | null;
  /** Phase 8 «هامش الطابعات»: printer_net_iqd − printer_cogs_iqd; null while a cost is unknown. */
  printer_margin_iqd: number | null;
  /** What the services were priced at inside those lines (qty × the frozen per-unit fee). */
  services_gross_iqd: number;
  /** «ربح الخدمات»: the services' share of what the lines RETAIN (after coupons, points, adjustments AND returns). The shop's. */
  services_net_iqd: number;
  /** services_net split per service (allocateExact over each line's frozen fees). */
  services: Record<PrinterServiceKey, number>;
  /** Phase 8, information: what the price anchor took off lines bought below the Smart package (kept units × (anchor − fee)); already inside the prices. */
  anchor_reduction_iqd: number;
  /** Phase 8, information: the PRO services discount given on kept units; already inside the fees. */
  pro_services_discount_iqd: number;
  /** Phase 8: kept printer units by the warranty they bought (0 = none, 12, 24 months) and those that bought Levo Care. */
  sold: { units: number; warranty_0: number; warranty_12: number; warranty_24: number; care: number };
  /** Owner-made filament kit lines (0235), retained. */
  kits_net_iqd: number;
  /** Phase 4 (0242; DECISIONS row 355): the add-on lines sold with printers, retained. 0 on a database without order_items.addon_id. */
  addons_net_iqd: number;
  /**
   * Phase 4: «خصومات الطابعة الممنوحة» — the owner's kit / add-on discounts given (Σ order_items.printer_discount_iqd,
   * net of returns: × (qty − returned_qty) / qty, floored).
   * INFORMATIONAL: already inside the lines' prices (money rule D2), never subtracted again. 0 without the column.
   */
  printer_discounts_iqd: number;
  /** The membership lines bought WITH a serviced printer (0235), retained. Phase 8: no longer every membership of the period. */
  membership_iqd: number;
  /** The courier's fee on the orders that hold a serviced printer (finance_collections). Phase 8: no longer every order of the period. */
  courier_fee_iqd: number;
  /** Phase 8: the delivery income (shipping + COD fee) of those same orders — read beside courier_fee_iqd. */
  delivery_income_iqd: number;
}

/** floor(a × b / c) for non-negative integers, exact past 2^53. */
const mulDivFloor = (a: number, b: number, c: number) => Number((BigInt(Math.trunc(a)) * BigInt(Math.trunc(b))) / BigInt(Math.trunc(c)));

/** One line's split (exported for the tests). Since phase 8 on what the line RETAINS: `retained_revenue_iqd` when the profit
 * engine set it (net goods − refunds), else net goods. services_net = min(gross, floor(R × gross / line_total)) — printerPart.ts. */
export function splitServicedLine(line: { qty: unknown; line_total_iqd: unknown; net_goods_iqd: unknown; services_snapshot: unknown; retained_revenue_iqd?: unknown; refund_iqd?: unknown }) {
  const snap = servicesSnapshotOf(line.services_snapshot);
  const part = printerPartOf(line);
  const servicesNet = part.services_retained_iqd;
  const services = Object.fromEntries(PRINTER_SERVICE_KEYS.map((k) => [k, 0])) as Record<PrinterServiceKey, number>;
  if (snap && servicesNet > 0) {
    const parts = snap.lines.filter((l) => (PRINTER_SERVICE_KEYS as readonly string[]).includes(l.service) && l.fee_iqd > 0);
    if (parts.length) {
      allocateExact(servicesNet, parts.map((l) => l.fee_iqd)).forEach((v, i) => {
        services[parts[i].service as PrinterServiceKey] += v;
      });
    } else {
      // A fee with no itemised service (never written by the checkout): kept whole under the warranty.
      services.warranty += servicesNet;
    }
  }
  return { serviced: !!snap, gross: part.services_gross_iqd, services_net: servicesNet, printer_net: part.printer_part_retained_iqd, services };
}

/** What a line retains: the profit engine's retained revenue, else its net goods (a line no engine refreshed). */
const retainedOf = (row: Record<string, unknown>) =>
  Math.trunc(n(row.retained_revenue_iqd === undefined || row.retained_revenue_iqd === null ? row.net_goods_iqd : row.retained_revenue_iqd));

/** A line's printer discount kept after its returns: floor(discount × (qty − returned) / qty); 0 when nothing is kept. */
function keptDiscount(row: Record<string, unknown>): number {
  const d = Math.max(0, Math.trunc(n(row.printer_discount_iqd)));
  const qty = Math.max(0, Math.trunc(n(row.qty)));
  if (!d || !qty) return 0;
  const returned = Math.min(qty, Math.max(0, Math.trunc(n(row.returned_qty))));
  return returned ? mulDivFloor(d, qty - returned, qty) : d;
}

export function emptyBreakdown(): PrinterBreakdown {
  return {
    printer_lines: 0, printer_orders: 0, printer_net_iqd: 0, printer_cogs_iqd: 0, printer_margin_iqd: 0, services_gross_iqd: 0, services_net_iqd: 0,
    services: Object.fromEntries(PRINTER_SERVICE_KEYS.map((k) => [k, 0])) as Record<PrinterServiceKey, number>,
    anchor_reduction_iqd: 0, pro_services_discount_iqd: 0, sold: { units: 0, warranty_0: 0, warranty_12: 0, warranty_24: 0, care: 0 },
    kits_net_iqd: 0, addons_net_iqd: 0, printer_discounts_iqd: 0, membership_iqd: 0, courier_fee_iqd: 0, delivery_income_iqd: 0,
  };
}

/** The frozen months a serviced line bought (0 when unreadable). */
function monthsOf(raw: unknown): { warranty: number; care: number } {
  try {
    const v = JSON.parse(String(raw)) as { warranty_months?: unknown; care_months?: unknown };
    return { warranty: Math.trunc(n(v?.warranty_months)), care: Math.trunc(n(v?.care_months)) };
  } catch { return { warranty: 0, care: 0 }; }
}

/**
 * The breakdown of these orders (each base's lines as the profit engine priced them). Phase 8 (DECISIONS row 364): on
 * RETAINED figures — a returned printer no longer shows its services — and the courier, delivery and membership rows count
 * only the orders that hold a serviced printer.
 */
export function printerBreakdown(bases: Pick<OrderProfitBase, 'lines' | 'totals'>[]): PrinterBreakdown {
  const out = emptyBreakdown();
  let unknownCost = false, cogs = 0;
  for (const b of bases) {
    const rows = (b.lines ?? []) as unknown as Record<string, unknown>[];
    let printers = 0, membership = 0;
    for (const row of rows) {
      if (row.line_kind === 'membership') { membership += retainedOf(row); continue; }
      // Phase 4: the owner's discount given on a kit / add-on line (report-only; absent column = 0), net of returns
      // like the line's own net: × (qty − returned_qty) / qty, floored (the profit engine's returned_qty).
      out.printer_discounts_iqd += keptDiscount(row);
      if (row.kit_id) { out.kits_net_iqd += retainedOf(row); continue; }
      if (row.addon_id) { out.addons_net_iqd += retainedOf(row); continue; }
      if (!row.services_snapshot) continue;
      const s = splitServicedLine(row as never);
      if (!s.serviced) continue;
      printers += 1;
      out.printer_lines += 1;
      out.printer_net_iqd += s.printer_net;
      out.services_gross_iqd += s.gross;
      out.services_net_iqd += s.services_net;
      for (const k of PRINTER_SERVICE_KEYS) out.services[k] += s.services[k];
      if (row.cogs_iqd === null) unknownCost = true; else cogs += Math.trunc(n(row.cogs_iqd));
      const snap = servicesSnapshotOf(row.services_snapshot)!, qty = Math.max(0, Math.trunc(n(row.qty)));
      const kept = Math.max(0, qty - Math.min(qty, Math.max(0, Math.trunc(n(row.returned_qty)))));
      out.anchor_reduction_iqd += kept * Math.max(0, snap.anchor_fee - snap.fee);
      out.pro_services_discount_iqd += kept * snap.pro_discount;
      const months = monthsOf(row.services_snapshot);
      out.sold.units += kept;
      if (months.warranty >= 24) out.sold.warranty_24 += kept; else if (months.warranty >= 12) out.sold.warranty_12 += kept; else out.sold.warranty_0 += kept;
      if (months.care > 0) out.sold.care += kept;
    }
    if (!printers) continue;
    out.printer_orders += 1;
    out.membership_iqd += membership;
    out.courier_fee_iqd += Math.trunc(n(b.totals?.courier_fee_iqd));
    out.delivery_income_iqd += Math.trunc(n(b.totals?.shipping_income_iqd)) + Math.trunc(n(b.totals?.cod_tax_iqd));
  }
  out.printer_cogs_iqd = unknownCost ? null : cogs;
  out.printer_margin_iqd = unknownCost ? null : out.printer_net_iqd - cogs;
  return out;
}

export interface ServiceClaimsSummary {
  /** Out-of-pocket costs of warranty claims, by cost day (already in general expenses). */
  warranty_cost_iqd: number;
  /** Out-of-pocket costs of Care claims, by cost day (already in general expenses). */
  care_cost_iqd: number;
  /** The Care discount approved in the period (what the customers did not pay). */
  care_benefit_given_iqd: number;
  /**
   * Phase 5: Σ the discount of the Care part offers used on the period's orders. INFORMATIONAL — a coupon discount already
   * inside the orders' figures. Phase 8: by the DELIVERY day of DELIVERED orders, like every other figure of the period
   * (it was the order's creation day, undelivered orders included). 0 without 0243.
   */
  care_part_discount_iqd: number;
  /** Phase 8: serviced printer units whose bought warranty / Levo Care is in force today (not a period figure). null without the columns. */
  in_force: { warranty_units: number; care_units: number } | null;
  /**
   * Phase 8 «جوائز سحب ليفو كير»: the draw prizes DELIVERED in the period — how many, and their goods cost when the caller
   * passed the period's lines (null: not asked, or a prize line with no known cost). INFORMATIONAL: that cost is already
   * the goods cost of its gift order; shares are unchanged (ruling R2). null without 0244.
   */
  draw_prizes: { count: number; cost_iqd: number | null } | null;
  /** The co-pay collected in the period: service income (account 4300), added to the period's net. */
  copay_iqd: number;
  /** Claims with a live cost in the period. */
  count: number;
  /** Completed inspections (printers) in the period. */
  inspections_done: number;
  /** The owner's labour figure per inspection, or null (not configured). */
  inspection_labor_iqd: number | null;
  /** inspections_done × inspection_labor_iqd, report-only; null when not configured. */
  inspection_labor_total_iqd: number | null;
  /** Costs already inside general_expenses_iqd: shown, never subtracted a second time. */
  included_in_general_expenses: true;
}

/** The owner's inspection labour figure from the stored `printerServices` setting's draft (report-only), or null. */
export function laborFromSetting(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  try {
    const v = (JSON.parse(text) as { draft?: { inspection?: { labor_iqd?: unknown } } })?.draft?.inspection?.labor_iqd;
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The period's claims summary; null on a database without 0236 (CLAUDE.md rule 2). ONE statement — the owner's
 * labour figure rides it (read from the price list's draft) unless the caller passes one. `installed` lets a
 * caller that already probed the schema skip the probe (the operations report's statement budget).
 */
export async function serviceClaimsSummary(
  db: D1Database, r: { from: string; to: string },
  opts: { laborIqd?: number | null; installed?: boolean; lines?: ReadonlyArray<{ id: string; cogs_iqd: number | null }> } = {}
): Promise<ServiceClaimsSummary | null> {
  if (!(opts.installed ?? (await careClaimsInstalled(db)))) return null;
  // A cost's kind is its CLAIM's kind at report time (warranty_claims.claim_kind), not the kind copied onto the cost
  // when it was recorded: a cost recorded before the desk turned the claim into a Care claim (or after its Care was
  // voided) is reported with the claim as it now stands. The recorded expense itself — its category, its journal,
  // its period — is never rewritten (a closed period's books stay as closed).
  const kindOf = `(CASE WHEN (SELECT wc.claim_kind FROM warranty_claims wc WHERE wc.id = sc.claim_id) = 'care' THEN 'care' ELSE 'warranty' END )`;
  // Phase 5 (0243): the discount of the Care part offers USED on orders of the period. INFORMATIONAL: it is a coupon
  // discount, already inside the orders' own figures. Phase 8: counted on the order's DELIVERY day and only once it is
  // delivered, as the orders' own figures are. Rides the same ONE statement; a database without 0243 reads 0.
  const partDiscount = `(SELECT COALESCE(SUM(x.amount_iqd), 0) FROM care_part_grants g
          JOIN coupon_redemption_extras x ON x.coupon_id = g.coupon_id AND x.state = 'active'
          JOIN orders po ON po.id = x.order_id
         WHERE po.status = 'delivered' AND date(po.delivered_at, '+3 hours') BETWEEN ?1 AND ?2)`;
  // Phase 8: what is in force TODAY on serviced printers (the unit's own warranty end; Care = delivery + the frozen
  // whole cover), a closed or replaced unit left out; and the draw prizes delivered in the period (their order lines).
  const live = `u.delivered_at IS NOT NULL AND u.warranty_closed_at IS NULL AND u.replaced_by_unit_id IS NULL AND i.services_snapshot IS NOT NULL AND json_valid(i.services_snapshot)`;
  const careMonths = `COALESCE(NULLIF(json_extract(i.services_snapshot,'$.care_total_months'),0), COALESCE(json_extract(i.services_snapshot,'$.warranty_months'),0) + COALESCE(json_extract(i.services_snapshot,'$.care_months'),0))`;
  const inForce = `(SELECT COUNT(*) FROM order_item_units u JOIN order_items i ON i.id = u.order_item_id
          WHERE ${live} AND COALESCE(json_extract(i.services_snapshot,'$.warranty_months'),0) > 0 AND u.warranty_end_at > ?3) AS warranty_in_force,
        (SELECT COUNT(*) FROM order_item_units u JOIN order_items i ON i.id = u.order_item_id
          WHERE ${live} AND COALESCE(json_extract(i.services_snapshot,'$.care_months'),0) > 0
            AND datetime(u.delivered_at, '+' || ${careMonths} || ' months') > datetime(?3)) AS care_in_force`;
  const prizes = `(SELECT json_group_array(ge.order_item_id) FROM care_draws d JOIN gift_entitlements ge ON ge.id = d.gift_id
          JOIN orders go ON go.id = ge.order_id
         WHERE d.state = 'confirmed' AND ge.order_item_id IS NOT NULL AND go.status = 'delivered' AND date(go.delivered_at, '+3 hours') BETWEEN ?1 AND ?2) AS draw_prize_lines`;
  const read = (part: string, force: string, prize: string) => db
    .prepare(
      `SELECT
        ${part} AS care_part_discount_iqd,
        ${force},
        ${prize},
        (SELECT COALESCE(SUM(sc.amount_iqd), 0) FROM service_claim_costs sc WHERE sc.voided_at IS NULL AND ${kindOf} = 'warranty' AND sc.cost_day BETWEEN ?1 AND ?2) AS warranty_cost_iqd,
        (SELECT COALESCE(SUM(sc.amount_iqd), 0) FROM service_claim_costs sc WHERE sc.voided_at IS NULL AND ${kindOf} = 'care' AND sc.cost_day BETWEEN ?1 AND ?2) AS care_cost_iqd,
        (SELECT COUNT(DISTINCT claim_id) FROM service_claim_costs WHERE voided_at IS NULL AND cost_day BETWEEN ?1 AND ?2) AS claims,
        (SELECT COALESCE(SUM(benefit_iqd), 0) FROM care_claim_benefits WHERE state = 'approved' AND decided_day BETWEEN ?1 AND ?2) AS benefit_iqd,
        (SELECT COALESCE(SUM(copay_iqd), 0) FROM care_claim_benefits WHERE state = 'approved' AND copay_collected_day BETWEEN ?1 AND ?2) AS copay_iqd,
        (SELECT COALESCE(SUM(qty), 0) FROM order_service_tasks WHERE kind = 'inspection' AND status = 'done' AND date(done_at, '+3 hours') BETWEEN ?1 AND ?2) AS inspections,
        (SELECT value FROM admin_settings WHERE key = 'printerServices') AS services_setting`
    )
    .bind(r.from, r.to, new Date().toISOString())
    .first<Record<string, unknown>>();
  // A database behind one of the optional tables / columns (0178, 0243, 0244): those figures read as absent, the rest stands.
  const row = await read(partDiscount, inForce, prizes).catch((e: unknown) => {
    if (isSchemaMissing(e)) return read('0', 'NULL AS warranty_in_force, CASE WHEN ?3 IS NULL THEN NULL END AS care_in_force', 'NULL AS draw_prize_lines');
    throw e;
  });
  let prizeIds: string[] | null = null;
  try { prizeIds = typeof row?.draw_prize_lines === 'string' ? (JSON.parse(row.draw_prize_lines) as unknown[]).map(String) : null; } catch { prizeIds = null; }
  const prizeCost = (): number | null => {
    if (!prizeIds || !opts.lines) return null;
    let total = 0;
    for (const id of prizeIds) { const l = opts.lines.find((x) => x.id === id); if (!l || l.cogs_iqd === null) return null; total += Math.trunc(n(l.cogs_iqd)); }
    return total;
  };
  const done = Math.trunc(n(row?.inspections));
  const given = opts.laborIqd === undefined ? laborFromSetting(row?.services_setting) : opts.laborIqd;
  const labor = typeof given === 'number' && Number.isSafeInteger(given) && given >= 0 ? given : null;
  return {
    warranty_cost_iqd: Math.trunc(n(row?.warranty_cost_iqd)),
    care_cost_iqd: Math.trunc(n(row?.care_cost_iqd)),
    care_benefit_given_iqd: Math.trunc(n(row?.benefit_iqd)),
    care_part_discount_iqd: Math.trunc(n(row?.care_part_discount_iqd)),
    in_force: row?.warranty_in_force === null || row?.warranty_in_force === undefined ? null : { warranty_units: Math.trunc(n(row.warranty_in_force)), care_units: Math.trunc(n(row.care_in_force)) },
    draw_prizes: prizeIds ? { count: prizeIds.length, cost_iqd: prizeCost() } : null,
    copay_iqd: Math.trunc(n(row?.copay_iqd)),
    count: Math.trunc(n(row?.claims)),
    inspections_done: done,
    inspection_labor_iqd: labor,
    inspection_labor_total_iqd: labor === null ? null : done * labor,
    included_in_general_expenses: true,
  };
}

/**
 * The co-pays collected in the period by Baghdad day (the same rows as `copay_iqd` above) — what the dollar display converts
 * at each day's rate, as it converts the general expenses by their day. Empty on a database without 0236.
 */
export async function serviceIncomeDays(db: D1Database, r: { from: string; to: string }): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!(await careClaimsInstalled(db))) return out;
  const rows = await db
    .prepare(`SELECT copay_collected_day AS day, COALESCE(SUM(copay_iqd), 0) AS total FROM care_claim_benefits
      WHERE state = 'approved' AND copay_collected_day BETWEEN ?1 AND ?2 GROUP BY copay_collected_day`)
    .bind(r.from, r.to)
    .all<{ day: string; total: number }>();
  for (const row of rows.results ?? []) { const v = Math.trunc(n(row.total)); if (v) out.set(String(row.day), v); }
  return out;
}
