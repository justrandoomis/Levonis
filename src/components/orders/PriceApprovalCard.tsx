/**
 * «مطلوب موافقتك على السعر الجديد» — the customer's half of a price change
 * (migration 0140, worker/lib/orderPriceAdjust.ts).
 *
 * Shown ONLY while the order is held for this decision (`order.price_hold_id`),
 * at the top of the order page, because nothing else about the order moves
 * until it is answered. Old price struck through, the new one large, the
 * shop's reason in its own words, and what it means at the door and for the
 * wallet — then two buttons, each behind a ConfirmDialog that states the
 * consequence (Apple HIG «Alerts»: the verb on the button, a way out).
 *
 * The decision names the PROPOSAL id this screen showed, so if the shop
 * withdrew and re-proposed in between, the tap is refused rather than applied
 * to a price the customer never saw. The same decision is also offered as the
 * inline buttons of the Telegram message.
 *
 * OWNER: Sorani to be written by hand — ar/en only here (loc falls back to Arabic).
 */
import { useCallback, useEffect, useState } from 'react';
import { BadgeDollarSign } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, type ApiOrder } from '../../lib/api';
import { apiRefusal, type Lang } from '../../lib/refusalStrings';
import { useMoney } from '../../CurrencyContext';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';

interface PendingAdjustment {
  id: string;
  old_total_iqd: number;
  new_total_iqd: number;
  delta_iqd: number;
  new_due_iqd: number;
  wallet_refund_iqd: number;
  reason: string;
  note: string;
  created_at: string;
}

