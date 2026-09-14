/**
 * §7 — "WHAT WOULD THIS CART COST?", answered by the server, through the same
 * functions a real checkout uses.
 *
 * The owner picks a tier, some products with quantities, a delivery method and
 * a payment method, and gets the whole breakdown back: per line the regular
 * price, the member price, the saving, WHICH RULE produced it and WHICH CEILING
 * bound it; then the delivery fee with its waiver; then the cash-on-delivery
 * tax with its exemption. Nothing on this screen is computed here — not one
 * subtraction — because a second arithmetic in the browser is exactly how a
 * simulator ends up disagreeing with the till.
 *
 * `assumptions` and the shipping `reasons` are printed as the plain sentences
 * the server sends. They are the part that explains an answer the owner did not
 * expect, and rewording them here would break that.
 */
import { useMemo, useState } from 'react';
import { Play, Trash2 } from 'lucide-react';
import * as T from '../adminProducts/theme';
import ProductPicker from '../adminProducts/form/ProductPicker';
import { api, formatIqd } from '../../lib/api';
import { useWallet } from '../../WalletContext';
import { Badge, Table, cell, errMsg, useLoc } from '../adminTaxonomy/shared';
import {
  CAP_LABEL,
  SCOPE_LABEL,
  fmtDateTime,
  fromLocalInput,
  phrase,
  tierName,
  type BenefitSchema,
  type BenefitTier,
  type SimulateLine,
  type SimulateResult,
} from './shared';

interface Row {
  key: string;
  product_id: string;
  name: string;
  qty: string;
}

