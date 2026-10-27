/**
 * ONE ORDER (/orders/:orderId, signed in): GET /orders/{id} — its state, what
 * was ordered at the quoted price, how it is paid, and, once paid, what was
 * added to the customer's account.
 *
 * AN UNPAID ORDER holds the workshop's stock until `stock_hold_expires_at`
 * (the server's time, counted down here); past it the order cannot be paid
 * and the expiry sweep closes it. Until then:
 *
 *   the Levonis wallet  POST /orders/{id}/pay/wallet, a money door: the
 *                       balance (GET /me/wallet) and the exact total are
 *                       shown, a confirmation is asked, and one
 *                       Idempotency-Key covers the intent and its retries.
 *                       INSUFFICIENT_BALANCE says what the wallet has and
 *                       what the order needs, and links to adding funds on
 *                       Levonis (`${mainSite}/wallet`) — nothing was charged.
 *                       Any awaiting order may be paid this way, whatever
 *                       method it was placed with.
 *   the workshop        cash or a transfer quoting the order number; an
 *                       admin confirms it. Nothing to press here.
 *   cancel              POST /orders/{id}/cancel, after a confirmation: the
 *                       held stock goes back on the shelf.
 *
 * The development payment door of the API is never offered (it is refused on
 * every deployed Worker, and no screen of this app calls it).
 */
import { useCallback, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { StatusChip } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Money } from '../../../components/ui/Money';
import { Skeleton } from '../../../components/ui/Skeleton';
import { GOVERNORATES } from '../../../lib/governorates';
import { formatFigure } from '../../../lib/localeNumber';
import { toast } from '../../../lib/toastStore';
import { cancelOrder, cloudErrorText, getOrder, getWallet, payOrderFromWallet, useIdempotencyKey } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDate, formatDateTime, formatDays, formatHours, formatIqd, formatQuantity } from '../../format';
import { header } from '../../strings/common';
import { cart as cartWords, checkout, goods, hours, orders as words, orderStatus, paymentMethod, paymentState } from '../../strings/store';
import { tx, useCloudText } from '../../text';
import type { OrderDetail, OrderLine } from '../../types';
import { Check, CloudErrorState, CloudPageSkeleton, ExternalLink, Hourglass, PageHeader, SectionHeader, Store, Truck, Wallet } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { AmountRows, bundleOf, lineDetail, lineTitle, Sentence, useNameBook, useNow, variantName, type NameBook } from './parts';
import { clockText, CLOCK_LIMIT_MS, deadline, orderCancellable, orderPayable, orderTone, payRefusal } from './rules';

const governorateName = (id: unknown, lang: 'ar' | 'en' | 'ckb'): string => {
  const g = GOVERNORATES.find((x) => x.id === id);
  return g ? g[lang] : typeof id === 'string' ? id : '';
};

// ------------------------------------------------------------------ paying

/** What a refused wallet payment means, in words, with the way forward. */
function PayRefusalText({ error }: { error: unknown }) {
  const { t, lang } = useCloudText();
  const { mainSite } = useCloud();
  const r = payRefusal(error);
  if (r.kind === 'insufficient') {
    return (
      <span className="block space-y-2">
        <span className="block font-semibold">{t(words.insufficientTitle)}</span>
        <span className="block">
          {r.available != null && r.required != null
            ? t(words.insufficientBody, { available: formatIqd(r.available, lang), required: formatIqd(r.required, lang) })
            : cloudErrorText(error, lang)}
        </span>
        {mainSite ? (
          <a href={`${mainSite}/wallet`} className="lv-button lv-button-secondary lv-button-sm">
            {t(header.walletAddFunds)}
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
          </a>
        ) : null}
      </span>
    );
  }
  return <span className="block">{refusalWords(error, t, lang)}</span>;
}

/** The sentence for a refusal other than a short wallet: why the order cannot be paid, or the server's own words. */
function refusalWords(error: unknown, t: (s: { ar: string; en: string; ckb: string }) => string, lang: 'ar' | 'en' | 'ckb'): string {
  const r = payRefusal(error);
  if (r.kind === 'not_payable') {
    const reason = { already_paid: words.notPayableAlreadyPaid, cancelled: words.notPayableCancelled, expired: words.notPayableExpired, shipment: words.notPayableShipment, other: null }[r.reason];
    return reason ? t(reason) : cloudErrorText(error, lang);
  }
  if (r.kind === 'wallet_off') return t(header.walletOff);
  return cloudErrorText(error, lang);
}

