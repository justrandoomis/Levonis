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

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export const PRINTER_SERVICE_KEYS = ['warranty', 'care', 'packaging', 'inspection', 'academy'] as const;
export type PrinterServiceKey = (typeof PRINTER_SERVICE_KEYS)[number];

export interface PrinterBreakdown {
  /** Serviced printer lines counted. */
  printer_lines: number;
  /** Their net goods less the services' part. */
  printer_net_iqd: number;
  /** What the services were priced at inside those lines (qty × the frozen per-unit fee). */
  services_gross_iqd: number;
  /** The services' share of the lines' NET goods (after coupons, points, adjustments). */
  services_net_iqd: number;
  /** services_net split per service (allocateExact over each line's frozen fees). */
  services: Record<PrinterServiceKey, number>;
  /** Owner-made filament kit lines (0235), net. */
  kits_net_iqd: number;
  /** Phase 4 (0242; DECISIONS row 355): the add-on lines sold with printers, net. 0 on a database without order_items.addon_id. */
  addons_net_iqd: number;
  /**
   * Phase 4: «خصومات الطابعة الممنوحة» — the owner's kit / add-on discounts given (Σ order_items.printer_discount_iqd,
   * net of returns: × (qty − returned_qty) / qty, floored).
   * INFORMATIONAL: already inside the lines' prices (money rule D2), never subtracted again. 0 without the column.
   */
  printer_discounts_iqd: number;
  /** The membership lines bought with a printer (0235), net. */
  membership_iqd: number;
  /** The courier's fee on these orders (finance_collections). */
  courier_fee_iqd: number;
}

interface SnapshotView { fee: number; lines: Array<{ service: string; fee_iqd: number }> }
function snapshotOf(raw: unknown): SnapshotView | null {
  if (typeof raw !== 'string' || !raw) return null;
  let v: { fee_iqd?: unknown; lines?: Array<{ service?: unknown; fee_iqd?: unknown }> } | null = null;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  return {
    fee: Math.max(0, Math.trunc(n(v.fee_iqd))),
    lines: (Array.isArray(v.lines) ? v.lines : []).map((l) => ({ service: String(l?.service ?? ''), fee_iqd: Math.max(0, Math.trunc(n(l?.fee_iqd))) })),
  };
}

/** floor(a × b / c) for non-negative integers, exact past 2^53. */
const mulDivFloor = (a: number, b: number, c: number) => Number((BigInt(Math.trunc(a)) * BigInt(Math.trunc(b))) / BigInt(Math.trunc(c)));

/** One line's split (exported for the tests): services_net = min(gross, floor(N × gross / line_total)). */
export function splitServicedLine(line: { qty: unknown; line_total_iqd: unknown; net_goods_iqd: unknown; services_snapshot: unknown }) {
  const snap = snapshotOf(line.services_snapshot);
  const N = Math.trunc(n(line.net_goods_iqd));
  const qty = Math.max(0, Math.trunc(n(line.qty)));
  const total = Math.trunc(n(line.line_total_iqd));
  const gross = snap ? qty * snap.fee : 0;
  const servicesNet = snap && total > 0 && N > 0 && gross > 0 ? Math.min(gross, mulDivFloor(N, gross, total)) : 0;
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
  return { serviced: !!snap, gross, services_net: servicesNet, printer_net: N - servicesNet, services };
}

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
    printer_lines: 0, printer_net_iqd: 0, services_gross_iqd: 0, services_net_iqd: 0,
    services: Object.fromEntries(PRINTER_SERVICE_KEYS.map((k) => [k, 0])) as Record<PrinterServiceKey, number>,
    kits_net_iqd: 0, addons_net_iqd: 0, printer_discounts_iqd: 0, membership_iqd: 0, courier_fee_iqd: 0,
  };
}

/** The breakdown of these orders (each base's lines as the profit engine priced them). */
export function printerBreakdown(bases: Pick<OrderProfitBase, 'lines' | 'totals'>[]): PrinterBreakdown {
  const out = emptyBreakdown();
  for (const b of bases) {
    out.courier_fee_iqd += Math.trunc(n(b.totals?.courier_fee_iqd));
    for (const l of b.lines ?? []) {
      const row = l as unknown as Record<string, unknown>;
      if (row.line_kind === 'membership') { out.membership_iqd += Math.trunc(n(row.net_goods_iqd)); continue; }
      // Phase 4: the owner's discount given on a kit / add-on line (report-only; absent column = 0), net of returns
      // like the line's own net: × (qty − returned_qty) / qty, floored (the profit engine's returned_qty).
      out.printer_discounts_iqd += keptDiscount(row);
      if (row.kit_id) { out.kits_net_iqd += Math.trunc(n(row.net_goods_iqd)); continue; }
      if (row.addon_id) { out.addons_net_iqd += Math.trunc(n(row.net_goods_iqd)); continue; }
      if (!row.services_snapshot) continue;
      const s = splitServicedLine(row as never);
      if (!s.serviced) continue;
      out.printer_lines += 1;
      out.printer_net_iqd += s.printer_net;
      out.services_gross_iqd += s.gross;
      out.services_net_iqd += s.services_net;
      for (const k of PRINTER_SERVICE_KEYS) out.services[k] += s.services[k];
    }
  }
  return out;
}

