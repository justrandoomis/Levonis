/**
 * `/merchant/custom_orders/<id>` — ONE CUSTOM ORDER, IN FULL (Phase 5d,
 * docs/COMMUNITY_ECOSYSTEM.md §9.5 «Merchant custom order screen»).
 *
 * What the old expanded card in the custom-orders list could not hold: the
 * request's title and the customer as a chip, the money AS AGREED — the
 * total the customer confirmed, its work price and delivery fee from the
 * offer snapshot, and what reaches the workshop after Levonis's commission
 * (the escrow's own figures, never recomputed here) — the order's timeline
 * (src/components/community/requests/OrderTimeline.tsx: progress, photos,
 * «جاهز», the customer's change requests, cancel / dispute per the server's
 * policy, which this screen already read and hands down), and the contact
 * card the acceptance revealed.
 *
 * The two moves that are the workshop's alone — «ابدأ العمل» and «سلّمت
 * العمل» — sit in the header, exactly when GET /orders/:id says they may
 * (`can.start_work`, `can.mark_delivered`); delivery is asked first, because
 * it starts the customer's confirmation clock and releases nothing.
 *
 * A lazy chunk of the workspace: SalesTabs' custom tab opens it for a row
 * (or for the id a notification's address names) and never downloads it
 * otherwise.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Play, User } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { communityOrdersApi } from '../../../lib/merchant';
import { Money } from '../../ui/Money';
import { Button } from '../../ui/Button';
import { StatusChip } from '../../ui/Badge';
import { ErrorState, NotFoundState } from '../../ui/AsyncStates';
import { CardSkeleton } from '../../ui/DashboardSkeletons';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { merchantRefusal } from '../shell/refusal';
import { formatDate } from '../../orders/format';
import OrderContactCard from '../../community/offers/OrderContactCard';
import OrderTimeline from '../../community/requests/OrderTimeline';
import { deliveredConsequence, fill, ordersLang, useCustomOrderStrings, type CustomOrderStrings } from './strings';

/** The order as GET /api/marketplace/orders/:id answers it, the fields this screen reads. */
export interface CustomOrderView {
  id: string;
  state: string;
  /** THE TOTAL the customer confirmed — the money identity (price + delivery fee). */
  price_iqd: number;
  completion_days: number | null;
  delivery_method: string;
  request_title: string;
  customer_name: string;
  auto_complete_at: string | null;
  /** The admin's confirmation window in days (0 = none) — what «سلّمت العمل» may promise before delivery. */
  auto_complete_days: number | null;
  /** «جاهز» (0160): a moment inside `in_progress`, never a state. */
  ready_at: string | null;
  snapshot: { price_iqd: number | null; delivery_fee_iqd: number; quantity: number | null; color: string; terms: string };
  escrow: { merchant_receivable_iqd: number | null; platform_fee_iqd: number | null } | null;
  can: { start_work: boolean; mark_delivered: boolean; cancel: boolean; dispute: boolean };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The server's row, read defensively: an order accepted before 0159 has no fee in its snapshot. */
export function readCustomOrder(d: { order: Record<string, unknown>; escrow: Record<string, unknown> | null; can: Record<string, boolean>; auto_complete_days?: unknown }): CustomOrderView {
  const o = d.order;
  const snap = (o.offer_snapshot && typeof o.offer_snapshot === 'object' ? o.offer_snapshot : {}) as Record<string, unknown>;
  const req = (o.request_snapshot && typeof o.request_snapshot === 'object' ? o.request_snapshot : {}) as Record<string, unknown>;
  return {
    id: text(o.id),
    state: text(o.state),
    price_iqd: num(o.price_iqd) ?? 0,
    completion_days: num(o.completion_days),
    delivery_method: text(o.delivery_method),
    request_title: text(o.request_title) || text(req.title),
    customer_name: text(o.customer_name),
    auto_complete_at: typeof o.auto_complete_at === 'string' ? o.auto_complete_at : null,
    auto_complete_days: num(d.auto_complete_days),
    ready_at: typeof o.ready_at === 'string' && o.ready_at ? o.ready_at : null,
    snapshot: {
      price_iqd: num(snap.price_iqd),
      delivery_fee_iqd: num(snap.delivery_fee_iqd) ?? 0,
      quantity: num(snap.quantity),
      color: text(snap.color),
      terms: text(snap.terms),
    },
    escrow: d.escrow ? { merchant_receivable_iqd: num(d.escrow.merchant_receivable_iqd), platform_fee_iqd: num(d.escrow.platform_fee_iqd) } : null,
    can: {
      start_work: !!d.can?.start_work,
      mark_delivered: !!d.can?.mark_delivered,
      cancel: !!d.can?.cancel,
      dispute: !!d.can?.dispute,
    },
  };
}

export function stateTone(state: string): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' {
  switch (state) {
    case 'funded': return 'accent';
    case 'in_progress': return 'info';
    case 'merchant_marked_delivered': return 'warning';
    case 'completed': return 'success';
    case 'disputed': return 'danger';
    default: return 'neutral';
  }
}

