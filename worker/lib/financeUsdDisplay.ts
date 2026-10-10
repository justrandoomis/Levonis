/**
 * «الأرباح والتكاليف» IN US DOLLARS — DISPLAY ONLY (design P-A §8; owner brief
 * 2026-10-09, "Accounting Currency": «عند اختيار USD: تغيير عرض فقط؛ لا تغير
 * البيانات الأصلية، القيود، تكلفة الدفعة، الأرباح المحفوظة، الطلبات»).
 *
 * Pure. The accounting stays in the dinars recorded at the time; this module
 * only expresses them in integer US cents at a rate the caller chose (the
 * shop's rate in force when the order was placed — worker/lib/fx/historyRate).
 * It writes nothing and changes no IQD field of any answer.
 *
 * THE CENT RULES (fit #18):
 *   - every ADDITIVE source field converts on its own, exactly, rounding half
 *     away from zero to the cent (−1,250 IQD at 2,000 is −63 cents);
 *   - every DERIVED field — retained revenue, gross and contribution profit,
 *     the profit basis, owner net, net after the report deductions — is
 *     recomputed from those cents with the SAME formula the IQD figure uses,
 *     so revenue − cost = profit holds to the cent on every row;
 *   - groups and totals are SUMS of row cents, never a re-conversion, and a
 *     null anywhere in a column makes the sum null («—», never 0);
 *   - margins stay computed from IQD; the CSV stays IQD.
 * The client formats the integers with `formatUsdCents` — "$1,234.56".
 */
type Row = Record<string, unknown>;
export type Cents = Record<string, number | null>;

const RATE = /^([0-9]{1,12})(?:\.([0-9]{1,12}))?$/;

/** IQD → integer US cents at `rate` (IQD per USD), exact, half away from zero. Null for an unusable input. */
export function iqdToCents(iqd: unknown, rate: string): number | null {
  if (iqd === null || iqd === undefined) return null;
  const amount = typeof iqd === 'number' ? iqd : Number(iqd);
  if (!Number.isSafeInteger(amount)) return null;
  const m = RATE.exec(rate);
  if (!m) return null;
  const frac = m[2] ?? '';
  const den = BigInt(m[1]! + frac);
  if (den === 0n) return null;
  const num = BigInt(Math.abs(amount)) * 100n * 10n ** BigInt(frac.length);
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n;
  const cents = Number(q);
  if (!Number.isSafeInteger(cents)) return null;
  return amount < 0 ? -cents : cents;
}

/** The dinar fields converted one by one. */
export const ADDITIVE_IQD_FIELDS = [
  'net_goods_iqd', 'refund_iqd', 'cogs_iqd', 'shipping_income_iqd', 'cod_tax_iqd', 'direct_cost_iqd', 'wages_iqd',
  'materials_iqd', 'manual_direct_iqd', 'courier_fee_iqd', 'payment_fee_iqd', 'promotion_iqd', 'investor_iqd',
  'collected_iqd', 'collection_difference_iqd', 'coupon_iqd', 'price_protection_iqd',
] as const;

const cent = (field: string) => field.replace(/_iqd$/, '_cents');
const v = (c: Cents, field: string): number | null => c[cent(field)] ?? null;
function combine(c: Cents, plus: string[], minus: string[]): number | null {
  let total = 0;
  for (const f of plus) { const x = v(c, f); if (x === null) return null; total += x; }
  for (const f of minus) { const x = v(c, f); if (x === null) return null; total -= x; }
  return total;
}

/** The derived fields, in dependency order, each with the formula its IQD twin uses (orderProfit.refreshProfit, addInvestors, the overlay). */
const DERIVED: ReadonlyArray<readonly [string, (c: Cents) => number | null]> = [
  ['retained_revenue_iqd', (c) => combine(c, ['net_goods_iqd'], ['refund_iqd'])],
  ['refunded_iqd', (c) => v(c, 'refund_iqd')],
  ['gross_profit_iqd', (c) => combine(c, ['retained_revenue_iqd'], ['cogs_iqd'])],
  ['contribution_profit_iqd', (c) => combine(c, ['gross_profit_iqd', 'shipping_income_iqd', 'cod_tax_iqd'], ['direct_cost_iqd', 'manual_direct_iqd', 'courier_fee_iqd', 'payment_fee_iqd'])],
  ['profit_basis_iqd', (c) => v(c, 'contribution_profit_iqd')],
  ['owner_net_iqd', (c) => combine(c, ['profit_basis_iqd'], ['promotion_iqd', 'investor_iqd'])],
  ['net_after_report_adjustments_iqd', (c) => combine(c, ['owner_net_iqd'], ['coupon_iqd', 'price_protection_iqd'])],
];

/**
 * One row (an order's totals or one line) in cents. A field the row does not
 * carry is left out; a field that is null in dinars is null in cents. An
 * `override` replaces one additive field's cents (FX-6: a line's cost of goods
 * at its batches' own purchase-time rates) BEFORE the derived fields are
 * recomputed, so revenue − cost = profit still holds to the cent.
 */