export interface ServiceClaimsSummary {
  /** Out-of-pocket costs of warranty claims, by cost day (already in general expenses). */
  warranty_cost_iqd: number;
  /** Out-of-pocket costs of Care claims, by cost day (already in general expenses). */
  care_cost_iqd: number;
  /** The Care discount approved in the period (what the customers did not pay). */
  care_benefit_given_iqd: number;
  /** Phase 5: Σ the discount of the Care part offers used on the period's orders (order day). INFORMATIONAL — a coupon discount already inside the orders' figures. 0 without 0243. */
  care_part_discount_iqd: number;
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
  db: D1Database, r: { from: string; to: string }, opts: { laborIqd?: number | null; installed?: boolean } = {}
): Promise<ServiceClaimsSummary | null> {
  if (!(opts.installed ?? (await careClaimsInstalled(db)))) return null;
  // A cost's kind is its CLAIM's kind at report time (warranty_claims.claim_kind), not the kind copied onto the cost
  // when it was recorded: a cost recorded before the desk turned the claim into a Care claim (or after its Care was
  // voided) is reported with the claim as it now stands. The recorded expense itself — its category, its journal,
  // its period — is never rewritten (a closed period's books stay as closed).
  const kindOf = `(CASE WHEN (SELECT wc.claim_kind FROM warranty_claims wc WHERE wc.id = sc.claim_id) = 'care' THEN 'care' ELSE 'warranty' END )`;
  // Phase 5 (0243): the discount of the Care part offers USED on orders of the period (by the order's Baghdad day;
  // a cancelled order released its use and is not counted). INFORMATIONAL: it is a coupon discount, already inside
  // the orders' own figures. Rides the same ONE statement; a database without 0243 reads 0 (one retry, there only).
  const partDiscount = `(SELECT COALESCE(SUM(x.amount_iqd), 0) FROM care_part_grants g
          JOIN coupon_redemption_extras x ON x.coupon_id = g.coupon_id AND x.state = 'active'
          JOIN orders po ON po.id = x.order_id
         WHERE date(po.created_at, '+3 hours') BETWEEN ?1 AND ?2)`;
  const read = (part: string) => db
    .prepare(
      `SELECT
        ${part} AS care_part_discount_iqd,
        (SELECT COALESCE(SUM(sc.amount_iqd), 0) FROM service_claim_costs sc WHERE sc.voided_at IS NULL AND ${kindOf} = 'warranty' AND sc.cost_day BETWEEN ?1 AND ?2) AS warranty_cost_iqd,
        (SELECT COALESCE(SUM(sc.amount_iqd), 0) FROM service_claim_costs sc WHERE sc.voided_at IS NULL AND ${kindOf} = 'care' AND sc.cost_day BETWEEN ?1 AND ?2) AS care_cost_iqd,
        (SELECT COUNT(DISTINCT claim_id) FROM service_claim_costs WHERE voided_at IS NULL AND cost_day BETWEEN ?1 AND ?2) AS claims,
        (SELECT COALESCE(SUM(benefit_iqd), 0) FROM care_claim_benefits WHERE state = 'approved' AND decided_day BETWEEN ?1 AND ?2) AS benefit_iqd,
        (SELECT COALESCE(SUM(copay_iqd), 0) FROM care_claim_benefits WHERE state = 'approved' AND copay_collected_day BETWEEN ?1 AND ?2) AS copay_iqd,
        (SELECT COALESCE(SUM(qty), 0) FROM order_service_tasks WHERE kind = 'inspection' AND status = 'done' AND date(done_at, '+3 hours') BETWEEN ?1 AND ?2) AS inspections,
        (SELECT value FROM admin_settings WHERE key = 'printerServices') AS services_setting`
    )
    .bind(r.from, r.to)
    .first<Record<string, unknown>>();
  const row = await read(partDiscount).catch((e: unknown) => {
    if (isSchemaMissing(e)) return read('0');
    throw e;
  });
  const done = Math.trunc(n(row?.inspections));
  const given = opts.laborIqd === undefined ? laborFromSetting(row?.services_setting) : opts.laborIqd;
  const labor = typeof given === 'number' && Number.isSafeInteger(given) && given >= 0 ? given : null;
  return {
    warranty_cost_iqd: Math.trunc(n(row?.warranty_cost_iqd)),
    care_cost_iqd: Math.trunc(n(row?.care_cost_iqd)),
    care_benefit_given_iqd: Math.trunc(n(row?.benefit_iqd)),
    care_part_discount_iqd: Math.trunc(n(row?.care_part_discount_iqd)),
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
