import type { CostProfile, CostProfileId, ProcurementCharge, ProcurementChargeBasis, ProcurementChargeLine } from '../../packages/contracts/src/procurementCost';
import { PROCUREMENT_CHARGE_BASES, allocateProcurementCharges, looksLikeFreight, roundProcurementProduct, type PurchaseChargePricingRole } from '../../packages/contracts/src/procurementCost';
import { badRequest } from './http';
import { decimal, whole } from './operations';

const names: Record<CostProfileId, [string, string]> = {
  germany_land: ['ألمانيا — شحن بري', 'Germany · land freight'],
  china_air: ['الصين — شحن جوي', 'China · air freight'],
  china_sea: ['الصين — شحن بحري', 'China · sea freight'],
};
export async function procurementProfiles(db: D1Database): Promise<CostProfile[]> {
  const rows = (await db.prepare('SELECT id,currency,shipping_basis,exchange_rate,shipping_rate_iqd,version FROM procurement_cost_profiles ORDER BY CASE id WHEN \'germany_land\' THEN 0 WHEN \'china_air\' THEN 1 ELSE 2 END').all<Omit<CostProfile, 'name_ar' | 'name_en'>>()).results ?? [];
  return rows.map(row => ({ ...row, name_ar: names[row.id][0], name_en: names[row.id][1] }));
}
export function procurementAmount(values: readonly (number | string)[], divisor = 1): number {
  try { return whole(roundProcurementProduct(values, divisor), 'تكلفة الشراء والشحن'); }
  catch { throw badRequest('تكلفة الشراء أو الشحن تتجاوز الحد المسموح أو دقتها غير صالحة', 'BAD_NUMBER'); }
}
export function packedMeasure(value: unknown, label: string): number {
  // Cubic millimetres need more than the generic decimal()'s 1e9 upper bound:
  // 1e9 mm³ is one CBM. Keep the full packed measurement, never net weight.
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n) || n < 0 || n > 1e15)
    throw badRequest(`${label}: أدخل قياس التغليف الصحيح`, 'BAD_NUMBER');
  return n;
}
export function profileRates(body: Record<string, unknown>) {
  return {
    exchange_rate: decimal(body.exchange_rate, 'سعر الصرف', 0.000001),
    shipping_rate_iqd: decimal(body.shipping_rate_iqd, 'تكلفة شحن الكيلو أو المتر المكعب'),
  };
}


export type PurchaseCharge = ProcurementCharge & { title: string; pricing_role: PurchaseChargePricingRole | null };
/** Only what the buyer typed for this document's own lines. A charge without a
 * name, a positive amount, or lines of this shipment to cover is refused —
 * never saved as zero, guessed, or carried in from another purchase.
 *
 * THE DOUBLE-FREIGHT GUARD (USD design §3.3): on a ROUTED document each charge
 * says whether it also feeds the pricing input «additional cost» — the route's
 * freight already enters the price from the central shipping rate, so a charge
 * that looks like freight defaults to 'excluded' until the owner confirms it is
 * not freight ('additional'). A manual document's charges never feed (null).
 * Accounting is unchanged: every charge still counts in the landed IQD. */
export function purchaseCharges(raw: unknown, keys: readonly string[], routed = false): PurchaseCharge[] {
  const rows = Array.isArray(raw) ? raw : [];
  if (rows.length > 15) throw badRequest('أضف 15 تكلفة إضافية كحد أقصى', 'BAD_CHARGE');
  return rows.map((value) => {
    const r = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) throw badRequest('اكتب اسم كل تكلفة إضافية، مثل توصيل محلي أو جمارك', 'BAD_CHARGE');
    if (title.length > 120) throw badRequest('اسم التكلفة الإضافية أطول من 120 حرفًا', 'BAD_CHARGE');
    const scope = r.scope == null || r.scope === '' ? 'shipment' : r.scope;
    if (scope !== 'shipment' && scope !== 'unit') throw badRequest(`حدد هل «${title}» للشحنة كاملة أم لكل قطعة`, 'BAD_CHARGE');
    const basis = scope === 'unit' || r.basis == null || r.basis === '' ? 'quantity' : r.basis;
    if (!PROCUREMENT_CHARGE_BASES.includes(basis as ProcurementChargeBasis)) throw badRequest('Invalid allocation method');
    const amount = whole(scope === 'unit' ? r.unit_amount_iqd : r.amount_iqd, `مبلغ «${title}» بالدينار`);
    if (amount < 1) throw badRequest(`أدخل مبلغ «${title}» أكبر من صفر، أو احذف هذه التكلفة`, 'BAD_CHARGE');
    let appliesTo: string[] | null = null;
    if (r.applies_to != null) {
      const chosen = Array.isArray(r.applies_to) && r.applies_to.every((k) => typeof k === 'string') ? [...new Set(r.applies_to as string[])] : [];
      if (!chosen.length || chosen.some((k) => !keys.includes(k)))
        throw badRequest(`اختر البنود التي تشملها «${title}» من بنود هذه الشحنة`, 'BAD_CHARGE');
      appliesTo = keys.every((k) => chosen.includes(k)) ? null : chosen;
    }
    if (r.pricing_role != null && r.pricing_role !== 'additional' && r.pricing_role !== 'excluded')
      throw badRequest(`حدد هل تدخل «${title}» في التسعير`, 'BAD_CHARGE');
    const pricing_role: PurchaseChargePricingRole | null = !routed
      ? null
      : r.pricing_role === 'additional' || r.pricing_role === 'excluded'
        ? r.pricing_role
        : looksLikeFreight(title) ? 'excluded' : 'additional';
    return { title, scope, basis: basis as ProcurementChargeBasis, applies_to: appliesTo, amount_iqd: scope === 'unit' ? 0 : amount, unit_amount_iqd: scope === 'unit' ? amount : null, pricing_role };
  });
}
/** Server-side twin of the editor preview: the same allocator, so the shares
 * shown before saving are the shares saved. */
export function purchaseChargeShares(charges: readonly PurchaseCharge[], lines: readonly ProcurementChargeLine[], missingCode: string) {
  try { return allocateProcurementCharges(charges, lines); }
  catch (error) {
    if (error instanceof RangeError && /too large/i.test(error.message))
      throw badRequest('مجموع التكاليف الإضافية يتجاوز الحد المسموح', 'BAD_NUMBER');
    throw badRequest('أدخل الوزن أو الحجم لجميع البنود التي تشملها التكلفة قبل توزيعها، أو اختر توزيعًا آخر', missingCode);
  }
}
