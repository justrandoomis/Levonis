/** Shared wire contract and decimal-exact arithmetic for procurement estimates. */
export type CostProfileId = 'germany_land' | 'china_air' | 'china_sea';
export type CostProfile = {
  id: CostProfileId;
  name_ar: string;
  name_en: string;
  currency: 'EUR' | 'CNY';
  shipping_basis: 'weight' | 'volume';
  exchange_rate: number | null;
  shipping_rate_iqd: number | null;
  version: number;
};
export type ProcurementSelectionDefault = {
  profile_id: CostProfileId;
  currency: 'EUR' | 'CNY';
  source_unit_amount: number | null;
  weight_g: number;
  volume_mm3: number;
  updated_at: string;
};

function rational(value: number | string): [bigint, bigint] {
  const text = String(value).trim().replace(/^\+/, '').replace(/^\./, '0.');
  if (text.length > 80 || !Number.isFinite(Number(text)) || Number(text) < 0)
    throw new RangeError('Invalid nonnegative procurement decimal');
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw new RangeError('Invalid procurement decimal');
  const places = (match[2]?.length ?? 0) - Number(match[3] ?? 0);
  if (Math.abs(places) > 24) throw new RangeError('Procurement precision is too large');
  const digits = BigInt(`${match[1]}${match[2] ?? ''}`);
  return places >= 0 ? [digits, 10n ** BigInt(places)] : [digits * 10n ** BigInt(-places), 1n];
}

/** Round once, half up, in whole IQD. Decimal inputs never pass through binary
 * multiplication, so 855 × 1626.25 and CBM freight use identical server/UI math. */
export function roundProcurementProduct(values: readonly (number | string)[], divisor = 1): number {
  if (!Number.isSafeInteger(divisor) || divisor < 1) throw new RangeError('Invalid procurement divisor');
  let numerator = 1n, denominator = BigInt(divisor);
  for (const value of values) {
    const [n, d] = rational(value);
    numerator *= n;
    denominator *= d;
  }
  const result = Number((numerator * 2n + denominator) / (denominator * 2n));
  if (!Number.isSafeInteger(result) || result > 1e12) throw new RangeError('Procurement amount is too large');
  return result;
}

/** Same integer largest-remainder policy as warehouse operations. Scaling the
 * basis to thousandths keeps preview and committed extra-charge shares equal. */
export function allocateProcurementCharge(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || total > 1e12 || !weights.length || weights.some(w => !Number.isFinite(w) || w < 0))
    throw new RangeError('Invalid procurement allocation');
  const scaled = weights.map(w => BigInt(Math.round(w * 1000)));
  const sum = scaled.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    if (total === 0) return weights.map(() => 0);
    throw new RangeError('Missing procurement allocation basis');
  }
  const shares = scaled.map(w => Number(BigInt(total) * w / sum));
  const ranked = scaled.map((w, i) => ({ i, rem: BigInt(total) * w % sum }))
    .sort((a, b) => a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1);
  let left = total - shares.reduce((a, b) => a + b, 0);
  for (const part of ranked) { if (left-- <= 0) break; shares[part.i]++; }
  return shares;
}

/** Only promote an invoice average when it is an exact editable unit price.
 * Repeating or >6-place averages must stay unknown: rounding the suggestion
 * can change the next purchase by a dinar at an FX half boundary. */
export function exactProcurementUnitDefault(sourceTotal: number | string, qty: number): number | null {
  if (!Number.isSafeInteger(qty) || qty < 1) return null;
  const [numerator, denominator] = rational(sourceTotal);
  const unitDenominator = denominator * BigInt(qty);
  const scaled = numerator * 1_000_000n;
  if (scaled % unitDenominator !== 0n) return null;
  const candidate = Number(scaled / unitDenominator) / 1_000_000;
  if (!Number.isFinite(candidate)) return null;
  const [unitNumerator, unitDivisor] = rational(candidate);
  return unitNumerator * BigInt(qty) * denominator === numerator * unitDivisor ? candidate : null;
}
