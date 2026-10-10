/**
 * «شراء سريع — قيد التجميع» — THE OPEN SESSION AT THE TOP OF «طلباتي»
 * (docs/GIFTS_QUICK_BUY.md §3.5).
 *
 * During its window a Quick Buy session is a draft, not an order (D10): it
 * appears here, above the order list, and nowhere in the admin queue. The
 * card shows exactly what the server holds — every price, fee, total and
 * held amount is the session's own figure; nothing is added up here — and
 * lets the customer change it while the window is open:
 *
 *   · each line: picture, name (opens the product), option and colour, unit
 *     price, line total, the shop's one quantity stepper (ceiling = the
 *     server's `max_qty`) and remove;
 *   · the totals, the amount held in the Levo Wallet, the address and the
 *     delivery — standard, and «توصيل عادي مجاني — للدفع الكامل من محفظة
 *     Levo» when the server applied the wallet waiver;
 *   · the time left, live: `expires_at` against the server's clock (the store
 *     keeps the offset from `server_now`), redrawn by the shared 1 Hz beat.
 *
 * AT 00:00 EVERYTHING LOCKS — and the same when the server says the session
 * can no longer be edited (`editable: false`). The store asks the server once
 * at zero; GET /session submits an expired session on the spot.
 *
 * AFTER THE 30 MINUTES THE ORDER IS AN ORDINARY ORDER, 100% (owner spec §13).
 * The session closes and the cart's own checkout door creates an ordinary
 * order — same model, statuses, cancellation, refund and notifications;
 * `order_kind = 'quick_buy'` is a label for reports. So this card exists ONLY
 * while the session is open: the moment the server reports it submitted, the
 * card is gone, the page's list (read again by «طلباتي») shows the order as
 * any other order card, and all this card leaves behind is one transient
 * line — a toast «تم إرسال طلب الشراء السريع» with the way to
 * `/orders/<order_id>` — and only for a customer who watched it close here.
 * A session the server could not submit is cancelled by the system and its
 * whole hold returned (DECISIONS row 188); for a day one line says so — there
 * is no order to show and nothing for anyone at Levonis to do.
 *
 * NAMES are the reader's language (Arabic, Sorani or English, as the view
 * carries all three); the free-delivery line is the server's own label.
 *
 * EDITS ARE ONE REQUEST PER DECISION. A held «+» settles before anything is
 * sent (450 ms), a typed figure is sent on commit, a line never has two
 * writes in flight, and every write carries one idempotency key per value —
 * the same key again if that same write is retried.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MapPin, RefreshCw, Trash2, Truck, Zap } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { ApiError } from '../../lib/api';
import {
  cancelQuickBuySession,
  IdempotentAction,
  removeQuickBuyItem,
  updateQuickBuyItem,
  withBusyRetry,
  type QuickBuyItemView,
  type QuickBuySessionView,
} from '../../lib/quickBuy';
import {
  formatQuickBuyClock,
  isQuickBuyNotSubmitted,
  quickBuyDeadline,
  quickBuyRemainingMs,
  refreshQuickBuySession,
  useQuickBuyNow,
  useQuickBuySnapshot,
  type QuickBuySnapshot,
} from '../../lib/quickBuyStore';
import { toast } from '../../lib/toastStore';
import { useMotion } from '../../lib/motion';
import SafeImage from '../ui/SafeImage';
import Spinner from '../ui/Spinner';
import { IconButton } from '../ui/Button';
import { QuantityInput } from '../ui/QuantityInput';
import { useConfirm } from '../ui/ConfirmDialog';
import { addressLine, freeDeliveryLabel, quickBuyItemName, quickBuyItemVariant } from './format';
import { quickBuyRefusal, quickBuyStrings, type QuickBuyStrings } from './strings';

const STEP_SETTLE_MS = 450;

/**
 * Quantities as the customer is choosing them, sent one write at a time.
 * `drafts` is what the stepper shows until the server's answer replaces it.
 */
