import type { CostProfile, CostProfileId } from '../../packages/contracts/src/procurementCost';
import { allocateProcurementCharge, roundProcurementProduct } from '../../packages/contracts/src/procurementCost';
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

export function procurementAllocation(total: number, weights: number[]) {
  try { return allocateProcurementCharge(total, weights); }
  catch { throw badRequest('أدخل الوزن أو الحجم لجميع البنود قبل توزيع التكلفة', 'BAD_ALLOCATION'); }
}