export default function PriceApprovalCard({
  order,
  onDecided,
}: {
  order: ApiOrder;
  onDecided: (message: string) => void | Promise<void>;
}) {
  const { loc, lang } = useLanguage();
  const L = (lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar') as Lang;
  const { money, moneyBoth } = useMoney();
  const [pending, setPending] = useState<PendingAdjustment | null>(null);
  const [asking, setAsking] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState('');
  const hold = order.price_hold_id ?? null;

  const load = useCallback(async () => {
    if (!hold) {
      setPending(null);
      return;
    }
    try {
      const r = await api.get<{ pending: PendingAdjustment | null }>(`/api/orders/${encodeURIComponent(order.id)}/price-adjustment`);
      setPending(r.pending);
    } catch {
      setPending(null);
    }
  }, [hold, order.id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!hold || !pending) return null;
  const up = pending.delta_iqd > 0;

  const decide = async () => {
    if (!asking) return;
    setError('');
    try {
      await api.post(`/api/orders/${encodeURIComponent(order.id)}/price-adjustment/${pending.id}/${asking}`, {});
      const msg =
        asking === 'approve'
          ? loc('تمت الموافقة على السعر الجديد — نتابع تجهيز طلبك.', 'You approved the new price — we are continuing with your order.')
          : loc('رفضت السعر الجديد — بقي طلبك على سعره السابق وسنتواصل معك.', 'You rejected the new price — your order keeps its previous price and we will be in touch.');
      setAsking(null);
      await onDecided(msg);
    } catch (e) {
      setError(apiRefusal(e, L, loc('تعذّر حفظ قرارك. حاول مرة أخرى.', 'Your decision could not be saved. Try again.')));
    }
  };

  return (
    <section
      data-price-approval={pending.id}
      aria-labelledby="price-approval-title"
      className="rounded-2xl border border-warning/40 bg-warning/10 p-4 space-y-3"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning" aria-hidden>
          <BadgeDollarSign className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id="price-approval-title" className="text-[15px] font-bold text-text-primary">
            {loc('مطلوب موافقتك على السعر الجديد', 'Your approval is needed for a new price')}
          </h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">
            {loc('لن نتابع تجهيز طلبك حتى توافق على السعر أو ترفضه.', 'We will not continue preparing your order until you approve or reject the price.')}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-3">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div>
            <p className="text-[11.5px] text-text-muted">{loc('السعر السابق', 'Previous price')}</p>
            <p className="text-[14px] tabular-nums text-text-muted line-through">{money(pending.old_total_iqd)}</p>
          </div>
          <div className="text-end">
            <p className="text-[11.5px] text-text-muted">{loc('السعر الجديد', 'New price')}</p>
            <p className="text-[20px] font-black tabular-nums text-text-primary" data-price-new>
              {moneyBoth(pending.new_total_iqd)}
            </p>
            <p className={`text-[12px] font-bold tabular-nums ${up ? 'text-warning' : 'text-success'}`}>
              {up ? loc('زيادة', 'Increase') : loc('تخفيض', 'Decrease')} {money(Math.abs(pending.delta_iqd))}
            </p>
          </div>
        </div>
        <dl className="mt-3 space-y-1.5 border-t border-border-subtle pt-3 text-[13px]">
          <div>
            <dt className="text-text-muted text-[12px]">{loc('السبب', 'Reason')}</dt>
            <dd className="text-text-primary whitespace-pre-wrap" dir="auto">{pending.reason}</dd>
          </div>
          {pending.note && (
            <div>
              <dt className="text-text-muted text-[12px]">{loc('التفاصيل', 'Details')}</dt>
              <dd className="text-text-secondary whitespace-pre-wrap" dir="auto">{pending.note}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-muted text-[12px]">{loc('تدفع عند الاستلام', 'You pay on delivery')}</dt>
            <dd className="tabular-nums text-text-primary font-bold">{money(pending.new_due_iqd)}</dd>
          </div>
          {pending.wallet_refund_iqd > 0 && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-text-muted text-[12px]">{loc('يُعاد إلى محفظتك', 'Back to your wallet')}</dt>
              <dd className="tabular-nums text-success font-bold">{money(pending.wallet_refund_iqd)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="primary" block onClick={() => setAsking('approve')} data-action="price-approve">
          {loc('موافقة', 'Approve')}
        </Button>
        <Button variant="secondary" block onClick={() => setAsking('reject')} data-action="price-reject">
          {loc('رفض', 'Reject')}
        </Button>
      </div>

      <ConfirmDialog
        open={asking !== null}
        title={
          asking === 'approve'
            ? loc('الموافقة على السعر الجديد؟', 'Approve the new price?')
            : loc('رفض السعر الجديد؟', 'Reject the new price?')
        }
        consequence={
          asking === 'approve'
            ? pending.wallet_refund_iqd > 0
              ? loc(
                  `يصبح إجمالي طلبك ${money(pending.new_total_iqd)} ويُعاد ${money(pending.wallet_refund_iqd)} إلى محفظتك فورًا.`,
                  `Your order total becomes ${money(pending.new_total_iqd)} and ${money(pending.wallet_refund_iqd)} goes back to your wallet now.`
                )
              : loc(
                  `يصبح إجمالي طلبك ${money(pending.new_total_iqd)} وتدفع ${money(pending.new_due_iqd)} عند الاستلام.`,
                  `Your order total becomes ${money(pending.new_total_iqd)} and you pay ${money(pending.new_due_iqd)} on delivery.`
                )
            : loc(
                `يبقى طلبك على ${money(pending.old_total_iqd)}، وقد يتواصل معك المتجر أو يلغي الطلب إن تعذّر توفيره بهذا السعر.`,
                `Your order stays at ${money(pending.old_total_iqd)}; the shop may contact you or cancel the order if it cannot be supplied at that price.`
              )
        }
        confirmLabel={asking === 'approve' ? loc('موافقة', 'Approve') : loc('رفض السعر', 'Reject price')}
        destructive={asking === 'reject'}
        onConfirm={decide}
        onCancel={() => {
          setAsking(null);
          setError('');
        }}
        error={error || undefined}
        testId="price-approval-confirm"
      />
    </section>
  );
}