function useQuantityWriter(owner: string | null, onFailure: (err: unknown) => void) {
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const wanted = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sending = useRef(new Set<string>());
  const actions = useRef(new Map<string, IdempotentAction>());
  const failRef = useRef(onFailure);
  failRef.current = onFailure;

  const forget = useCallback((itemId: string) => {
    wanted.current.delete(itemId);
    setDrafts((d) => {
      if (!(itemId in d)) return d;
      const next = { ...d };
      delete next[itemId];
      return next;
    });
  }, []);

  const flush = useCallback(
    async (itemId: string) => {
      timers.current.delete(itemId);
      const qty = wanted.current.get(itemId);
      if (qty === undefined || sending.current.has(itemId)) return;
      sending.current.add(itemId);
      let action = actions.current.get(itemId);
      if (!action) {
        action = new IdempotentAction();
        actions.current.set(itemId, action);
      }
      let failed = false;
      try {
        await action.run(`qty:${itemId}:${qty}`, (key) => withBusyRetry(() => updateQuickBuyItem(itemId, qty, key, owner)));
      } catch (err) {
        failed = true;
        forget(itemId);
        failRef.current(err);
      } finally {
        sending.current.delete(itemId);
      }
      if (failed) return;
      // A newer choice arrived while this one was on its way: send that one next.
      if (wanted.current.get(itemId) === qty) forget(itemId);
      else if (wanted.current.has(itemId) && !timers.current.has(itemId)) void flush(itemId);
    },
    [forget, owner]
  );

  const change = useCallback(
    (itemId: string, qty: number, how: 'step' | 'type' | 'clamp') => {
      wanted.current.set(itemId, qty);
      setDrafts((d) => ({ ...d, [itemId]: qty }));
      const pending = timers.current.get(itemId);
      if (pending) clearTimeout(pending);
      if (how === 'type') void flush(itemId);
      else timers.current.set(itemId, setTimeout(() => void flush(itemId), STEP_SETTLE_MS));
    },
    [flush]
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    []
  );

  return { drafts, change, forget };
}

function Row({ label, value, strong = false, tone }: { label: React.ReactNode; value: React.ReactNode; strong?: boolean; tone?: 'success' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={`min-w-0 ${tone === 'success' ? 'text-success' : strong ? 'font-bold text-text-primary' : 'text-text-secondary'}`}>{label}</dt>
      <dd className={`shrink-0 tabular-nums ${strong ? 'text-[15px] font-black text-text-primary' : 'text-text-primary'}`}>
        {typeof value === 'string' ? <bdi>{value}</bdi> : value}
      </dd>
    </div>
  );
}

/**
 * The time left and the window as a bar — the only part of the card that
 * redraws every second (the shared beat, src/lib/secondTicker.ts). It reads
 * the server's deadline against the server's clock and says ONCE, through
 * `onTimeUp`, when it reaches zero.
 */
function SessionClock({
  snap,
  session,
  t,
  reduced,
  onTimeUp,
}: {
  snap: QuickBuySnapshot;
  session: QuickBuySessionView;
  t: QuickBuyStrings;
  reduced: boolean;
  onTimeUp: () => void;
}) {
  const open = session.state === 'open';
  const now = useQuickBuyNow(open);
  const left = quickBuyRemainingMs(snap, now);
  const up = open && left !== null && left <= 0;
  useEffect(() => {
    if (up) onTimeUp();
  }, [up, onTimeUp]);
  const clock = formatQuickBuyClock(left ?? 0);
  const startedAt = Date.parse(session.started_at);
  const endsAt = Date.parse(session.expires_at);
  const windowMs = Number.isFinite(startedAt) && Number.isFinite(endsAt) && endsAt > startedAt ? endsAt - startedAt : 0;
  const share = windowMs > 0 && left !== null ? Math.min(1, Math.max(0, left / windowMs)) : 0;
  return (
    <>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-[12px] text-text-muted">{t.timeLeft}</p>
          <p role="timer" aria-label={t.timerAria(clock)} className="text-3xl font-black tabular-nums leading-tight text-text-primary" data-quick-buy-clock>
            <bdi dir="ltr">{clock}</bdi>
          </p>
        </div>
        {open && !up ? <p className="max-w-[16rem] text-[12px] leading-relaxed text-text-muted">{t.autoSend}</p> : null}
      </div>
      {/* The window as a bar: the server's start and end, the server's now. */}
      <div aria-hidden="true" className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-raised">
        <div
          className="h-full rounded-full bg-gold"
          style={{ width: `${(share * 100).toFixed(2)}%`, transition: reduced ? 'none' : 'width 1s linear' }}
        />
      </div>
    </>
  );
}

