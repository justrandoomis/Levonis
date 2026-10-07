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

export type ProcurementChargeBasis = 'quantity' | 'value' | 'weight' | 'volume';
export const PROCUREMENT_CHARGE_BASES: readonly ProcurementChargeBasis[] = ['quantity', 'value', 'weight', 'volume'];
/** An extra cost actually paid for this shipment: local delivery, customs,
 * transfer fees, packaging. Never the raw supplier price, and never the freight
 * a supplier route already calculates from packed weight or volume.
 * `shipment`: one amount split over the lines it covers by `basis`.
 * `unit`: `unit_amount_iqd` for every piece of the lines it covers. */
export type ProcurementCharge = {
  scope: 'shipment' | 'unit';
  amount_iqd: number;
  unit_amount_iqd: number | null;
  basis: ProcurementChargeBasis;
  /** Selection keys this charge covers; null covers every line. */
  applies_to: readonly string[] | null;
};
export type ProcurementChargeLine = { key: string; qty: number; value: number; weight_g: number; volume_mm3: number };

export const procurementSelectionKey = (s: { product_id: string; scope: string; scope_id?: string | null }) =>
  `${s.product_id}:${s.scope}:${s.scope_id ?? ''}`;

/** Each charge's whole-dinar share of each line. The editor preview and the
 * saved document both call this, so a shown share is the share that is saved.
 * Shipment shares use the largest-remainder rule above: no dinar is lost or
 * invented. A line the charge does not cover receives exactly 0. */
export function allocateProcurementCharges(charges: readonly ProcurementCharge[], lines: readonly ProcurementChargeLine[]): number[][] {
  return charges.map((charge) => {
    const covered = lines.map((line) => !charge.applies_to || charge.applies_to.includes(line.key));
    if (!covered.some(Boolean)) throw new RangeError('Procurement charge covers no line');
    if (charge.scope === 'unit') {
      const unit = charge.unit_amount_iqd;
      if (unit == null || !Number.isSafeInteger(unit) || unit < 0) throw new RangeError('Invalid procurement unit charge');
      return lines.map((line, i) => {
        const share = covered[i] ? unit * line.qty : 0;
        if (!Number.isSafeInteger(share) || share > 1e12) throw new RangeError('Procurement amount is too large');
        return share;
      });
    }
    return allocateProcurementCharge(charge.amount_iqd, lines.map((line, i) => !covered[i] ? 0
      : charge.basis === 'value' ? line.value
        : charge.basis === 'weight' ? line.qty * line.weight_g
          : charge.basis === 'volume' ? line.qty * line.volume_mm3
            : line.qty));
  });
}

/* ------------------------------------------------------------------------- *
 * Exact rationals for the pricing engine (master plan v2 §2.1-4, LD4, [C2-M4]).
 * Decimal text (supplier cost, FX, CBM, rates) is multiplied and summed as
 * BigInt numerator/denominator pairs and rounded ONCE, at the very end, by the
 * caller's rule (ceil). Nothing here ever passes through a binary float, so
 * "0.07" × "100" is exactly 7 and 855 × 1626.25 is exactly 1,390,443.75.
 * ------------------------------------------------------------------------- */

/** An exact rational number `num / den`, with `den > 0`. Never a float. */
export type ProcurementExact = { readonly num: bigint; readonly den: bigint };

const exactOf = (num: bigint, den: bigint): ProcurementExact => {
  if (den === 0n) throw new RangeError('Procurement denominator is zero');
  return den < 0n ? { num: -num, den: -den } : { num, den };
};

const bigintGcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a, y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
};

const reduceExact = (value: ProcurementExact): ProcurementExact => {
  const g = bigintGcd(value.num, value.den);
  return g > 1n ? { num: value.num / g, den: value.den / g } : value;
};

/** The exact value of a decimal TEXT (parsed by the same rule as every procurement
 * estimate), of a whole JS number, or of a bigint. A JS number must be a safe
 * integer: a fractional amount arrives as text, never as a binary float (0.1 + 0.2
 * is not 0.3). A leading '-' is accepted only with `{ signed: true }` (supplier cost
 * differences); otherwise it is a RangeError. Validate untrusted text with
 * `parseProcurementDecimal` first: this reader also takes the legacy shapes
 * `rational()` tolerates ('+1', '.5', '1e3'). */
export function procurementExact(value: number | string | bigint, opts: { signed?: boolean } = {}): ProcurementExact {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new RangeError('A fractional procurement amount must be decimal text, never a binary float');
  if (typeof value === 'bigint' || typeof value === 'number') {
    const whole = BigInt(value);
    if (whole < 0n && !opts.signed) throw new RangeError('Invalid nonnegative procurement decimal');
    return { num: whole, den: 1n };
  }
  const text = String(value).trim();
  const negative = text.startsWith('-');
  if (negative && !opts.signed) throw new RangeError('Invalid nonnegative procurement decimal');
  const [num, den] = rational(negative ? text.slice(1) : text);
  return { num: negative ? -num : num, den };
}

