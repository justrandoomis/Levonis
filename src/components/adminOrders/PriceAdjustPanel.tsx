/**
 * «تعديل السعر النهائي» — the admin half of a price change the customer must
 * approve (migration 0140, worker/lib/orderPriceAdjust.ts).
 *
 * THREE STATES, one at a time:
 *   · an open proposal → what the customer is being asked, and «سحب الاقتراح»;
 *   · none, and this admin may propose → the button that opens the form;
 *   · none, and nobody may → one quiet line saying why (financed, shipped …).
 *
 * THE PREVIEW IS THE SERVER'S RULE, not a copy of it: `planPriceAdjustment`
 * (packages/pricing) is the same function the Worker writes with, so «سيصبح
 * المستحق عند التسليم» cannot disagree with what approval will do.
 *
 * The idempotency key is minted once per opened form and kept across retries,
 * so a double-press or a timed-out request never files two proposals.
 * OWNER: Sorani to be written by hand for every string here (ar/en only).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, PencilLine } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, formatIqd } from '../../lib/api';
import { apiRefusal, type Lang } from '../../lib/refusalStrings';
import { planPriceAdjustment, PRICE_ADJUST_MAX_IQD } from '../../../packages/pricing/src/priceAdjustment';
import { Button } from '../ui/Button';
import { Field, Textarea } from '../ui/Field';
import { NumberInput } from '../ui/NumberInput';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';

export interface PublicAdjustment {
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
}

interface PanelData {
  order: { id: string; total_iqd: number; due_on_delivery_iqd: number; wallet_applied_iqd: number; payment_method_id: string };
  blocker: string | null;
  can_propose: boolean;
  financial_scope: boolean;
  pending: PublicAdjustment | null;
  history: PublicAdjustment[];
}

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`;


export default function PriceAdjustPanel({ orderId, onChanged }: { orderId: string; onChanged: () => void | Promise<void> }) {
  const { loc, lang, dir } = useLanguage();
  // Words, not a sign glued to an RTL figure (a «+» beside «د.ع» flips sides under bidi).
  const signed = (n: number) => `${n > 0 ? loc('زيادة', 'Increase') : loc('تخفيض', 'Decrease')} ${formatIqd(Math.abs(n))}`;
  // «from → to» in reading order: the arrow points the way the line is read.
  const arrow = dir === 'rtl' ? '←' : '→';
  const L = (lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar') as Lang;
  const toast = useToast();
  const [data, setData] = useState<PanelData | null>(null);
  const [loadError, setLoadError] = useState('');
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

  const load = useCallback(async () => {
    try {
      setData(await api.get<PanelData>(`/api/admin/orders/${encodeURIComponent(orderId)}/price-adjustment`));
      setLoadError('');
    } catch (e) {
      setLoadError(apiRefusal(e, L, loc('تعذّر تحميل حالة السعر.', 'The price state could not be loaded.')));
    }
  }, [orderId, L, loc]);

  useEffect(() => {
    load();
  }, [load]);

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
        return loc('طلبات الأقساط (BNPL / جني) لا يُعدَّل سعرها.', 'Instalment orders (BNPL / Gini) cannot be re-priced.');
      case 'PRICE_ADJUST_STAGE':
        return loc('يُعدَّل السعر قبل الشحن فقط.', 'The price can only change before the order ships.');
      case 'PRICE_ADJUST_COURIER_BOOKED':
        return loc('أُنشئت شحنة التوصيل بمبلغها — ألغِ الشحنة أولًا.', 'A courier shipment already carries the amount — cancel it first.');
      case 'PRICE_ADJUST_STORE_ORDER':
        return loc('طلب متجر مجتمعي — يسعّره التاجر.', 'A community store order — its merchant prices it.');
      case 'PRICE_ADJUST_UNSUPPORTED_PAYMENT':
        return loc('طريقة دفع هذا الطلب لا تسمح بتعديل تلقائي للسعر.', 'This order’s payment split cannot be re-priced automatically.');
      default:
        return '';
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

  const reasonError = tried && reason.trim().length < 3 ? loc('اكتب سببًا يقرؤه الزبون (3 أحرف على الأقل).', 'Write a reason the customer will read (at least 3 characters).') : '';
  const totalError =
    tried && (!totalValid || total === null || total <= 0)
      ? loc('أدخل مبلغًا صحيحًا بالدينار أكبر من صفر.', 'Enter a whole number of dinars above zero.')
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
      toast.success(loc('أُرسل السعر الجديد للزبون — الطلب معلّق حتى يقرر.', 'The new price was sent — the order is on hold until the customer decides.'));
      reset();
      await load();
      await onChanged();
    } catch (e) {
      setFormError(apiRefusal(e, L, loc('تعذّر إرسال الاقتراح.', 'The proposal could not be sent.')));
    }
  };

  const withdraw = async () => {
    if (!data?.pending) return;
    setWithdrawError('');
    try {
      await api.post(`/api/admin/orders/${encodeURIComponent(orderId)}/price-adjustment/${data.pending.id}/withdraw`, {});
      setWithdrawOpen(false);
      toast.success(loc('سُحب الاقتراح وعاد الطلب إلى سعره الحالي.', 'Proposal withdrawn — the order keeps its current price.'));
      await load();
      await onChanged();
    } catch (e) {
      setWithdrawError(apiRefusal(e, L, loc('تعذّر سحب الاقتراح.', 'The proposal could not be withdrawn.')));
    }
  };

  if (loadError) {
    return (
      <p className="text-[12px] text-text-muted" data-price-adjust="error">
        {loadError}
      </p>
    );
  }
  if (!data) return null;
  const p = data.pending;
  const decided = data.history.filter((h) => h.state !== 'pending').slice(0, 5);

  return (
    <section data-price-adjust aria-labelledby={`price-adjust-${orderId}`} className="space-y-3">
      <h3 id={`price-adjust-${orderId}`} className="text-[13px] font-bold text-text-secondary">
        {loc('السعر النهائي', 'Final price')}
      </h3>

      {p ? (
        <div data-price-adjust-pending className="rounded-2xl border border-warning/35 bg-warning/10 p-3.5 space-y-2.5">
          <p className="flex items-center gap-2 text-[13px] font-bold text-warning" role="status">
            <Clock3 className="h-4 w-4 shrink-0" aria-hidden />
            {loc('بانتظار موافقة الزبون على السعر', 'Waiting for the customer to approve the price')}
          </p>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[13px] text-text-muted line-through tabular-nums">{formatIqd(p.old_total_iqd)}</span>
            <span className="text-[18px] font-black text-text-primary tabular-nums">{formatIqd(p.new_total_iqd)}</span>
            <span className="text-[12px] font-bold text-text-secondary tabular-nums">
              {signed(p.delta_iqd)}
            </span>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
            <dt className="text-text-muted">{loc('المستحق عند التسليم بعد الموافقة', 'Due on delivery after approval')}</dt>
            <dd className="text-text-primary tabular-nums text-end">{formatIqd(p.new_due_iqd)}</dd>
            {p.wallet_refund_iqd > 0 && (
              <>
                <dt className="text-text-muted">{loc('يُعاد إلى محفظة الزبون', 'Back to the customer’s wallet')}</dt>
                <dd className="text-success tabular-nums text-end">{formatIqd(p.wallet_refund_iqd)}</dd>
              </>
            )}
          </dl>
          <p className="text-[12.5px] text-text-primary whitespace-pre-wrap">
            <span className="text-text-muted">{loc('السبب', 'Reason')}: </span>
            {p.reason}
          </p>
          {p.note && <p className="text-[12px] text-text-secondary whitespace-pre-wrap">{p.note}</p>}
          <p className="text-[11.5px] text-text-muted">
            {loc('لا يمكن تغيير مرحلة الطلب أو شحنه حتى يقرر الزبون.', 'The order cannot move or ship until the customer decides.')}
          </p>
          <Button variant="secondary" size="sm" onClick={() => setWithdrawOpen(true)} data-action="price-withdraw">
            {loc('سحب الاقتراح', 'Withdraw proposal')}
          </Button>
        </div>
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
            label={loc('السعر النهائي الجديد', 'New final total')}
            hint={`${loc('الحالي', 'Current')}: ${formatIqd(data.order.total_iqd)}`}
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
          <Field label={loc('السبب — يظهر للزبون', 'Reason — shown to the customer')} error={reasonError || undefined} required>
            <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          </Field>
          <Field label={loc('تفصيل السعر', 'Price breakdown')} optional>
            <Textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          </Field>

          {plan?.ok && (
            <dl data-price-adjust-preview className="rounded-xl border border-border-subtle bg-surface p-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[12.5px]">
              <dt className="text-text-muted">{loc('الفرق', 'Difference')}</dt>
              <dd className="tabular-nums text-text-primary font-bold">{signed(plan.plan.deltaIqd)}</dd>
              <dt className="text-text-muted">{loc('المستحق عند التسليم', 'Due on delivery')}</dt>
              <dd className="tabular-nums text-text-primary">
                {formatIqd(plan.plan.oldDueIqd)} {arrow} {formatIqd(plan.plan.newDueIqd)}
              </dd>
              {plan.plan.walletRefundIqd > 0 && (
                <>
                  <dt className="text-text-muted">{loc('يُعاد إلى المحفظة عند الموافقة', 'Refunded to the wallet on approval')}</dt>
                  <dd className="tabular-nums text-success">{formatIqd(plan.plan.walletRefundIqd)}</dd>
                </>
              )}
            </dl>
          )}
          <p className="text-[11.5px] text-text-muted">
            {loc(
              'سيُعلَّق الطلب ويُطلب من الزبون الموافقة (إشعار + تيليجرام). لا يتغيّر المبلغ إلا بعد موافقته.',
              'The order is put on hold and the customer is asked to approve (notification + Telegram). Nothing is charged until they approve.'
            )}
          </p>
          {formError && (
            <p role="alert" className="lv-field-error">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="primary" size="sm" onClick={submit} data-action="price-propose">
              {loc('إرسال للزبون للموافقة', 'Send to the customer for approval')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              {loc('إلغاء', 'Cancel')}
            </Button>
          </div>
        </form>
      ) : data.can_propose ? (
        <Button variant="secondary" size="sm" icon={<PencilLine className="h-4 w-4" aria-hidden />} onClick={() => setOpen(true)} data-action="price-open">
          {loc('تعديل السعر النهائي', 'Change the final price')}
        </Button>
      ) : (
        <p className="text-[12px] text-text-muted" data-price-adjust-blocked={data.blocker ?? 'scope'}>
          {blockerText(data.blocker) ||
            (!data.financial_scope ? loc('تعديل السعر للمالك أو الدور المالي فقط.', 'Only the owner or a financial admin can change the price.') : '')}
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
                  ? loc('وافق الزبون', 'Approved')
                  : h.state === 'rejected'
                    ? loc('رفض الزبون', 'Rejected')
                    : h.state === 'withdrawn'
                      ? loc('سُحب', 'Withdrawn')
                      : loc('أُلغي مع الطلب', 'Voided with the order')}
              </span>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={withdrawOpen}
        title={loc('سحب اقتراح السعر؟', 'Withdraw the price proposal?')}
        consequence={loc(
          'يبقى الطلب على سعره الحالي ويمكن متابعته فورًا، وتُعطَّل أزرار الموافقة لدى الزبون.',
          'The order keeps its current price and can move again right away; the customer’s approval buttons stop working.'
        )}
        confirmLabel={loc('سحب الاقتراح', 'Withdraw')}
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