export function stateWord(state: string, s: CustomOrderStrings): string {
  const words = s.state as Record<string, string>;
  return words[state] ?? state;
}

/** The work price: the snapshot's own when the offer carried one (0159), else the total less the fee. */
export function workPrice(o: Pick<CustomOrderView, 'price_iqd' | 'snapshot'>): number {
  const fee = o.snapshot.delivery_fee_iqd;
  return o.snapshot.price_iqd ?? (fee > 0 ? o.price_iqd - fee : o.price_iqd);
}

export default function CustomOrderScreen({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged?: () => void }) {
  const { lang, dir } = useLanguage();
  const s = useCustomOrderStrings();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [order, setOrder] = useState<CustomOrderView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  // A move made here («ابدأ العمل», «سلّمت العمل») is a row on the timeline too.
  const [moves, setMoves] = useState(0);

  const load = useCallback(() => {
    setError(null);
    return communityOrdersApi
      .get(id)
      .then((d) => setOrder(readCustomOrder(d)))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(e);
      });
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  // Opened from its row, the screen takes focus at its heading — once, when the order arrives —
  // so the reader starts where the page starts, not on a <body> the row left behind.
  const headed = useRef(false);
  useEffect(() => {
    if (!order || headed.current) return;
    headed.current = true;
    document.getElementById(`custom-order-${id}-title`)?.focus();
  }, [order, id]);

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const back = (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-[13px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      data-custom-order-back
    >
      <Back aria-hidden="true" className="h-4 w-4" />
      {s.back}
    </button>
  );

  const changed = () => {
    void load();
    onChanged?.();
  };
  const moved = () => {
    setMoves((n) => n + 1);
    changed();
  };

  const start = async () => {
    setBusy('start');
    setProblem('');
    try {
      await communityOrdersApi.start(id);
      moved();
    } catch (e) {
      setProblem(merchantRefusal(e, lang, s.startFailed));
      // The card shows the order as it now stands, whichever way it went.
      changed();
    } finally {
      setBusy('');
    }
  };

  const deliver = async () => {
    // The update toasts already said their piece; left up, they sat on the dialog's own buttons (review 2026-09-30).
    toast.dismiss();
    const ok = await confirm({
      title: s.deliveredTitle,
      // The window is the server's (admin setting; 0 = no auto-release), never a number in the copy.
      consequence: deliveredConsequence(s, order?.auto_complete_days, ordersLang(lang)),
      confirmLabel: s.delivered,
      cancelLabel: s.keep,
    });
    if (!ok) return;
    setBusy('deliver');
    setProblem('');
    try {
      await communityOrdersApi.delivered(id);
      moved();
    } catch (e) {
      toast.error(merchantRefusal(e, lang, s.deliverFailed));
    } finally {
      setBusy('');
    }
  };

  if (missing) {
    return (
      <div className="space-y-3" data-custom-order-screen={id}>
        {back}
        <NotFoundState title={s.notFound} />
      </div>
    );
  }
  if (error && !order) {
    return (
      <div className="space-y-3" data-custom-order-screen={id}>
        {back}
        <ErrorState error={error} onRetry={() => void load()} compact />
      </div>
    );
  }
  if (!order) {
    return (
      <div className="space-y-3" aria-busy="true" data-custom-order-screen={id}>
        {back}
        <CardSkeleton lines={4} />
        <CardSkeleton lines={5} />
      </div>
    );
  }

  const fee = order.snapshot.delivery_fee_iqd;
  const deliveryWords = s.delivery as Record<string, string>;
  const facts: string[] = [];
  // Latin digits, as the money beside them (`iqd`) and the timeline's times are written.
  if (order.completion_days) facts.push(fill(s.days, { n: order.completion_days }));
  if (order.snapshot.quantity && order.snapshot.quantity > 1) facts.push(`${s.quantity}: ${order.snapshot.quantity}`);
  if (order.snapshot.color) facts.push(`${s.color}: ${order.snapshot.color}`);
  if (deliveryWords[order.delivery_method]) facts.push(deliveryWords[order.delivery_method]);
  const ready = !!order.ready_at && order.state === 'in_progress';

  return (
    <div className="space-y-3" data-custom-order-screen={id} data-custom-order-state={order.state}>
      {back}

      {/* THE HEADER: what was agreed, and the workshop's own two moves. */}
      <section className="rounded-2xl border border-border-subtle bg-surface p-4" aria-labelledby={`custom-order-${id}-title`}>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-48">
            <p className="text-[11px] font-semibold text-text-muted">{s.title}</p>
            <h2 id={`custom-order-${id}-title`} tabIndex={-1} dir="auto" className="break-words rounded text-start text-[17px] font-bold leading-snug text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              {order.request_title}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusChip tone={stateTone(order.state)}>{stateWord(order.state, s)}</StatusChip>
            {ready && (
              <span data-custom-order-ready>
                <StatusChip tone="success" icon={<Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}>
                  {s.readyChip}
                </StatusChip>
              </span>
            )}
          </div>
        </div>

        {order.customer_name && (
          <p className="mt-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-raised px-2.5 py-1 text-[12px] text-text-secondary" data-custom-order-customer>
              <User aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
              <span className="text-text-muted">{s.customer}:</span>
              <bdi className="font-semibold text-text-primary">{order.customer_name}</bdi>
            </span>
          </p>
        )}

        {/* One figure per line on a phone (a dinar amount and its label side by side); two columns from `sm`. */}
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-2">
          <div className="flex items-baseline justify-between gap-2 border-b border-border-subtle pb-2 sm:col-span-2">
            <dt className="text-text-muted">{s.total}</dt>
            <dd className="text-[17px] font-bold text-text-primary" data-custom-order-total>
              <Money iqd={order.price_iqd} />
            </dd>
          </div>
          {fee > 0 && (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-text-muted">{s.itemPrice}</dt>
                <dd className="text-text-secondary"><Money iqd={workPrice(order)} /></dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-text-muted">{s.deliveryFee}</dt>
                <dd className="text-text-secondary" data-custom-order-fee><Money iqd={fee} /></dd>
              </div>
            </>
          )}
          {order.escrow?.merchant_receivable_iqd != null && (
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-text-muted">{s.youGet}</dt>
              <dd className="font-semibold text-gold"><Money iqd={order.escrow.merchant_receivable_iqd} /></dd>
            </div>
          )}
          {order.escrow?.platform_fee_iqd != null && (
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-text-muted">{s.commission}</dt>
              <dd className="text-text-secondary"><Money iqd={order.escrow.platform_fee_iqd} /></dd>
            </div>
          )}
        </dl>

        {facts.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5 text-[11.5px] text-text-secondary">
            {facts.map((f) => (
              <li key={f} className="rounded-full border border-border-subtle bg-surface-raised px-2 py-0.5">
                {f}
              </li>
            ))}
          </ul>
        )}
        {order.snapshot.terms && (
          <p dir="auto" className="mt-2 text-start text-[12px] leading-relaxed text-text-muted">
            <span className="font-semibold text-text-secondary">{s.terms}:</span> {order.snapshot.terms}
          </p>
        )}

        {(order.can.start_work || order.can.mark_delivered || order.state === 'merchant_marked_delivered' || problem) && (
          <div className="mt-3 space-y-2">
            {order.can.start_work && (
              <Button variant="primary" block loading={busy === 'start'} icon={<Play aria-hidden="true" className="h-4 w-4" />} onClick={start} data-custom-order-start>
                {s.start}
              </Button>
            )}
            {order.can.mark_delivered && (
              <Button variant="primary" block loading={busy === 'deliver'} icon={<Check aria-hidden="true" className="h-4 w-4" />} onClick={deliver} data-custom-order-deliver>
                {s.delivered}
              </Button>
            )}
            {order.state === 'merchant_marked_delivered' && (
              <p className="text-[12px] leading-relaxed text-text-muted">
                {s.awaiting}
                {order.auto_complete_at && ` ${fill(s.autoConfirm, { d: formatDate(order.auto_complete_at, lang) })}`}
              </p>
            )}
            {problem && (
              <p role="alert" className="lv-field-error">
                {problem}
              </p>
            )}
          </div>
        )}
      </section>

      {/* THE TIMELINE: the record, the composer, «جاهز», cancel / dispute per the policy read above. */}
      <section className="rounded-2xl border border-border-subtle bg-surface p-4" aria-labelledby={`custom-order-${id}-timeline`}>
        <h3 id={`custom-order-${id}-timeline`} className="mb-3 text-[14px] font-bold text-text-primary">
          {s.timeline}
        </h3>
        <OrderTimeline orderId={id} actions={{ cancel: order.can.cancel, dispute: order.can.dispute }} onChanged={changed} refreshKey={moves} />
      </section>

      {/* THE CONTACT the acceptance revealed — withdrawn by the server once the order is closed without the job. */}
      <section className="rounded-2xl border border-border-subtle bg-surface p-4" aria-labelledby={`custom-order-${id}-contact`}>
        <h3 id={`custom-order-${id}-contact`} className="mb-2 text-[14px] font-bold text-text-primary">
          {s.contact}
        </h3>
        <OrderContactCard orderId={id} compact />
      </section>

      {confirmDialog}
    </div>
  );
}
