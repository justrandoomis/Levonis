/**
 * «تعديل السعر النهائي» — the admin half of a price change the customer must
 * approve (migration 0140, worker/lib/orderPriceAdjust.ts).
 *
 * FOUR STATES, one at a time:
 *   · an open proposal → what the customer is being asked, and «سحب الاقتراح»;
 *   · none, and the order still holds lines sold at an ESTIMATED price
 *     (migration 0218, `estimate_open`) → «تأكيد السعر النهائي»
 *     (EstimateConfirmPanel) INSTEAD of the free proposal form: estimates have
 *     one way to settle, and the server refuses an ordinary proposal on such an
 *     order (PRICE_ESTIMATE_OPEN);
 *   · none, and this admin may propose → the button that opens the form;
 *   · none, and nobody may → one quiet line saying why (financed, shipped …).
 *
 * AN ESTIMATE PROPOSAL (`reason_code` ESTIMATE_FINAL_PRICE) reads as the
 * customer reads it: the localized estimate reason — the stored `reason` is
 * that sentence in three languages, for the CHECK and older readers — and its
 * lines, old → new. Customer prices only (docs/SMART_PRICING.md §6.7).
 *
 * THE PREVIEW IS THE SERVER'S RULE, not a copy of it: `planPriceAdjustment`
 * (packages/pricing) is the same function the Worker writes with, so «سيصبح
 * المستحق عند التسليم» cannot disagree with what approval will do.
 *
 * The idempotency key is minted once per opened form and kept across retries,
 * so a double-press or a timed-out request never files two proposals.
 * Every string is in Arabic, English and Sorani (DECISIONS row 183), the
 * Sorani in the words the customer's own copy uses (CUSTOMER_COPY.ckb).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, PencilLine } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, formatIqd, type PriceAdjustmentEstimateFields, type PriceAdjustmentEstimateLine } from '../../lib/api';
import { apiRefusal, type Lang } from '../../lib/refusalStrings';
import { planPriceAdjustment, PRICE_ADJUST_MAX_IQD } from '../../../packages/pricing/src/priceAdjustment';
import { ESTIMATE_REASON_CODE, ESTIMATE_STRINGS, estimateRefusalText } from '../../../packages/contracts/src/priceEstimates';
import { Button } from '../ui/Button';
import { Field, Textarea } from '../ui/Field';
import { NumberInput } from '../ui/NumberInput';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import EstimateConfirmPanel from './EstimateConfirmPanel';

export interface PublicAdjustment extends Omit<PriceAdjustmentEstimateFields, 'lines'> {
  id: string;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'void';
  old_total_iqd: number;
  new_total_iqd: number;
  delta_iqd: number;
  old_due_iqd: number;
  new_due_iqd: number;
  wallet_refund_iqd: number;
  reason: string;
  note: string;
  created_at: string;
  decided_at: string | null;
  decided_via: string | null;
  /** An estimate proposal's lines, old → new (customer prices only); the server adds the item id and the option. */
  lines?: Array<PriceAdjustmentEstimateLine & { order_item_id?: string; variant?: string }>;
}

interface PanelData {
  order: { id: string; total_iqd: number; due_on_delivery_iqd: number; wallet_applied_iqd: number; payment_method_id: string };
  blocker: string | null;
  can_propose: boolean;
  financial_scope: boolean;
  /** Migration 0218: estimated lines still wait for their final price. Absent from an older server. */
  estimate_open?: boolean;
  pending: PublicAdjustment | null;
  history: PublicAdjustment[];
}

