/**
 * «تفاصيل السعر» — THE ORDER'S MONEY, EVERY PART NAMED, ADDING UP TO THE TOTAL
 * (owner, 2026-11-21; DECISIONS row 364).
 *
 * The order screens used to print «رسوم (زيادة البيع المباشر/شحن مسبق/ضمان)» =
 * subtotal − merchandise, which since «خصص طابعتك» also held the printer's
 * services and the membership bought with the order; the membership discount
 * taken after the subtotal was in no row at all, and a Levo Care part offer was
 * folded into «كوبون». A member's breakdown therefore did not add up.
 *
 * This is ONE pure reading of the stored order and its stored lines — nothing
 * is re-priced and no live rule is consulted. The rows are signed as they
 * enter the total, and
 *
 *     Σ rows.amount_iqd === orders.total_iqd
 *
 * for every order the checkout wrote (tests/orderBreakdownSums.test.ts). Should
 * a stored order not reconcile (a hand-edited legacy row), the difference is
 * its own row (`unexplained`) rather than a figure quietly bent to fit.
 *
 * Customer figures only: prices, fees and discounts the customer was shown.
 * No cost, margin, commission or investor figure is read here.
 */
import { safeParse } from './types';

export type BreakdownKey =
  /** The goods at their price: printers at the catalogue price, parts, kits, add-ons. */
  | 'goods'
  /** The printer services of every serviced line: Σ (fee − what the price already included) × qty. May be negative (Just Printer under the price anchor). */
  | 'printer_services'
  /** The membership bought with the order (0235). */
  | 'membership'
  /** Pre-order transport commission, the direct-sale extra, a legacy warranty plan. */
  | 'other_fees'
  /** The member's discount taken after the subtotal. */
  | 'membership_discount'
  /** The typed code or the reward coupons (never the Care part offer). */
  | 'coupon'
  /** «خصم ليفو كير على قطعة» — the Levo Care part offers this order used. */
  | 'care_offer'
  | 'points'
  /** The printers' own home delivery (the `printer_service` shipping components). */
  | 'printer_delivery'
  /** Every other delivery charge. */
  | 'delivery'
  | 'cod_tax'
  | 'price_adjustment'
  | 'unexplained';

export interface BreakdownRow {
  key: BreakdownKey;
  /** Signed, as it enters the total: a discount is negative. */
  amount_iqd: number;
}

export interface OrderBreakdown {
  rows: BreakdownRow[];
  /** goods + printer_services + membership + other_fees — the stored subtotal. */
  subtotal_iqd: number;
  total_iqd: number;
  /** True when the rows add up to the total with no `unexplained` row. */
  balanced: boolean;
  /** The printer services as charged, with the pieces the screen names. */
  services: { net_iqd: number; fee_iqd: number; anchor_iqd: number; lines: number } | null;
  /** The coupon row's own facts: its code (null for the Care offer alone or a pool) and how many reward coupons were pooled. */
  coupon: { code: string | null; pool: number } | null;
  /** Delivery: charged in full, or waived. `printer_units` = printers delivered to the home. */
  delivery: { waived: boolean; printer_units: number; printer_delivery: 'economy' | 'personal' | 'mixed' | null };
}

type Row = Record<string, unknown>;
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** The services part of one line as charged per unit: fee − what the catalogue price already included (phase 6). */
export function servicesNetUnitIqd(snapshot: unknown): { fee: number; anchor: number; net: number } | null {
  if (typeof snapshot !== 'string' || !snapshot) return null;
  const v = safeParse<Row | null>(snapshot, null);
  if (!v || typeof v !== 'object') return null;
  const fee = int(v.fee_iqd);
  const anchor = typeof v.anchor_fee_iqd === 'number' ? Math.max(0, int(v.anchor_fee_iqd)) : 0;
  return { fee, anchor, net: fee - anchor };
}

