import { useLanguage } from '../../LanguageContext';
import { Row } from './ui';
import { PA_STRINGS, tri } from './displayCurrencyStrings';
import { DisplayMoney } from './displayCurrency';

/**
 * Coupons, price-protection credits and a returned in-stock trade-in credit
 * reduce both report net profit and participant shares. Shown only when one of
 * the deductions is nonzero. The period's net after them is the overview's
 * «صافي حصتك» (DECISIONS row 313).
 */
export default function ReportDeductions({ totals, net, cents, compact = false }: {
  totals: { coupon_iqd?: number | null; price_protection_iqd?: number | null; trade_in_credit_returned_iqd?: number | null }; net: number | null | undefined;
  /** Server cents for the USD display (design P-A §8); absent = dinars. */
  cents?: { coupon?: number | null; credit?: number | null; tradeIn?: number | null; net?: number | null }; compact?: boolean;
}) {
  const { loc } = useLanguage();
  const coupon = totals.coupon_iqd ?? 0, credit = totals.price_protection_iqd ?? 0, tradeIn = totals.trade_in_credit_returned_iqd ?? 0;
  if (!coupon && !credit && !tradeIn) return null;
  const negative = (x: number | null | undefined) => (x == null ? x : -x);
  return <div data-finance-report-deductions>
    {!!coupon && <Row label={tri(loc, PA_STRINGS.couponDeduction)} value={<DisplayMoney iqd={-coupon} cents={cents ? negative(cents.coupon ?? null) : undefined} />} />}
    {!!credit && <Row label={tri(loc, PA_STRINGS.priceProtectionCredit)} value={<DisplayMoney iqd={-credit} cents={cents ? negative(cents.credit ?? null) : undefined} />} />}
    {!!tradeIn && <Row label={loc('رصيد استبدال أُعيد مع مرتجع', 'Trade-in credit returned with a return', 'باڵانسی گۆڕینەوە کە لەگەڵ گەڕاندنەوە گەڕێنرایەوە')} value={<DisplayMoney iqd={-tradeIn} cents={cents ? negative(cents.tradeIn ?? null) : undefined} />} />}
    <Row label={tri(loc, PA_STRINGS.netAfterReportDeductions)} value={<DisplayMoney iqd={net} cents={cents ? cents.net ?? null : undefined} />} prominent={!compact} />
    <p className="fw-note">{tri(loc, PA_STRINGS.netProfitNote)}</p>
  </div>;
}