type Loc = (ar: string, en: string, ckb?: string) => string;

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`;

const langOf = (lang: string): Lang => (lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar');

/** A refusal in the reader's language: an estimate code from the contract first (§5.5), then the shop's table, then the fallback. */
const refusalOf = (e: unknown, lang: Lang, fallback: string): string => estimateRefusalText(e, lang) ?? apiRefusal(e, lang, fallback);

/** Is this the proposal that settles an order's estimated lines (migration 0218)? */
const isEstimateProposal = (a: Pick<PublicAdjustment, 'reason_code'>): boolean => a.reason_code === ESTIMATE_REASON_CODE;

/** Words, not a sign glued to an RTL figure (a «+» beside «د.ع» flips sides under bidi). */
const signedText = (n: number, loc: Loc) =>
  `${n > 0 ? loc('زيادة', 'Increase', 'زیادبوون') : loc('تخفيض', 'Decrease', 'کەمبوونەوە')} ${formatIqd(Math.abs(n))}`;

/**
 * The proposal waiting on the customer: what they are asked, and «سحب
 * الاقتراح». An estimate settlement prints the localized estimate reason and
 * its lines, old → new, and says what a rejection leads to.
 */
export function PendingAdjustment({ p, onWithdraw }: { p: PublicAdjustment; onWithdraw: () => void }) {
  const { loc, lang, dir } = useLanguage();
  const L = langOf(lang);
  // «from → to» in reading order: the arrow points the way the line is read.
  const arrow = dir === 'rtl' ? '←' : '→';
  const estimate = isEstimateProposal(p);
  return (
    <div data-price-adjust-pending data-price-adjust-kind={estimate ? 'estimate' : 'ordinary'} className="lv-alert lv-alert-warning p-3.5 space-y-2.5">
      <p className="flex items-center gap-2 text-[13px] font-bold text-warning" role="status">
        <Clock3 className="h-4 w-4 shrink-0" aria-hidden />
        {loc('بانتظار موافقة الزبون على السعر', 'Waiting for the customer to approve the price', 'چاوەڕێی پەسەندکردنی نرخەکە لەلایەن کڕیارەوە')}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[13px] text-text-muted line-through tabular-nums">{formatIqd(p.old_total_iqd)}</span>
        <span className="text-[18px] font-black text-text-primary tabular-nums">{formatIqd(p.new_total_iqd)}</span>
        <span className="text-[12px] font-bold text-text-secondary tabular-nums">{signedText(p.delta_iqd, loc)}</span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
        <dt className="text-text-muted">{loc('المستحق عند التسليم بعد الموافقة', 'Due on delivery after approval', 'ماوە لە گەیاندن دوای پەسەندکردن')}</dt>
        <dd className="text-text-primary tabular-nums text-end">{formatIqd(p.new_due_iqd)}</dd>
        {p.wallet_refund_iqd > 0 && (
          <>
            <dt className="text-text-muted">{loc('يُعاد إلى محفظة الزبون', 'Back to the customer’s wallet', 'دەگەڕێتەوە بۆ جزدانی کڕیار')}</dt>
            <dd className="text-success tabular-nums text-end">{formatIqd(p.wallet_refund_iqd)}</dd>
          </>
        )}
      </dl>
      <p className="text-[12.5px] text-text-primary whitespace-pre-wrap">
        <span className="text-text-muted">{loc('السبب', 'Reason', 'هۆکار')}: </span>
        {estimate ? ESTIMATE_STRINGS.estimateReason[L] : p.reason}
      </p>
      {estimate && (p.lines?.length ?? 0) > 0 && (
        <ul data-price-adjust-lines className="space-y-1 text-[12.5px]">
          {(p.lines ?? []).map((l, i) => (
            <li key={l.order_item_id ?? i} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="min-w-0 break-words text-text-primary">
                <bdi>{l.name}</bdi>
                {l.variant ? (
                  <>
                    {' — '}
                    <bdi dir="auto">{l.variant}</bdi>
                  </>
                ) : null}{' '}
                <span className="tabular-nums text-text-muted">×{l.qty}</span>
              </span>
              <span className="tabular-nums text-text-secondary">
                {formatIqd(l.estimate_unit_iqd)} {arrow}{' '}
                <span className="font-bold text-text-primary">{l.final_unit_iqd != null ? formatIqd(l.final_unit_iqd) : '—'}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {p.note && <p className="text-[12px] text-text-secondary whitespace-pre-wrap">{p.note}</p>}
      <p className="text-[11.5px] text-text-muted">
        {loc(
          'لا يمكن تغيير مرحلة الطلب أو شحنه حتى يقرر الزبون.',
          'The order cannot move or ship until the customer decides.',
          'تا کڕیار بڕیار نەدات، قۆناغی داواکارییەکە ناگۆڕدرێت و نانێردرێت.'
        )}
      </p>
      {estimate && (
        <p className="text-[11.5px] text-text-muted" data-price-adjust-estimate-reject>
          {loc(
            'إن رفض الزبون: أبقِ السعر التقديري، أو ألغِ الطلب مع الاسترداد.',
            'If the customer rejects: keep the estimate, or cancel the order with a refund.',
            'ئەگەر کڕیار ڕەتی کردەوە: نرخی خەمڵێنراو بهێڵەرەوە، یان داواکارییەکە بە گەڕاندنەوەی پارە هەڵبوەشێنەرەوە.'
          )}
        </p>
      )}
      <Button variant="secondary" size="sm" onClick={onWithdraw} data-action="price-withdraw">
        {loc('سحب الاقتراح', 'Withdraw proposal', 'کشاندنەوەی پێشنیار')}
      </Button>
    </div>
  );
}

export default function PriceAdjustPanel({ orderId, onChanged }: { orderId: string; onChanged: () => void | Promise<void> }) {
  const { loc, lang, dir } = useLanguage();
  // «from → to» in reading order: the arrow points the way the line is read.
  const arrow = dir === 'rtl' ? '←' : '→';
  const L = langOf(lang);
  const toast = useToast();
  const [data, setData] = useState<PanelData | null>(null);
  const [loadError, setLoadError] = useState<{ e: unknown } | null>(null);
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [totalValid, setTotalValid] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newKey);
  const [formError, setFormError] = useState('');
  const [tried, setTried] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawError, setWithdrawError] = useState('');

  // Deps are the order only: a failure's sentence is chosen at render, in the
  // reader's language — the context's `loc` is a fresh closure on every
  // provider render, and a read that depended on it re-fired with each one.
  const load = useCallback(async () => {
    try {
      setData(await api.get<PanelData>(`/api/admin/orders/${encodeURIComponent(orderId)}/price-adjustment`));
      setLoadError(null);
    } catch (e) {
      setLoadError({ e });
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  /** After a settlement or a proposal in the estimate panel: this panel and the order are read again. */
  const changed = useCallback(async () => {
    await load();
    await onChanged();
  }, [load, onChanged]);

  const plan = useMemo(() => {
    if (!data || total === null || !totalValid) return null;
    return planPriceAdjustment({
      totalIqd: data.order.total_iqd,
      dueOnDeliveryIqd: data.order.due_on_delivery_iqd,
      walletAppliedIqd: data.order.wallet_applied_iqd,
      paymentMethodId: data.order.payment_method_id,
      newTotalIqd: total,
    });
  }, [data, total, totalValid]);

  const blockerText = (code: string | null): string => {
    switch (code) {
      case 'PRICE_ADJUST_FINANCED':
        return loc('طلبات الأقساط (BNPL / جني) لا يُعدَّل سعرها.', 'Instalment orders (BNPL / Gini) cannot be re-priced.', 'نرخی داواکارییە قیستییەکان (BNPL / Gini) ناگۆڕدرێت.');
      case 'PRICE_ADJUST_STAGE':
        return loc('يُعدَّل السعر قبل الشحن فقط.', 'The price can only change before the order ships.', 'نرخ تەنها پێش ناردنی داواکارییەکە دەگۆڕدرێت.');
      case 'PRICE_ADJUST_COURIER_BOOKED':
        return loc(
          'أُنشئت شحنة التوصيل بمبلغها — ألغِ الشحنة أولًا.',
          'A courier shipment already carries the amount — cancel it first.',
          'باری گەیێنەر پێشتر بەم بڕە تۆمار کراوە — سەرەتا بارەکە هەڵبوەشێنەرەوە.'
        );
      case 'PRICE_ADJUST_STORE_ORDER':
        return loc('طلب متجر مجتمعي — يسعّره التاجر.', 'A community store order — its merchant prices it.', 'داواکاریی فرۆشگای کۆمەڵگا — بازرگانەکە نرخەکەی دیاری دەکات.');
      case 'PRICE_ADJUST_UNSUPPORTED_PAYMENT':
        return loc(
          'طريقة دفع هذا الطلب لا تسمح بتعديل تلقائي للسعر.',
          'This order’s payment split cannot be re-priced automatically.',
          'شێوازی پارەدانی ئەم داواکارییە ڕێگە نادات نرخەکەی بە خۆکاری بگۆڕدرێت.'
        );
      default:
        // PRICE_ESTIMATE_OPEN and any later estimate code: the contract's own sentence.
        return estimateRefusalText(code, L) ?? '';
    }
  };

  const reset = () => {
    setOpen(false);
    setTotal(null);
    setTotalValid(false);
    setReason('');
    setNote('');
    setFormError('');
    setTried(false);
    setKey(newKey());
  };

  const reasonError =
    tried && reason.trim().length < 3
      ? loc('اكتب سببًا يقرؤه الزبون (3 أحرف على الأقل).', 'Write a reason the customer will read (at least 3 characters).', 'هۆکارێک بنووسە کە کڕیار دەیخوێنێتەوە (لانیکەم 3 پیت).')
      : '';
  const totalError =
    tried && (!totalValid || total === null || total <= 0)
      ? loc('أدخل مبلغًا صحيحًا بالدينار أكبر من صفر.', 'Enter a whole number of dinars above zero.', 'بڕێکی تەواو بە دینار بنووسە کە لە سفر زیاتر بێت.')
      : plan && plan.ok === false
        ? apiRefusal({ code: plan.code }, L, '')
        : '';

  const submit = async () => {
    setTried(true);
    setFormError('');
    if (!totalValid || total === null || reason.trim().length < 3 || !plan || !plan.ok) return;
    try {
      await api.post(`/api/admin/orders/${encodeURIComponent(orderId)}/price-adjustment`, {
        new_total_iqd: total,
        reason: reason.trim(),
        note: note.trim(),
        idempotencyKey: key,
      });
      toast.success(
        loc(
          'أُرسل السعر الجديد للزبون — الطلب معلّق حتى يقرر.',
          'The new price was sent — the order is on hold until the customer decides.',
          'نرخە نوێیەکە بۆ کڕیار نێردرا — داواکارییەکە ڕادەگیرێت تا کڕیار بڕیار دەدات.'
        )
      );
      reset();
      await load();
      await onChanged();
    } catch (e) {
      setFormError(refusalOf(e, L, loc('تعذّر إرسال الاقتراح.', 'The proposal could not be sent.', 'پێشنیارەکە نەنێردرا.')));
    }
  };

  const withdraw = async () => {
    if (!data?.pending) return;
    setWithdrawError('');
    try {
      await api.post(`/api/admin/orders/${encodeURIComponent(orderId)}/price-adjustment/${data.pending.id}/withdraw`, {});
      setWithdrawOpen(false);
      toast.success(
        loc(
          'سُحب الاقتراح وعاد الطلب إلى سعره الحالي.',
          'Proposal withdrawn — the order keeps its current price.',
          'پێشنیارەکە کشێنرایەوە — داواکارییەکە لەسەر نرخی ئێستای دەمێنێتەوە.'
        )
      );
      await load();
      await onChanged();
    } catch (e) {
      setWithdrawError(refusalOf(e, L, loc('تعذّر سحب الاقتراح.', 'The proposal could not be withdrawn.', 'پێشنیارەکە نەکشێنرایەوە.')));
    }
  };

  if (loadError) {
    return (
      <p className="text-[12px] text-text-muted" data-price-adjust="error">
        {refusalOf(loadError.e, L, loc('تعذّر تحميل حالة السعر.', 'The price state could not be loaded.', 'دۆخی نرخ بار نەکرا.'))}
      </p>
    );
  }
  if (!data) return null;
  const p = data.pending;
  const decided = data.history.filter((h) => h.state !== 'pending').slice(0, 5);

  return (
    <section data-price-adjust aria-labelledby={`price-adjust-${orderId}`} className="space-y-3">
      <h3 id={`price-adjust-${orderId}`} className="text-[13px] font-bold text-text-secondary">
        {loc('السعر النهائي', 'Final price', 'نرخی کۆتایی')}
      </h3>

      {p ? (
        <PendingAdjustment p={p} onWithdraw={() => setWithdrawOpen(true)} />
      ) : data.estimate_open === true ? (
        // Estimates have one way to settle (§6.7): the estimate panel, never the free form.
        <EstimateConfirmPanel orderId={orderId} onChanged={changed} />
      ) : open ? (
        <form
          data-price-adjust-form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="rounded-2xl border border-border-subtle bg-surface-raised p-3.5 space-y-3"
        >
          <Field
            label={loc('السعر النهائي الجديد', 'New final total', 'کۆی گشتیی کۆتایی نوێ')}
            hint={`${loc('الحالي', 'Current', 'ئێستا')}: ${formatIqd(data.order.total_iqd)}`}
            error={totalError || undefined}
            required
          >
            <NumberInput
              kind="money"
              value={total}
              min={1}
              max={PRICE_ADJUST_MAX_IQD}
              onValueChange={(v, valid) => {
                setTotal(v);
                setTotalValid(valid && v !== null && v > 0);
              }}
            />
          </Field>
          <Field label={loc('السبب — يظهر للزبون', 'Reason — shown to the customer', 'هۆکار — بۆ کڕیار پیشان دەدرێت')} error={reasonError || undefined} required>
            <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          </Field>
          <Field label={loc('تفصيل السعر', 'Price breakdown', 'وردەکاری نرخ')} optional>
            <Textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          </Field>

          {plan?.ok && (
            <dl data-price-adjust-preview className="rounded-xl border border-border-subtle bg-surface p-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[12.5px]">
              <dt className="text-text-muted">{loc('الفرق', 'Difference', 'جیاوازی')}</dt>
              <dd className="tabular-nums text-text-primary font-bold">{signedText(plan.plan.deltaIqd, loc)}</dd>
              <dt className="text-text-muted">{loc('المستحق عند التسليم', 'Due on delivery', 'ماوە لە گەیاندن')}</dt>
              <dd className="tabular-nums text-text-primary">
                {formatIqd(plan.plan.oldDueIqd)} {arrow} {formatIqd(plan.plan.newDueIqd)}
              </dd>
              {plan.plan.walletRefundIqd > 0 && (
                <>
                  <dt className="text-text-muted">{loc('يُعاد إلى المحفظة عند الموافقة', 'Refunded to the wallet on approval', 'لە کاتی پەسەندکردن دەگەڕێتەوە بۆ جزدان')}</dt>
                  <dd className="tabular-nums text-success">{formatIqd(plan.plan.walletRefundIqd)}</dd>
                </>
              )}
            </dl>
          )}
          <p className="text-[11.5px] text-text-muted">
            {loc(
              'سيُعلَّق الطلب ويُطلب من الزبون الموافقة (إشعار + تيليجرام). لا يتغيّر المبلغ إلا بعد موافقته.',
              'The order is put on hold and the customer is asked to approve (notification + Telegram). Nothing is charged until they approve.',
              'داواکارییەکە ڕادەگیرێت و داوا لە کڕیار دەکرێت پەسەندی بکات (ئاگادارکردنەوە + تێلێگرام). تا پەسەندی نەکات هیچ بڕێک ناگۆڕێت.'
            )}
          </p>
          {formError && (
            <p role="alert" className="lv-field-error">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="primary" size="sm" onClick={submit} data-action="price-propose">
              {loc('إرسال للزبون للموافقة', 'Send to the customer for approval', 'ناردن بۆ کڕیار بۆ پەسەندکردن')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
            </Button>
          </div>
        </form>
      ) : data.can_propose ? (
        <Button variant="secondary" size="sm" icon={<PencilLine className="h-4 w-4" aria-hidden />} onClick={() => setOpen(true)} data-action="price-open">
          {loc('تعديل السعر النهائي', 'Change the final price', 'گۆڕینی نرخی کۆتایی')}
        </Button>
      ) : (
        <p className="text-[12px] text-text-muted" data-price-adjust-blocked={data.blocker ?? 'scope'}>
          {blockerText(data.blocker) ||
            (!data.financial_scope
              ? loc('تعديل السعر للمالك أو الدور المالي فقط.', 'Only the owner or a financial admin can change the price.', 'تەنها خاوەن یان بەڕێوەبەری دارایی دەتوانێت نرخ بگۆڕێت.')
              : '')}
        </p>
      )}

      {decided.length > 0 && (
        <ul data-price-adjust-history className="space-y-1 text-[12px] text-text-secondary">
          {decided.map((h) => (
            <li key={h.id} className="flex flex-wrap gap-x-2">
              <span className="tabular-nums">
                {formatIqd(h.old_total_iqd)} {arrow} {formatIqd(h.new_total_iqd)}
              </span>
              <span className={h.state === 'approved' ? 'text-success font-bold' : 'text-text-muted font-bold'}>
                {h.state === 'approved'
                  ? loc('وافق الزبون', 'Approved', 'پەسەند کرا')
                  : h.state === 'rejected'
                    ? loc('رفض الزبون', 'Rejected', 'ڕەت کرایەوە')
                    : h.state === 'withdrawn'
                      ? loc('سُحب', 'Withdrawn', 'کشێنرایەوە')
                      : loc('أُلغي مع الطلب', 'Voided with the order', 'لەگەڵ داواکارییەکە هەڵوەشایەوە')}
              </span>
              {/* Which kind it was: the settlement of an estimated price, in the label's own words. */}
              {isEstimateProposal(h) && (
                <span data-price-adjust-history-kind="estimate" className="text-text-muted">
                  · {ESTIMATE_STRINGS.label[L]}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={withdrawOpen}
        title={loc('سحب اقتراح السعر؟', 'Withdraw the price proposal?', 'پێشنیاری نرخەکە بکشێنرێتەوە؟')}
        consequence={
          p && isEstimateProposal(p)
            ? loc(
                'يعود الطلب إلى «تأكيد السعر النهائي» ويبقى في «تم استلام الطلب» حتى تُؤكَّد أسعاره التقديرية، وتُعطَّل أزرار الموافقة لدى الزبون.',
                'The order goes back to “Confirm the final price” and stays at “Order received” until its estimated prices are confirmed; the customer’s approval buttons stop working.',
                'داواکارییەکە دەگەڕێتەوە بۆ «پشتڕاستکردنەوەی نرخی کۆتایی» و لە «داواکاری وەرگیرا» دەمێنێتەوە تا نرخە خەمڵێنراوەکانی پشتڕاست دەکرێنەوە، و دوگمەکانی پەسەندکردنی کڕیار کار ناکەن.'
              )
            : loc(
                'يبقى الطلب على سعره الحالي ويمكن متابعته فورًا، وتُعطَّل أزرار الموافقة لدى الزبون.',
                'The order keeps its current price and can move again right away; the customer’s approval buttons stop working.',
                'داواکارییەکە لەسەر نرخی ئێستای دەمێنێتەوە و دەستبەجێ دەتوانرێت بەردەوام بێت، و دوگمەکانی پەسەندکردنی کڕیار کار ناکەن.'
              )
        }
        confirmLabel={loc('سحب الاقتراح', 'Withdraw', 'کشاندنەوە')}
        onConfirm={withdraw}
        onCancel={() => {
          setWithdrawOpen(false);
          setWithdrawError('');
        }}
        error={withdrawError || undefined}
      />
    </section>
  );
}