export default function SimulatorTab({ schema }: { schema: BenefitSchema }) {
  const { loc } = useLoc();
  const { checkoutPaymentMethods } = useWallet();

  const [tier, setTier] = useState<BenefitTier>(
    (schema.tiers.find((t) => t === 'pro') ?? schema.tiers[0] ?? 'pro') as BenefitTier
  );
  const [rows, setRows] = useState<Row[]>([]);
  const [deliveryId, setDeliveryId] = useState(schema.delivery_methods[0]?.id ?? '');
  const [paymentId, setPaymentId] = useState('');
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimulateResult | null>(null);

  const payments = checkoutPaymentMethods ?? [];
  const paymentValue = paymentId || payments[0]?.id || '';

  const addProduct = (id: string, name: string) => {
    if (!id) return;
    setRows((list) =>
      list.some((r) => r.product_id === id)
        ? list.map((r) => (r.product_id === id ? { ...r, qty: String(Number(r.qty || '1') + 1) } : r))
        : [...list, { key: `${id}-${list.length}`, product_id: id, name, qty: '1' }]
    );
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        tier,
        items: rows.map((r) => ({ product_id: r.product_id, qty: Number(r.qty || '1') })),
      };
      if (deliveryId) body.delivery_method_id = deliveryId;
      if (paymentValue) body.payment_method_id = paymentValue;
      const when = fromLocalInput(at);
      if (when) body.at = when;
      setResult(await api.post<SimulateResult>('/api/admin/membership-benefits/simulate', body));
    } catch (e) {
      // The door refuses in sentences — "Add at least one product to simulate",
      // "Unknown product: prd_x" — and they are shown as written.
      setError(errMsg(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const CAPPED: Record<SimulateLine['capped_by'], string> = {
    none: loc('بلا سقف', 'No ceiling'),
    per_unit: phrase(CAP_LABEL.per_unit, loc),
    per_order: phrase(CAP_LABEL.per_order, loc),
    quantity: loc('حدّ الكمية', 'The quantity limit'),
  };

  const SHIPPING_REASON: Record<SimulateResult['shipping']['reason'], string> = {
    applied: loc('مُطبَّق', 'Applied'),
    no_rule: loc('لا توجد قاعدة توصيل لهذه العضوية', 'No delivery rule for this membership'),
    below_threshold: loc('قيمة الطلب لم تتجاوز العتبة', 'The order did not pass the threshold'),
    method_not_covered: loc('طريقة التوصيل غير مشمولة', 'The delivery method is not covered'),
  };

  const totals = result?.totals;
  const money = (n: number) => formatIqd(n);
  const less = (n: number) => (n > 0 ? `−${formatIqd(n)}` : formatIqd(n));

  const methodName = (id: string | null | undefined) => {
    if (!id) return '—';
    const m = schema.delivery_methods.find((x) => x.id === id);
    return m ? loc(m.title_ar || m.id, m.title_en || m.id) : id;
  };

  const lineRows = result?.lines ?? [];
  const summary = useMemo(() => {
    if (!result) return [];
    const out: string[] = [];
    if (result.totals.membership_discount_iqd > 0) {
      out.push(
        loc(
          `وفّرت ${formatIqd(result.totals.membership_discount_iqd)} بعضوية ${tierName(result.tier)}`,
          `Saved ${formatIqd(result.totals.membership_discount_iqd)} with the ${tierName(result.tier)} membership`
        )
      );
    }
    if (result.totals.shipping_iqd === 0 && result.totals.shipping_benefit_iqd > 0) {
      out.push(
        loc(
          `التوصيل مجاني بفضل عضوية ${tierName(result.tier)}`,
          `Delivery is free thanks to the ${tierName(result.tier)} membership`
        )
      );
    } else if (result.totals.shipping_benefit_iqd > 0) {
      out.push(
        loc(
          `غطّت العضوية ${formatIqd(result.totals.shipping_benefit_iqd)} من أجرة التوصيل`,
          `The membership covered ${formatIqd(result.totals.shipping_benefit_iqd)} of the delivery fee`
        )
      );
    }
    if (result.totals.cod_tax_exemption_iqd > 0) {
      out.push(loc('تم إعفاؤك من ضريبة الدفع عند الاستلام', 'You are exempt from the cash-on-delivery tax'));
    }
    return out;
  }, [result, loc]);

  return (
    <div className="space-y-4" data-mb-panel="simulator">
      <p className="text-[12px] text-[var(--ap-text-3)] max-w-[70ch]">
        {loc(
          'يقرأ القواعد كما هي محفوظة ويمرّ بنفس دوال الدفع، ولا يقرأ أي حساب ولا يكتب شيئًا. القواعد المعطّلة أو خارج مدتها لا تُطبَّق هنا كما لا تُطبَّق في الطلب.',
          'It reads the rules as saved and runs the same checkout functions; it reads no account and writes nothing. A disabled or out-of-window rule does not apply here, exactly as it would not at a checkout.'
        )}
      </p>

      {/* ------------------------------------------------------- the inputs */}
      <div className={`${T.surface} p-3.5 space-y-3`}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="min-w-0 block">
            <span className="block mb-1 text-[12px] font-semibold text-[var(--ap-text-2)]">
              {loc('العضوية', 'Membership')}
            </span>
            <select
              className={`${T.select} w-full px-3`}
              value={tier}
              onChange={(e) => setTier(e.target.value as BenefitTier)}
              data-mb-sim="tier"
            >
              {schema.tiers.map((t) => (
                <option key={t} value={t}>
                  {tierName(t)}
                </option>
              ))}
            </select>
          </label>

          <label className="min-w-0 block">
            <span className="block mb-1 text-[12px] font-semibold text-[var(--ap-text-2)]">
              {loc('التوصيل', 'Delivery', 'گەیاندن')}
            </span>
            <select
              className={`${T.select} w-full px-3`}
              value={deliveryId}
              onChange={(e) => setDeliveryId(e.target.value)}
              data-mb-sim="delivery"
            >
              {schema.delivery_methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {loc(m.title_ar || m.id, m.title_en || m.id)} · {formatIqd(m.price_iqd)}
                </option>
              ))}
            </select>
          </label>

          <label className="min-w-0 block">
            <span className="block mb-1 text-[12px] font-semibold text-[var(--ap-text-2)]">
              {loc('طريقة الدفع', 'Payment', 'پارەدان')}
            </span>
            <select
              className={`${T.select} w-full px-3`}
              value={paymentValue}
              onChange={(e) => setPaymentId(e.target.value)}
              disabled={payments.length === 0}
              data-mb-sim="payment"
            >
              {payments.map((p) => (
                <option key={p.id} value={p.id}>
                  {loc(p.titleAr || p.id, p.titleEn || p.id)}
                </option>
              ))}
            </select>
          </label>

          <label className="min-w-0 block">
            <span className="block mb-1 text-[12px] font-semibold text-[var(--ap-text-2)]">
              {loc('بتاريخ', 'As of')}
            </span>
            <input
              type="datetime-local"
              dir="ltr"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className={`${T.input} w-full`}
              data-mb-sim="at"
            />
          </label>
        </div>

        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="min-w-0">
            <span className="block mb-1 text-[12px] font-semibold text-[var(--ap-text-2)]">
              {loc('أضف منتجًا', 'Add a product')}
            </span>
            <ProductPicker
              value=""
              excludeComposition={false}
              keepOpen
              ariaLabel={loc('اختر منتجًا', 'Choose a product', 'بەرهەمێک هەڵبژێرە')}
              onChange={(id, product) =>
                addProduct(id, product ? product.name_ar || product.name_en || id : id)
              }
            />
          </div>
          <button
            type="button"
            className={T.btnPrimary}
            onClick={() => void run()}
            disabled={busy || rows.length === 0}
            data-mb-sim="run"
          >
            <Play className="w-4 h-4" aria-hidden />
            {busy ? loc('جارٍ…', 'Working…', 'خەریکە…') : loc('احسب', 'Calculate')}
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="text-[12.5px] text-[var(--ap-text-3)]">
            {loc('لم تُضف أي منتج بعد.', 'No product added yet.')}
          </p>
        ) : (
          <ul className="grid gap-2" data-mb-sim="items">
            {rows.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ap-text-1)]">
                  {r.name || r.product_id}
                  <span className="font-mono text-[11px] text-[var(--ap-text-3)] ms-1.5" dir="ltr">
                    {r.product_id}
                  </span>
                </span>
                <input
                  type="number"
                  min={1}
                  dir="ltr"
                  value={r.qty}
                  onChange={(e) =>
                    setRows((list) => list.map((x) => (x.key === r.key ? { ...x, qty: e.target.value } : x)))
                  }
                  aria-label={loc('الكمية', 'Quantity', 'بڕ')}
                  className={`${T.input} w-20`}
                />
                <button
                  type="button"
                  className={T.btnIconDanger}
                  onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}
                  aria-label={loc('إزالة', 'Remove', 'لابردن')}
                  title={loc('إزالة', 'Remove', 'لابردن')}
                >
                  <Trash2 className="w-4 h-4" aria-hidden />
                </button>
              </li>
            ))}
            <li>
              <button type="button" className={T.btnGhostSm} onClick={() => setRows([])} data-mb-sim="clear">
                {loc('أفرغ القائمة', 'Clear the list')}
              </button>
            </li>
          </ul>
        )}

        {error && (
          <p className="text-[12.5px] text-[var(--ap-danger)]" role="alert" data-mb-sim="error">
            {error}
          </p>
        )}
      </div>

      {/* ------------------------------------------------------ the answer */}
      {result && (
        <div className="space-y-4" data-mb-sim="result">
          {summary.length > 0 && (
            <ul className="grid gap-1">
              {summary.map((line) => (
                <li key={line} className="text-[13px] font-semibold text-[var(--ap-success)]">
                  {line}
                </li>
              ))}
            </ul>
          )}

          <Table
            head={[
              loc('المنتج', 'Product', 'بەرهەم'),
              loc('الكمية', 'Quantity', 'بڕ'),
              loc('السعر العادي', 'Regular price'),
              loc('سعر العضو', 'Member price'),
              loc('التوفير', 'Saving', 'پاشەکەوت'),
              loc('القاعدة والسقف', 'Rule and ceiling'),
            ]}
            minWidth={900}
          >
            {lineRows.map((l) => (
              <tr key={l.product_id} className={T.tableRow} data-mb-line={l.product_id}>
                <td className={cell}>
                  <div className="font-semibold text-[var(--ap-text-1)]">{l.name}</div>
                  <div className="font-mono text-[11px] text-[var(--ap-text-3)]" dir="ltr">
                    {l.product_id}
                  </div>
                </td>
                <td className={`${cell} tabular-nums`}>{l.qty}</td>
                <td className={`${cell} tabular-nums whitespace-nowrap`}>
                  <div>{money(l.regular_unit_iqd)}</div>
                  <div className="text-[11.5px] text-[var(--ap-text-3)]">
                    {loc('السطر', 'Line')} {money(l.regular_line_iqd)}
                  </div>
                </td>
                <td className={`${cell} tabular-nums whitespace-nowrap font-semibold`}>{money(l.member_unit_iqd)}</td>
                <td className={`${cell} tabular-nums whitespace-nowrap`}>
                  <div className="font-semibold text-[var(--ap-success)]">{money(l.discount_iqd)}</div>
                  {l.per_unit_discount_iqd > 0 && (
                    <div className="text-[11.5px] text-[var(--ap-text-3)]">
                      {money(l.per_unit_discount_iqd)} · {phrase(CAP_LABEL.per_unit, loc)}
                    </div>
                  )}
                </td>
                <td className={`${cell} text-[11.5px] text-[var(--ap-text-3)]`}>
                  {l.member_rule_id ? (
                    <>
                      <div className="font-mono text-[11px] text-[var(--ap-text-2)]" dir="ltr">
                        {l.member_rule_id}
                      </div>
                      <div>
                        {l.rule_scope ? phrase(SCOPE_LABEL[l.rule_scope], loc, l.rule_scope) : '—'} ·{' '}
                        {CAPPED[l.capped_by]}
                      </div>
                      <div>
                        {l.applied_at === 'unit'
                          ? loc('داخل سعر الوحدة', 'Inside the unit price')
                          : loc('على السطر عند الطلب', 'On the line, at the order')}
                        {l.eligible_qty > 0 && ` · ${loc('الكمية المشمولة', 'eligible')} ${l.eligible_qty}`}
                      </div>
                    </>
                  ) : (
                    loc('لا قاعدة — سعر مكتوب أو بلا ميزة', 'No rule — a typed price, or no benefit')
                  )}
                </td>
              </tr>
            ))}
          </Table>

          {totals && (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className={`${T.surface} p-3.5`}>
                <h3 className="mb-2 text-[13px] font-semibold text-[var(--ap-text-1)]">
                  {loc('الحساب', 'The settlement')}
                </h3>
                <dl className="grid gap-1 text-[12.5px]">
                  <Line label={loc('البضاعة بالسعر العادي', 'Merchandise at the regular price')} value={money(totals.merchandise_regular_iqd)} />
                  <Line label={loc('خصم العضوية', 'Membership discount')} value={less(totals.membership_discount_iqd)} good />
                  <Line label={loc('البضاعة بعد الخصم', 'Merchandise after the discount')} value={money(totals.merchandise_iqd)} />
                  <Line label={loc('أجرة التوصيل قبل الميزة', 'Delivery before the benefit')} value={money(totals.shipping_before_benefit_iqd)} />
                  <Line label={loc('ما غطّته العضوية من التوصيل', 'What the membership covered of the delivery')} value={less(totals.shipping_benefit_iqd)} good />
                  <Line label={loc('التوصيل المستحق', 'Delivery payable')} value={money(totals.shipping_iqd)} />
                  <Line label={loc('ضريبة الدفع عند الاستلام كما احتُسبت', 'Cash-on-delivery tax as calculated')} value={money(totals.cod_tax_before_exemption_iqd)} />
                  <Line label={loc('إعفاء العضوية', 'The membership exemption')} value={less(totals.cod_tax_exemption_iqd)} good />
                  <Line label={loc('الضريبة المستحقة', 'Tax payable')} value={money(totals.cod_tax_iqd)} />
                  <Line label={loc('الإجمالي', 'Total', 'کۆ')} value={money(totals.total_iqd)} strong />
                </dl>
              </section>

              <section className={`${T.surface} p-3.5 space-y-2`}>
                <h3 className="text-[13px] font-semibold text-[var(--ap-text-1)]">
                  {loc('التوصيل والضريبة', 'Delivery and the tax')}
                </h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={result.shipping.eligible ? 'ok' : 'neutral'}>
                    {SHIPPING_REASON[result.shipping.reason]}
                  </Badge>
                  {result.shipping.subsidy_capped && (
                    <Badge tone="warn">{loc('بلغ سقف التغطية', 'The cover ceiling was reached')}</Badge>
                  )}
                  <Badge tone={result.cod_tax.exempt ? 'ok' : 'neutral'}>
                    {result.cod_tax.exempt
                      ? loc('معفى من ضريبة الدفع عند الاستلام', 'Exempt from the cash-on-delivery tax')
                      : loc('غير معفى من ضريبة الدفع عند الاستلام', 'Not exempt from the cash-on-delivery tax')}
                  </Badge>
                </div>
                <dl className="grid gap-1 text-[12.5px]">
                  <Line label={loc('طريقة التوصيل', 'Delivery method')} value={methodName(deliveryId)} />
                  {/*
                    WITH NO RULE THERE IS NO COVERAGE TO DESCRIBE.

                    When this tier has no free-delivery rule the server answers
                    with `NO_SHIPPING_BENEFIT` — `rule_id: null`, and a null
                    threshold and a null method list beside it. Those two nulls
                    mean "nothing is configured". Read with the wording a real
                    rule uses, they would say «بلا عتبة» and «كل الطرق» — free
                    delivery, on every method, from any amount — which is the
                    opposite of the truth for a tier whose delivery rule does
                    not exist. So the rule wording is printed only once there is
                    a rule to print it for.
                  */}
                  <Line
                    label={loc('العتبة', 'The threshold')}
                    value={
                      result.shipping.rule_id === null
                        ? '—'
                        : result.shipping.threshold_iqd === null
                          ? loc('بلا عتبة', 'None')
                          : money(result.shipping.threshold_iqd)
                    }
                  />
                  <Line label={loc('القيمة المقارَنة', 'Compared against')} value={money(result.shipping.basis_iqd)} />
                  <Line
                    label={loc('الطرق المشمولة', 'Methods covered')}
                    value={
                      result.shipping.rule_id === null
                        ? '—'
                        : result.shipping.methods === null
                          ? loc('كل الطرق', 'Every method')
                          : // An empty list is a rule switched off for every
                            // method — said as such, not as a missing value.
                            result.shipping.methods.map(methodName).join(' · ') || loc('لا شيء', 'None')
                    }
                  />
                  <Line label={loc('قاعدة التوصيل', 'The delivery rule')} value={result.shipping.rule_id ?? '—'} mono />
                  <Line label={loc('قاعدة الضريبة', 'The tax rule')} value={result.cod_tax.rule_id ?? '—'} mono />
                  <Line label={loc('نسخة الإعدادات', 'Configuration version')} value={result.version_id === null ? '—' : `#${result.version_id}`} />
                  <Line label={loc('بتاريخ', 'As of')} value={fmtDateTime(result.at)} />
                </dl>

                {result.shipping.reasons.length > 0 && (
                  <ul className="space-y-1 pt-1">
                    {result.shipping.reasons.map((r) => (
                      <li key={r} className="text-[12px] text-[var(--ap-text-2)]" dir="ltr">
                        {r}
                      </li>
                    ))}
                  </ul>
                )}

                {result.assumptions.length > 0 && (
                  <ul className="space-y-1 border-t border-[var(--ap-hairline)] pt-2">
                    {result.assumptions.map((a) => (
                      <li key={a} className="text-[12px] text-[var(--ap-text-3)]" dir="ltr">
                        {a}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One row of a settlement list: what it is, and what it came to. */
function Line({
  label,
  value,
  good,
  strong,
  mono,
}: {
  label: string;
  value: string;
  good?: boolean;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <dt className="text-[var(--ap-text-3)]">{label}</dt>
      <dd
        className={`tabular-nums ${mono ? 'font-mono text-[11.5px]' : ''} ${
          strong ? 'text-[14px] font-bold text-[var(--ap-text-1)]' : good ? 'font-semibold text-[var(--ap-success)]' : 'text-[var(--ap-text-1)]'
        }`}
        dir={mono ? 'ltr' : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
