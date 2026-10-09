import { useLanguage } from '../../LanguageContext';
import { Row } from './ui';
import { PA_STRINGS, tri } from './displayCurrencyStrings';
import { DisplayMoney } from './displayCurrency';

/**
 * P-A F4/F5: the coupon and price-protection credits as deductions IN THIS
 * REPORT ONLY (owner question Q3, default "report only"). Shown only when one
 * of them is not zero; the note says what they do not change.
 */
export default function ReportDeductions({ totals, net, cents, compact = false }: {
  totals: { coupon_iqd?: number | null; price_protection_iqd?: number | null }; net: number | null | undefined;
  /** Server cents for the USD display (design P-A §8); absent = dinars. */
  cents?: { coupon?: number | null; credit?: number | null; net?: number | null }; compact?: boolean;
}) {
  const { loc } = useLanguage();
  const coupon = totals.coupon_iqd ?? 0, credit = totals.price_protection_iqd ?? 0;
  if (!coupon && !credit) return null;
  const negative = (x: number | null | undefined) => (x == null ? x : -x);
  return <div data-finance-report-deductions>
    {!!coupon && <Row label={tri(loc, PA_STRINGS.couponDeduction)} value={<DisplayMoney iqd={-coupon} cents={cents ? negative(cents.coupon ?? null) : undefined} />} />}
    {!!credit && <Row label={tri(loc, PA_STRINGS.priceProtectionCredit)} value={<DisplayMoney iqd={-credit} cents={cents ? negative(cents.credit ?? null) : undefined} />} />}
    <Row label={tri(loc, PA_STRINGS.netAfterReportDeductions)} value={<DisplayMoney iqd={net} cents={cents ? cents.net ?? null : undefined} />} prominent={!compact} />
    <p className="fw-note">{tri(loc, PA_STRINGS.reportOnlyNote)}</p>
  </div>;
}