export default function QuickBuyOrderCard() {
  const { lang } = useLanguage();
  const { user } = useAuth();
  const owner = user?.id ?? null;
  const { money, moneyBoth } = useMoney();
  const m = useMotion();
  const t = quickBuyStrings(lang);
  const snap = useQuickBuySnapshot(owner);
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
  const [removing, setRemoving] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [checking, setChecking] = useState(false);
  const removeActions = useRef(new Map<string, IdempotentAction>());
  const cancelAction = useRef(new IdempotentAction());

  // The card is the OPEN session and nothing else (owner spec §13).
  const session: QuickBuySessionView | null = snap.session?.state === 'open' ? snap.session : null;
  const open = !!session;

  // The one line a submission leaves here: a toast with the way to the order
  // it became — for the session this card showed open, once.
  const watched = useRef<string | null>(null);
  const told = useRef<string | null>(null);
  const recent = snap.recent;
  useEffect(() => {
    if (session) {
      watched.current = session.id;
      return;
    }
    const orderId = recent?.state === 'submitted' ? recent.order_id : null;
    if (!recent || !orderId || recent.id !== watched.current || told.current === recent.id) return;
    told.current = recent.id;
    toast.success(t.submittedTitle, {
      id: 'quick-buy',
      // The id is an LTR island inside the sentence, never the sentence inside an LTR island.
      description: t.submittedBody(`⁦${orderId}⁩`),
      action: { label: t.viewOrder, onClick: () => navigate(`/orders/${encodeURIComponent(orderId)}`) },
    });
  }, [session, recent, t, navigate]);
  // The card re-renders when the window CLOSES, not every second: the clock
  // below owns the beat and says once when it reaches zero. A deadline that
  // had already passed when the server answered is closed from the start —
  // and so is a session the server itself says can no longer be edited.
  const deadline = quickBuyDeadline(snap);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const onTimeUp = useCallback(() => setClosedAt(deadline), [deadline]);
  const timeUp = open && ((deadline !== null && (closedAt === deadline || deadline <= snap.receivedAt)) || session?.editable === false);
  const editable = open && !timeUp;

  /** A refusal said in a toast; the ones that mean "the server moved on" also re-read it. */
  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.code === 'ABORTED') return;
      const code = err instanceof ApiError ? err.code ?? '' : '';
      if (code === 'QUICK_BUY_EXPIRED') {
        toast.info(t.expiredEdit, { id: 'quick-buy' });
      } else {
        const said = quickBuyRefusal(err, lang, moneyBoth);
        toast.error(said.title, { id: 'quick-buy', description: said.description });
      }
      if (
        ['QUICK_BUY_EXPIRED', 'QUICK_BUY_NO_SESSION', 'QUICK_BUY_ITEM_NOT_FOUND', 'QTY_UNAVAILABLE', 'OUT_OF_STOCK', 'QUICK_BUY_BUSY'].includes(code)
      ) {
        void refreshQuickBuySession(owner);
      }
    },
    [lang, moneyBoth, t, owner]
  );

  const { drafts, change, forget } = useQuantityWriter(owner, fail);

  const remove = async (item: QuickBuyItemView) => {
    if (!session || !editable || removing) return;
    const last = session.items.length === 1;
    if (last) {
      const ok = await confirm({
        title: t.removeLastTitle,
        consequence: t.removeLastConsequence,
        confirmLabel: t.removeConfirm,
        cancelLabel: t.keepOrder,
        destructive: true,
      });
      if (!ok) return;
    }
    setRemoving(item.id);
    forget(item.id);
    let action = removeActions.current.get(item.id);
    if (!action) {
      action = new IdempotentAction();
      removeActions.current.set(item.id, action);
    }
    try {
      const next = await action.run(`remove:${item.id}`, (key) => withBusyRetry(() => removeQuickBuyItem(item.id, key, owner)));
      toast.success(next ? t.removed : t.cancelled, { id: 'quick-buy' });
    } catch (err) {
      fail(err);
    } finally {
      setRemoving(null);
    }
  };

  const cancelSession = async () => {
    if (!editable || cancelling) return;
    const ok = await confirm({
      title: t.cancelTitle,
      consequence: t.cancelConsequence,
      confirmLabel: t.cancelConfirm,
      cancelLabel: t.keepOrder,
      destructive: true,
    });
    if (!ok) return;
    setCancelling(true);
    try {
      await cancelAction.current.run(`cancel:${session?.id ?? ''}`, (key) => withBusyRetry(() => cancelQuickBuySession(key, owner)));
      toast.success(t.cancelled, { id: 'quick-buy' });
    } catch (err) {
      fail(err);
    } finally {
      setCancelling(false);
    }
  };

  const recheck = async () => {
    setChecking(true);
    await refreshQuickBuySession(owner);
    setChecking(false);
  };

  // ------------------------------------------------- after the window
  if (!session) {
    // Submitted: the order is in the list like any other — nothing more here.
    // Not submitted: cancelled and refunded by the system, so one line says so.
    return isQuickBuyNotSubmitted(recent) ? (
      <p role="status" className="lv-alert lv-alert-warning mb-4 text-[13px] leading-relaxed" data-quick-buy-notice="not-submitted">
        {t.failedNotice}
      </p>
    ) : null;
  }

  // ------------------------------------------------- the open session
  const free = session.free_delivery?.applied === true;
  // The server's own words for the waiver, in the reader's language (all three travel with the view).
  const freeLabel = freeDeliveryLabel(session.free_delivery, lang, t.freeDelivery);
  const itemCount = session.items.reduce((n, it) => n + (Number(it.qty) || 0), 0);
  // The pill says what the session is doing NOW: collecting, or sending (the
  // window closed and the order is being written).
  const pill = timeUp
    ? { text: t.sending, cls: 'bg-surface-raised text-text-secondary' }
    : { text: t.collecting, cls: 'bg-gold/10 text-gold' };

  return (
    <section aria-label={t.regionLabel} className="lv-surface mb-4 overflow-hidden" data-quick-buy-card={session.state}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-black text-text-primary">
            <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <Zap className="w-4 h-4 fill-current" strokeWidth={1.9} />
            </span>
            <span className="truncate">{t.cardTitle}</span>
          </h2>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${pill.cls}`} data-quick-buy-pill>
            {pill.text}
          </span>
        </div>

        <SessionClock snap={snap} session={session} t={t} reduced={m.reduced} onTimeUp={onTimeUp} />

        {timeUp ? (
          <div role="status" className="lv-alert lv-alert-info mt-3 flex items-center justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2">
              <Spinner size="sm" delayMs={0} decorative />
              {t.locked}
            </span>
            <button
              type="button"
              onClick={() => void recheck()}
              disabled={checking}
              className="lv-button lv-button-ghost lv-button-sm shrink-0"
            >
              <RefreshCw aria-hidden="true" className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
              {t.refresh}
            </button>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border-subtle px-4">
        <h3 className="pt-3 text-[13px] font-bold text-text-secondary">{t.itemsHeading(itemCount)}</h3>
        <ul className="divide-y divide-border-subtle">
          {session.items.map((item) => {
            const draft = drafts[item.id];
            const pending = draft !== undefined && draft !== item.qty;
            const name = quickBuyItemName(item, lang);
            const variant = quickBuyItemVariant(item);
            const href = item.slug ? `/product/${encodeURIComponent(item.slug)}` : null;
            const busyRow = removing === item.id;
            return (
              <li key={item.id} className={`flex gap-3 py-3 ${busyRow ? 'opacity-50' : ''}`} data-quick-buy-item={item.id}>
                {href ? (
                  <Link to={href} tabIndex={-1} aria-hidden="true" className="shrink-0">
                    <SafeImage src={item.image} alt="" className="h-16 w-16 rounded-lg" fit="contain" />
                  </Link>
                ) : (
                  <SafeImage src={item.image} alt="" className="h-16 w-16 shrink-0 rounded-lg" fit="contain" />
                )}
                <div className="min-w-0 flex-1">
                  {/* The name and the line's total on one line, the way a bag
                      reads; the total never wraps under its own currency. */}
                  <div className="flex items-start justify-between gap-2">
                    {href ? (
                      <Link
                        to={href}
                        title={t.openProduct}
                        className="line-clamp-2 min-w-0 rounded text-[14px] font-bold leading-snug text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <bdi>{name}</bdi>
                      </Link>
                    ) : (
                      <p className="line-clamp-2 min-w-0 text-[14px] font-bold leading-snug text-text-primary">
                        <bdi>{name}</bdi>
                      </p>
                    )}
                    <span
                      aria-busy={pending || undefined}
                      className={`shrink-0 whitespace-nowrap text-[14px] font-black tabular-nums text-text-primary transition-opacity ${pending ? 'opacity-50' : ''}`}
                    >
                      {money(item.line_total_iqd)}
                    </span>
                  </div>
                  {variant ? (
                    <p className="mt-0.5 text-[12px] text-text-secondary">
                      <bdi>{variant}</bdi>
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[12px] tabular-nums text-text-muted">{t.each(money(item.unit_price_iqd))}</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <QuantityInput
                      value={draft ?? item.qty}
                      max={Math.max(1, Number(item.max_qty) || 1)}
                      size="sm"
                      hintPlacement="above"
                      autoClamp={false}
                      disabled={!editable || busyRow}
                      label={t.qtyOf(name)}
                      onChange={(next, how) => change(item.id, next, how)}
                      data-testid={`quick-buy-qty-${item.id}`}
                    />
                    <IconButton
                      onClick={() => void remove(item)}
                      disabled={!editable || !!removing}
                      label={t.removeAria(name)}
                      title={t.remove}
                      data-quick-buy-remove={item.id}
                      icon={busyRow ? <Spinner size="sm" delayMs={0} decorative /> : <Trash2 aria-hidden="true" className="w-4 h-4" />}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border-t border-border-subtle p-4">
        <dl className="space-y-1.5 text-[13px]">
          <Row label={t.subtotal} value={money(session.items_iqd)} />
          {session.discount_iqd > 0 ? <Row label={t.discount} value={`−${money(session.discount_iqd)}`} tone="success" /> : null}
          {free ? (
            <Row
              label={freeLabel}
              tone="success"
              value={
                <>
                  {/* Two amounts side by side, each its own island: «د.ع» before a
                      digit would otherwise pull the next figure into it. */}
                  {session.shipping_before_iqd > 0 ? (
                    <s className="me-1.5 text-text-muted">
                      <bdi>{money(session.shipping_before_iqd)}</bdi>
                    </s>
                  ) : null}
                  <bdi>{money(session.shipping_iqd)}</bdi>
                </>
              }
            />
          ) : (
            <Row label={t.delivery} value={money(session.shipping_iqd)} />
          )}
          <Row label={t.total} value={moneyBoth(session.total_iqd)} strong />
          <Row label={t.held} value={moneyBoth(session.held_iqd)} />
        </dl>
      </div>

      <div className="space-y-3 border-t border-border-subtle p-4 text-[13px]">
        <div className="flex items-start gap-2.5">
          <MapPin aria-hidden="true" className="mt-0.5 w-4 h-4 shrink-0 text-text-muted" />
          <div className="min-w-0">
            <p className="text-[12px] text-text-muted">{t.deliverTo}</p>
            <p className="text-text-primary">
              {session.address.name} · <bdi dir="ltr">{session.address.phone}</bdi>
            </p>
            <p className="text-[12px] leading-relaxed text-text-secondary">{addressLine(session.address, lang)}</p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <Truck aria-hidden="true" className="mt-0.5 w-4 h-4 shrink-0 text-text-muted" />
          <p className="text-text-primary">
            <span className="text-text-muted">{t.deliveryMethod}: </span>
            {free ? freeLabel : t.standard}
          </p>
        </div>
        {editable ? (
          <button
            type="button"
            onClick={() => void cancelSession()}
            disabled={cancelling}
            className="lv-button lv-button-ghost lv-button-sm -ms-3 text-danger"
            data-quick-buy-cancel
          >
            {cancelling ? <Spinner size="sm" delayMs={0} decorative /> : null}
            {t.cancelSession}
          </button>
        ) : null}
      </div>
      {confirmDialog}
    </section>
  );
}