export function centsOf(row: Row, rate: string, override: Partial<Record<(typeof ADDITIVE_IQD_FIELDS)[number], number>> = {}): Cents {
  const out: Cents = {};
  for (const f of ADDITIVE_IQD_FIELDS) {
    if (!(f in row)) continue;
    const forced = override[f];
    out[cent(f)] = row[f] === null ? null : forced !== undefined ? forced : iqdToCents(row[f] ?? 0, rate);
  }
  for (const [f, formula] of DERIVED) if (f in row) out[cent(f)] = row[f] === null || row[f] === undefined ? null : formula(out);
  return out;
}

/** The parts of a profit line this module reads to cost it at its batches' rates. */
export interface BatchCostedLine {
  cogs_iqd: number | null;
  allocations?: ReadonlyArray<{ lot_id: string; cogs_iqd: number | null; returned_qty?: number; returned_cogs_iqd: number | null; late_cost_iqd: number }>;
}

/**
 * FX-6 (FX plan §17, §19; the profit page's USD view): a line's cost of goods
 * in cents at the purchase-time USD/IQD its batches RECORDED — each FIFO
 * allocation's dinars (what was consumed, less what came back, plus a later
 * owner reconciliation of the lot) at its own lot's rate, summed. Null — the
 * caller then converts at the order's rate, as before — unless every
 * allocation's lot has a recorded rate and the allocations add up EXACTLY to
 * the line's cost (a manual cost correction, an unknown return or a legacy
 * refund breaks that, and such a line is never half-converted).
 */
export function batchCogsCents(line: BatchCostedLine, lotRates: ReadonlyMap<string, string>): number | null {
  const allocations = line.allocations ?? [];
  if (line.cogs_iqd === null || !allocations.length) return null;
  let iqd = 0, cents = 0;
  for (const a of allocations) {
    const rate = lotRates.get(a.lot_id);
    if (!rate || a.cogs_iqd === null) return null;
    const returned = a.returned_cogs_iqd ?? ((a.returned_qty ?? 0) > 0 ? null : 0);
    if (returned === null) return null;
    const own = a.cogs_iqd - returned + (a.late_cost_iqd ?? 0);
    const c = iqdToCents(own, rate);
    if (c === null) return null;
    iqd += own;
    cents += c;
  }
  return iqd === line.cogs_iqd ? cents : null;
}

/** Column sums of cents; a null anywhere in a column makes it null (as the IQD `sumRows` does). */
export function sumCents(rows: readonly Cents[]): Cents {
  const out: Cents = {};
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  for (const k of keys) out[k] = rows.some((r) => r[k] === null) ? null : rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  return out;
}

/** The overview's revenue / cost / owner net in cents — `chartAmounts` of the workspace route, on cents. */
export function chartCents(t: Cents, general: number, unallocated: number, truncated: boolean) {
  const n = (f: string) => v(t, f) ?? 0;
  const revenue = n('retained_revenue_iqd') + n('shipping_income_iqd') + n('cod_tax_iqd');
  const cost = v(t, 'profit_basis_iqd') === null || truncated ? null
    : n('cogs_iqd') + n('direct_cost_iqd') + n('manual_direct_iqd') + n('courier_fee_iqd') + n('payment_fee_iqd') + n('promotion_iqd') + general + unallocated;
  return {
    revenue_cents: revenue,
    cost_cents: cost,
    owner_net_cents: v(t, 'owner_net_iqd') === null || truncated ? null : n('owner_net_iqd') - general - unallocated,
    investor_cents: v(t, 'investor_iqd') === null || truncated ? null : n('investor_iqd'),
  };
}

/** The cost composition of the overview, in cents, mirroring the IQD one. */
export function expenseCompositionCents(t: Cents, general: number, unallocated: number, pending: boolean, truncated: boolean) {
  const n = (f: string) => v(t, f) ?? 0;
  return [
    { key: 'goods', amount_cents: v(t, 'cogs_iqd') === null || truncated ? null : n('cogs_iqd') },
    { key: 'wages', amount_cents: pending || truncated ? null : n('wages_iqd') },
    { key: 'materials', amount_cents: pending || truncated ? null : n('materials_iqd') },
    { key: 'other', amount_cents: pending || truncated ? null : n('direct_cost_iqd') - n('wages_iqd') - n('materials_iqd') + n('manual_direct_iqd') },
    { key: 'delivery', amount_cents: truncated ? null : n('courier_fee_iqd') + n('payment_fee_iqd') },
    { key: 'promotion', amount_cents: truncated ? null : n('promotion_iqd') + unallocated },
    { key: 'general', amount_cents: general },
  ];
}

/** A database timestamp ('…Z', '+hh:mm' or SQLite's bare 'YYYY-MM-DD HH:MM:SS', which is UTC) as epoch ms. */
export function instantOf(value: unknown): number | null {
  const at = String(value ?? '').trim().replace(' ', 'T');
  if (!at) return null;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(at) ? at : `${at}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** The first instant of a Baghdad calendar day ('YYYY-MM-DD'), epoch ms. */
export function baghdadDayStart(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00+03:00`);
  return Number.isFinite(ms) ? ms : null;
}