/** «12:34 left to pay» while there is a clock to show; the moment itself for a hold of more than a day. */
function HoldLine({ until, now }: { until: string; now: number }) {
  const { t, lang } = useCloudText();
  const left = deadline(until, now);
  if (left.passed) return null;
  return (
    <p className="flex items-start gap-2 text-[13px] leading-snug text-text-secondary">
      <Hourglass aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {left.msLeft < CLOCK_LIMIT_MS ? (
          <Sentence
            text={t(words.holdLeft)}
            slots={{
              clock: (
                <bdi dir="ltr" className="font-bold tabular-nums text-text-primary">
                  {clockText(left.msLeft)}
                </bdi>
              ),
            }}
          />
        ) : (
          t(words.holdUntil, { date: formatDateTime(until, lang) })
        )}
      </span>
    </p>
  );
}

function WalletPanel({ order, onPaid }: { order: OrderDetail; onPaid: () => void }) {
  const { t, lang } = useCloudText();
  const cloud = useCloud();
  const [walletVersion, setWalletVersion] = useState(0);
  const wallet = useCloudQuery((signal) => getWallet({ signal }), [walletVersion]);
  // One key for «pay this order», sent again on every retry of it — a replay answers the first payment.
  const intent = useIdempotencyKey('pay');
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<unknown>(null);
  const total = formatIqd(order.total_iqd, lang);

  const pay = async () => {
    setRefusal(null);
    try {
      await payOrderFromWallet(order.id, intent.key);
      intent.renew();
      setOpen(false);
      toast.success(t(words.paid));
      cloud.refreshDashboard();
      onPaid();
    } catch (e) {
      const r = payRefusal(e);
      if (r.kind === 'not_payable') {
        // The order moved on (paid elsewhere, cancelled, expired): say why, and show it as it now is.
        setOpen(false);
        toast.info(refusalWords(e, t, lang));
        onPaid();
        return;
      }
      setRefusal(e);
      if (r.kind === 'insufficient') setWalletVersion((v) => v + 1);
    }
  };

  const data = wallet.data;
  return (
    <div className="space-y-2 rounded-xl lv-well p-3">
      <p className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
        <Wallet aria-hidden="true" className="h-4 w-4" />
        {t(header.walletTitle)}
      </p>
      {wallet.error ? (
        <CloudErrorState compact error={wallet.error} onRetry={() => setWalletVersion((v) => v + 1)} />
      ) : !data ? (
        <Skeleton className="h-4 w-40 rounded" />
      ) : !data.connected ? (
        <p className="text-[13px] font-semibold text-warning">{t(header.walletOff)}</p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline justify-between gap-2 text-[13px] text-text-secondary">
            {t(header.walletAvailable)}
            <span className="text-sm font-bold text-text-primary">
              <Money iqd={data.available_iqd} />
            </span>
          </p>
          {data.available_iqd < order.total_iqd ? (
            <div className="space-y-2">
              <p className="text-[13px] font-semibold text-warning">{t(checkout.walletShort)}</p>
              {cloud.mainSite ? (
                <a href={`${cloud.mainSite}/wallet`} className="lv-button lv-button-secondary lv-button-sm">
                  {t(header.walletAddFunds)}
                  <ExternalLink aria-hidden="true" className="h-4 w-4" />
                </a>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setWalletVersion((v) => v + 1)}>
                {t(words.refreshBalance)}
              </Button>
            </div>
          ) : null}
          <Button
            variant="primary"
            block
            icon={<Wallet aria-hidden="true" className="h-4 w-4" />}
            onClick={() => {
              setRefusal(null);
              setOpen(true);
            }}
          >
            {t(words.payWallet, { total })}
          </Button>
        </>
      )}
      {refusal && !open ? (
        <div role="alert" className="lv-alert lv-alert-danger text-[13px] leading-relaxed text-text-primary">
          <PayRefusalText error={refusal} />
        </div>
      ) : null}
      <ConfirmDialog
        open={open}
        title={t(words.payConfirmTitle, { total })}
        consequence={data?.connected ? t(words.payConfirmBody, { balance: formatIqd(data.available_iqd, lang) }) : t(words.payConfirmPlain)}
        confirmLabel={t(words.payNow)}
        onConfirm={pay}
        onCancel={() => setOpen(false)}
        error={refusal ? <PayRefusalText error={refusal} /> : undefined}
      />
    </div>
  );
}

function ManualPanel({ order }: { order: OrderDetail }) {
  const { t, lang } = useCloudText();
  return (
    <div className="space-y-2 rounded-xl lv-well p-3">
      <p className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
        <Store aria-hidden="true" className="h-4 w-4" />
        {t(words.manualTitle)}
      </p>
      <p className="text-[13px] leading-relaxed text-text-secondary">{t(words.manualBody, { total: formatIqd(order.total_iqd, lang) })}</p>
      <p className="text-[12px] text-text-muted">{t(words.orderNumber)}</p>
      <p className="select-all break-all text-sm font-bold text-text-primary">
        <bdi dir="ltr">{order.id}</bdi>
      </p>
    </div>
  );
}

function PaySection({ order, now, onChanged }: { order: OrderDetail; now: number; onChanged: () => void }) {
  const { t } = useCloudText();
  const walletFirst = order.payment_method !== 'manual';
  return (
    <section className="lv-surface space-y-3 p-4" aria-labelledby="cloud-order-pay">
      <SectionHeader id="cloud-order-pay" title={t(words.payTitle)} />
      <HoldLine until={order.stock_hold_expires_at} now={now} />
      {walletFirst ? (
        <>
          <WalletPanel order={order} onPaid={onChanged} />
          <ManualPanel order={order} />
        </>
      ) : (
        <>
          <ManualPanel order={order} />
          <WalletPanel order={order} onPaid={onChanged} />
        </>
      )}
    </section>
  );
}

function CancelSection({ order, onCancelled }: { order: OrderDetail; onCancelled: () => void }) {
  const { t, lang } = useCloudText();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancel = async () => {
    setError(null);
    try {
      await cancelOrder(order.id);
      setOpen(false);
      toast.success(t(words.cancelled));
      onCancelled();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="flex justify-center">
      <Button
        variant="ghost"
        className="text-danger"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t(words.cancelOrder)}
      </Button>
      <ConfirmDialog
        open={open}
        destructive
        title={t(words.cancelTitle)}
        consequence={t(words.cancelBody)}
        confirmLabel={t(words.cancelOrder)}
        cancelLabel={t(words.keepOrder)}
        onConfirm={cancel}
        onCancel={() => setOpen(false)}
        error={error ? cloudErrorText(error, lang) : undefined}
      />
    </div>
  );
}

// ------------------------------------------------------------------ what was ordered, and received

function LineRows({ order, book }: { order: OrderDetail; book: NameBook }) {
  const { t, lang } = useCloudText();
  return (
    <ul className="divide-y divide-border-subtle">
      {order.lines.map((l) => {
        const base = typeof l.breakdown?.base_price_iqd === 'number' ? l.breakdown.base_price_iqd : null;
        const detail =
          l.kind === 'shipping_fee'
            ? governorateName(l.breakdown?.governorate, lang)
            : `${lineDetail(l, book, lang, t)}${l.kind === 'material' ? ` · ${l.fulfillment === 'delivery' ? t(goods.deliver) : t(goods.keep)}` : ''}`;
        return (
          <li key={l.id} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{lineTitle(l, book, lang, t)}</p>
              {detail ? <p className="text-[12px] text-text-muted">{detail}</p> : null}
            </div>
            <span className="flex shrink-0 flex-col items-end">
              <span className="text-sm font-bold text-text-primary">
                <Money iqd={l.final_price_iqd} />
              </span>
              {base != null && base > l.final_price_iqd ? (
                <span className="text-[11px] text-text-muted line-through">
                  <Money iqd={base} />
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One sentence per thing the paid order put into the account. */
function grantedOf(line: OrderLine, book: NameBook, lang: 'ar' | 'en' | 'ckb', t: (s: { ar: string; en: string; ckb: string }, v?: Record<string, string | number>) => string): string[] {
  const out: string[] = [];
  const named = (variantId: string, qty: number) => {
    const v = book.variant(variantId);
    const unit = v?.unit_code ?? (variantId === line.variant_id && typeof line.breakdown?.unit_code === 'string' ? line.breakdown.unit_code : null);
    return { qty: unit ? formatQuantity(qty, unit, lang) : formatFigure(qty, lang), name: v ? variantName(v, lang) : t(goods.material) };
  };
  if (line.kind === 'credit_package' || line.kind === 'credit_hours') {
    const cls = book.tier(line.tier_id);
    const validity = line.expires_after_days ? t(words.validDays, { days: formatDays(line.expires_after_days, lang) }) : t(hours.neverExpires);
    out.push(`${t(words.grantedHours, { hours: formatHours(line.seconds, lang), class: (cls && tx(cls, lang)) || t(hours.classFallback) })} · ${validity}`);
    for (const b of bundleOf(line)) out.push(t(words.includedItem, named(b.variant_id, b.qty)));
  } else if (line.kind === 'material' && line.variant_id) {
    const sentence = line.fulfillment === 'delivery' ? words.grantedDelivered : line.fulfillment === 'project' ? words.grantedProject : words.grantedKept;
    out.push(t(sentence, named(line.variant_id, line.quantity)));
  }
  return out;
}

function Granted({ order, book }: { order: OrderDetail; book: NameBook }) {
  const { t, lang } = useCloudText();
  const items = order.lines.flatMap((l) => grantedOf(l, book, lang, t));
  if (items.length === 0 && !order.shipment_id) return null;
  return (
    <section className="lv-surface space-y-2 p-4" aria-labelledby="cloud-order-granted">
      <SectionHeader id="cloud-order-granted" title={t(words.grantedTitle)} />
      <ul className="space-y-1.5">
        {items.map((text, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-text-secondary">
            <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            {text}
          </li>
        ))}
      </ul>
      {order.shipment_id ? (
        <Link to={`/account/shipments/${encodeURIComponent(order.shipment_id)}`} className="lv-button lv-button-secondary lv-button-sm">
          <Truck aria-hidden="true" className="h-4 w-4" />
          {t(words.followDelivery)}
        </Link>
      ) : null}
    </section>
  );
}

function Payments({ order }: { order: OrderDetail }) {
  const { t, lang } = useCloudText();
  if (order.payments.length === 0 && order.refunds.length === 0) return null;
  return (
    <section className="lv-surface space-y-3 p-4" aria-labelledby="cloud-order-payments">
      {order.payments.length > 0 ? (
        <>
          <SectionHeader id="cloud-order-payments" title={t(words.paymentsTitle)} />
          <ul className="divide-y divide-border-subtle">
            {order.payments.map((p) => {
              const method = paymentMethod[p.provider as keyof typeof paymentMethod];
              const state = paymentState[p.status as keyof typeof paymentState];
              return (
                <li key={p.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-text-primary">{method ? t(method) : p.provider}</p>
                    <p className="text-[12px] text-text-muted">
                      {state ? t(state) : p.status} · {formatDateTime(p.confirmed_at ?? p.created_at, lang)}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-bold text-text-primary">
                    <Money iqd={p.amount_iqd} />
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {order.refunds.length > 0 ? (
        <>
          <h3 className="text-[15px] font-bold text-text-primary">{t(words.refundsTitle)}</h3>
          <ul className="divide-y divide-border-subtle">
            {order.refunds.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-text-primary">{r.status === 'paid_out' || r.method === 'levonis_wallet' ? t(words.refundToWallet) : t(words.refundRecorded)}</p>
                  <p className="text-[12px] text-text-muted">
                    {r.reason ? <bdi>{r.reason}</bdi> : null}
                    {r.reason ? ' · ' : ''}
                    {formatDate(r.created_at, lang)}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-bold text-text-primary">
                  <Money iqd={r.amount_iqd} />
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function DeliveryAddressCard({ order }: { order: OrderDetail }) {
  const { t, lang } = useCloudText();
  const a = order.delivery_address;
  if (!a) return null;
  return (
    <section className="lv-surface space-y-1 p-4" aria-labelledby="cloud-order-address">
      <SectionHeader id="cloud-order-address" title={t(words.deliveryTo)} />
      <p className="text-[13px] font-semibold text-text-primary">{a.recipient_name}</p>
      <p className="text-[13px] text-text-secondary">
        <bdi dir="ltr">{a.phone}</bdi>
      </p>
      <p className="text-[13px] text-text-secondary">{[governorateName(a.governorate, lang), a.city, a.address_line].filter(Boolean).join(' · ')}</p>
      {a.notes ? <p className="text-[12px] text-text-muted">{a.notes}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------ the page

export default function OrderPage() {
  const { orderId = '' } = useParams();
  const location = useLocation();
  const placed = (location.state as { placed?: unknown } | null)?.placed === true;
  const { t, lang } = useCloudText();
  const [version, setVersion] = useState(0);
  const order = useCloudQuery((signal) => getOrder(orderId, { signal }), [orderId, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const current = order.data && order.data.id === orderId ? order.data : null;
  const book = useNameBook(current?.lines ?? []);
  const now = useNow();
  const back = { to: '/orders', label: t(words.title) };

  if (order.error && !current) {
    return (
      <div>
        <PageHeader title={t(words.orderTitle)} back={back} />
        <CloudErrorState error={order.error} onRetry={reload} />
      </div>
    );
  }
  if (!current) return <CloudPageSkeleton />;
  const o = current;
  const status = orderStatus[o.status as keyof typeof orderStatus];
  const method = paymentMethod[o.payment_method as keyof typeof paymentMethod];
  const awaiting = o.status === 'awaiting_payment';
  const payable = orderPayable(o, now);
  const paidOut = !!o.paid_at && (o.status === 'fulfilled' || o.status === 'partially_refunded' || o.status === 'refunded');
  const shipping = o.lines.find((l) => l.kind === 'shipping_fee');

  return (
    <div className="space-y-4">
      <PageHeader
        back={back}
        title={t(words.orderTitle)}
        subtitle={t(words.placedOn, { date: formatDateTime(o.created_at, lang) })}
        actions={<StatusChip tone={orderTone(o.status)}>{status ? t(status) : o.status}</StatusChip>}
      />

      {placed && awaiting && payable ? (
        <p role="status" className="flex items-start gap-2 rounded-xl lv-well px-3 py-2 text-[13px] leading-snug text-text-secondary">
          <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          {t(words.placedNote)}
        </p>
      ) : null}

      {awaiting ? (
        payable ? (
          <PaySection order={o} now={now} onChanged={reload} />
        ) : (
          <section role="alert" className="lv-surface space-y-1 p-4">
            <p className="flex items-center gap-2 text-[15px] font-bold text-text-primary">
              <Hourglass aria-hidden="true" className="h-4 w-4" />
              {t(words.holdPassedTitle)}
            </p>
            <p className="text-[13px] leading-relaxed text-text-muted">{t(words.holdPassedBody)}</p>
          </section>
        )
      ) : null}

      <section className="lv-surface space-y-3 p-4" aria-labelledby="cloud-order-lines">
        <SectionHeader id="cloud-order-lines" title={t(words.linesTitle)} />
        <LineRows order={o} book={book} />
        <AmountRows
          rows={[
            ...(o.discount_iqd > 0 || shipping ? [{ label: t(cartWords.subtotal), iqd: o.subtotal_iqd }] : []),
            ...(o.discount_iqd > 0 ? [{ label: t(goods.discount), iqd: o.discount_iqd, minus: true }] : []),
            { label: t(cartWords.total), iqd: o.total_iqd, strong: true },
            ...(o.paid_iqd > 0 ? [{ label: t(words.paidAmount), iqd: o.paid_iqd }] : []),
            ...(o.refunded_iqd > 0 ? [{ label: t(words.refundedAmount), iqd: o.refunded_iqd }] : []),
          ]}
        />
        {method ? <p className="text-[12px] text-text-muted">{t(method)}</p> : null}
        <p className="text-[12px] text-text-muted">
          {t(words.orderNumber)}: <bdi dir="ltr">{o.id}</bdi>
        </p>
      </section>

      {paidOut ? <Granted order={o} book={book} /> : null}
      <Payments order={o} />
      <DeliveryAddressCard order={o} />
      {orderCancellable(o) ? <CancelSection order={o} onCancelled={reload} /> : null}
    </div>
  );
}