export function orderBreakdown(o: Row, items: readonly Row[], merchandiseIqd: number): OrderBreakdown {
  const subtotal = int(o.subtotal_iqd);
  const total = int(o.total_iqd);
  const top = items.filter((it) => !it.bundle_parent_item_id);

  let membership = 0;
  let servicesNet = 0;
  let servicesFee = 0;
  let servicesAnchor = 0;
  let servicesAboveGoods = 0;
  let servicedLines = 0;
  for (const it of top) {
    const qty = Math.max(0, int(it.qty));
    if (it.line_kind === 'membership') {
      membership += int(it.line_total_iqd);
      continue;
    }
    const s = servicesNetUnitIqd(it.services_snapshot);
    if (!s) continue;
    servicedLines += 1;
    servicesNet += s.net * qty;
    servicesFee += s.fee * qty;
    servicesAnchor += s.anchor * qty;
    // What `subtotal − merchandise` holds of this line: the goods base of an anchored line bought below
    // Smart is the price charged, so a negative net is no part of the stored fees.
    servicesAboveGoods += Math.max(0, s.net) * qty;
  }
  const otherFees = Math.max(0, subtotal - int(merchandiseIqd) - membership - servicesAboveGoods);
  const goods = subtotal - membership - servicesNet - otherFees;

  const benefit = safeParse<Row | null>(o.benefit_snapshot, null);
  const memberDiscount = Math.max(0, int(benefit && typeof benefit === 'object' ? benefit.line_discount_iqd : 0));

  const coupon = safeParse<Row | null>(o.coupon_snapshot, null);
  const couponAll = coupon && typeof coupon === 'object' ? Math.max(0, int(coupon.discount_iqd)) : 0;
  const care = coupon && typeof coupon === 'object' ? Math.min(couponAll, Math.max(0, int(coupon.care_offer_discount_iqd))) : 0;
  const couponOwn = couponAll - care;
  const pool = coupon && Array.isArray(coupon.pool) ? coupon.pool.length : 0;

  const points = Math.max(0, int(o.points_discount_iqd));
  const shipping = int(o.shipping_iqd);
  const codTax = int(o.cod_tax_iqd);
  const adjustment = int(o.price_adjustment_iqd);

  // The printers' own delivery, out of the shipping quote frozen on the order. Only what was really
  // charged: a waived component is 0, and the split never exceeds the stored delivery charge.
  const method = safeParse<Row | null>(o.delivery_method_snapshot, null);
  const quote = method && typeof method === 'object' && method.quote && typeof method.quote === 'object' ? (method.quote as Row) : null;
  const components = quote && Array.isArray(quote.components) ? (quote.components as Row[]) : [];
  let printerDelivery = 0;
  let printerUnits = 0;
  const kinds = new Set<string>();
  for (const comp of components) {
    if (!comp || comp.kind !== 'printer_service') continue;
    printerUnits += Math.max(0, int(comp.units));
    if (comp.printer_delivery === 'economy' || comp.printer_delivery === 'personal') kinds.add(comp.printer_delivery);
    if (!comp.waived) printerDelivery += Math.max(0, int(comp.fee_iqd));
  }
  printerDelivery = Math.min(printerDelivery, Math.max(0, shipping));
  const otherDelivery = shipping - printerDelivery;

  const rows: BreakdownRow[] = [];
  const push = (key: BreakdownKey, amount: number, always = false) => {
    if (amount !== 0 || always) rows.push({ key, amount_iqd: amount });
  };
  push('goods', goods, true);
  push('printer_services', servicesNet, servicedLines > 0);
  push('membership', membership);
  push('other_fees', otherFees);
  push('membership_discount', -memberDiscount);
  push('coupon', -couponOwn);
  push('care_offer', -care);
  push('points', -points);
  // One delivery row is always drawn (0 reads «مجاني» / «استلام من المتجر» on the screen).
  push('printer_delivery', printerDelivery, printerUnits > 0);
  push('delivery', otherDelivery, printerUnits === 0);
  push('cod_tax', codTax);
  push('price_adjustment', adjustment);
  const sum = rows.reduce((n, r) => n + r.amount_iqd, 0);
  push('unexplained', total - sum);

  return {
    rows,
    subtotal_iqd: subtotal,
    total_iqd: total,
    balanced: sum === total,
    services: servicedLines > 0 ? { net_iqd: servicesNet, fee_iqd: servicesFee, anchor_iqd: servicesAnchor, lines: servicedLines } : null,
    coupon: couponOwn > 0 ? { code: pool > 1 ? null : typeof coupon?.code === 'string' && coupon.code ? coupon.code : null, pool } : null,
    delivery: {
      waived: !!o.delivery_waived,
      printer_units: printerUnits,
      printer_delivery: kinds.size === 0 ? null : kinds.size > 1 ? 'mixed' : ([...kinds][0] as 'economy' | 'personal'),
    },
  };
}