export interface ProcurementDecimalOptions {
  /** Accept one leading '+' or '-' (supplier cost differences). */
  signed?: boolean;
  /** Most digits before the point, leading zeros not counted. */
  maxIntDigits: number;
  /** Most digits after the point, trailing zeros not counted. */
  maxFractionDigits: number;
  /** 'positive' refuses 0 and below; 'nonnegative' refuses below 0. */
  min?: 'positive' | 'nonnegative';
}

const DECIMAL_TEXT = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * The validator for every decimal a body, a file row or a form sends to the
 * pricing engine (ENG §4.1, §5): returns the CANONICAL text the 0179 CHECKs
 * accept — digits, at most one '.', no exponent, no leading or trailing '.',
 * no '+', no leading zeros, no trailing fraction zeros, '-' only when negative —
 * or throws a RangeError. '1500.0' → '1500', '007.50' → '7.5', and with
 * `signed` '+0.50' → '0.5', '-3' → '-3', '-0' → '0'. A JS number is accepted
 * only as a safe integer (a fraction must arrive as text); a bigint as is.
 * Refused: '1e3', '.5', '5.', '1.2.3', ' ', a sign without `signed`, more digits
 * than the limits allow, and a value below `min`.
 */
export function parseProcurementDecimal(value: unknown, opts: ProcurementDecimalOptions): string {
  const { maxIntDigits, maxFractionDigits } = opts;
  if (!Number.isSafeInteger(maxIntDigits) || maxIntDigits < 1 || !Number.isSafeInteger(maxFractionDigits) || maxFractionDigits < 0)
    throw new RangeError('Invalid procurement decimal limits');
  let text: string;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'number' && Number.isSafeInteger(value)) text = String(value);
  else throw new RangeError('Invalid procurement decimal');
  if (text.length > 80) throw new RangeError('Invalid procurement decimal');
  const match = DECIMAL_TEXT.exec(text);
  if (!match) throw new RangeError('Invalid procurement decimal');
  const [, sign, intRaw, fractionRaw = ''] = match;
  if (sign && !opts.signed) throw new RangeError('Invalid nonnegative procurement decimal');
  const int = intRaw.replace(/^0+(?=\d)/, '');
  const fraction = fractionRaw.replace(/0+$/, '');
  if (int.length > maxIntDigits || fraction.length > maxFractionDigits) throw new RangeError('Procurement decimal has too many digits');
  const zero = int === '0' && !fraction;
  const negative = sign === '-' && !zero;
  if (opts.min === 'positive' && (zero || negative)) throw new RangeError('Procurement decimal must be above zero');
  if (opts.min === 'nonnegative' && negative) throw new RangeError('Procurement decimal must not be below zero');
  return `${negative ? '-' : ''}${int}${fraction ? `.${fraction}` : ''}`;
}

/** Exact sum. */
export function addProcurementExact(...values: readonly ProcurementExact[]): ProcurementExact {
  let num = 0n, den = 1n;
  for (const v of values) {
    num = num * v.den + v.num * den;
    den *= v.den;
    ({ num, den } = reduceExact({ num, den }));
  }
  return exactOf(num, den);
}

/** Exact product. */
export function mulProcurementExact(...values: readonly ProcurementExact[]): ProcurementExact {
  let num = 1n, den = 1n;
  for (const v of values) {
    num *= v.num;
    den *= v.den;
  }
  return reduceExact(exactOf(num, den));
}

/** Exact `value / divisor` for a positive whole divisor (grams → kg is `/ 1000`, mm³ → m³ is `/ 1e9`). */
export function divProcurementExact(value: ProcurementExact, divisor: bigint | number): ProcurementExact {
  const d = typeof divisor === 'bigint' ? divisor : Number.isSafeInteger(divisor) ? BigInt(divisor) : 0n;
  if (d <= 0n) throw new RangeError('Invalid procurement divisor');
  return reduceExact(exactOf(value.num, value.den * d));
}

/** The smallest integer ≥ value (whole IQD, rounded UP — never half-up). */
export function ceilProcurementExact(value: ProcurementExact): bigint {
  const q = value.num / value.den; // BigInt division truncates toward zero
  return value.num % value.den > 0n ? q + 1n : q;
}

export function compareProcurementExact(a: ProcurementExact, b: ProcurementExact): -1 | 0 | 1 {
  const left = a.num * b.den, right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Canonical decimal text of an exact value: no exponent, no '+', no trailing
 * zeros or '.', '0' for zero, '-' only when negative ('1500.0' → '1500',
 * 1,390,443.75 → '1390443.75'). Every value built from decimal inputs and whole
 * divisors of 10 terminates; anything else (a third, say) is a RangeError, so a
 * stored "exact" figure is never silently truncated. */
export function procurementExactText(value: ProcurementExact): string {
  const { num, den } = reduceExact(value);
  let rest = den, twos = 0, fives = 0;
  while (rest % 2n === 0n) { rest /= 2n; twos++; }
  while (rest % 5n === 0n) { rest /= 5n; fives++; }
  if (rest !== 1n) throw new RangeError('Procurement value is not a terminating decimal');
  const places = Math.max(twos, fives);
  const scaled = num * (10n ** BigInt(places) / den);
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
