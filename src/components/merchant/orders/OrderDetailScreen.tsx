/**
 * `/merchant/orders/:id` — ONE STORE ORDER, IN FULL (W3-B).
 *
 * What the old expanded row could not hold: the lines with their variant and
 * SKU snapshot; the customer and the delivery the checkout applied
 * (governorate, rule, fee, preparation days, pickup or delivery); the money
 * from the order's own LEDGER lines (gross, the commission line, the delivery
 * line, reversals, where the net sits now); and a TIMELINE of everything
 * recorded about the order — placed, each status move and who made it, the
 * customer's confirmation or the three-day release, a cancellation and its
 * refund, complaints, the chat. Nothing on it is invented: the events are
 * the server's (worker/routes/merchantOrders.ts); an expected release is
 * marked as expected, not as done.
 *
 * Moves are the server's flow; each asks first (useConfirm), and a refusal
 * is said in the merchant's words (shell/refusal.ts), never the raw reply.
 * «Print» prints a packing slip only (./orderPrint.css), not the workspace.
 *
 * OWNER: Sorani to be written by hand (every new line on this screen).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Copy, MapPin, MessageCircle, Phone, Printer, User } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { formatMoney, formatSignedMoney } from '../../../lib/money';
import { formatFigure } from '../../../lib/localeNumber';
import { governorateName } from '../../../../packages/shipping/src/iraqGovernorates';
import { merchantHref } from '../../../lib/merchantRoutes';
import { Button } from '../../ui/Button';
import { StatusChip } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { ErrorState, NotFoundState } from '../../ui/AsyncStates';
import { CardSkeleton, KpiRowSkeleton } from '../../ui/DashboardSkeletons';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { useWorkspace } from '../shell/context';
import { merchantRefusal } from '../shell/refusal';
import { dateLocale } from '../../orders/format';
import { orderDetailApi, type OrderRecord, type OrderTimeline } from './api';
import { ORDER_FLOW, orderStatusLabel, orderStatusTone } from './labels';
import { eventText, ledgerLineText } from './timelineText';
import './orderPrint.css';

type Lang = 'ar' | 'en' | 'ckb';

export default function OrderDetailScreen({ id }: { id: string }) {
  const { loc, lang, dir } = useLanguage();
  const ws = useWorkspace();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [order, setOrder] = useState<OrderRecord | null>(null);
  const [story, setStory] = useState<OrderTimeline | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  const [moving, setMoving] = useState('');

  const load = useCallback(() => {
    setError(null);
    Promise.all([orderDetailApi.order(id), orderDetailApi.timeline(id)])
      .then(([o, t]) => {
        setOrder(o.order);
        setStory(t);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(e);
      });
  }, [id]);
  useEffect(load, [load]);

  const L = lang as Lang;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(dateLocale(L), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const back = (
    <Link to={ws.href(merchantHref.orders())} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-text-secondary hover:text-text-primary" data-order-back>
      <Back aria-hidden="true" className="h-4 w-4" />
      {loc('كل الطلبات', 'All orders')}
    </Link>
  );

  if (missing) {
    return (
      <div className="space-y-3">
        {back}
        <NotFoundState title={loc('لا يوجد طلب بهذا الرقم في متجرك', 'There is no order with this number in your store')} />
      </div>
    );
  }
  if (error && !order) return <div className="space-y-3">{back}<ErrorState error={error} onRetry={load} compact /></div>;
  if (!order || !story) {
    return (
      <div className="space-y-3" aria-busy="true">
        {back}
        <KpiRowSkeleton count={3} />
        <CardSkeleton lines={6} />
      </div>
    );
  }

  const next = ORDER_FLOW[order.status] ?? [];
  const move = async (to: string) => {
    const cancel = to === 'cancelled';
    const ok = await confirm({
      ...(cancel
        ? {
            title: loc('إلغاء الطلب؟', 'Cancel this order?', 'هەڵوەشاندنەوە؟'),
            consequence: loc(
              'يُعاد إلى الزبون كامل ما دفعه في محفظته، وتعود الكمية إلى مخزونك، ويُحرَّر استخدام الكوبون. لا يمكن التراجع عن الإلغاء.',
              'The customer gets back everything they paid, to their wallet; the units return to your stock and the coupon use is released. A cancellation cannot be undone.'
            ),
            confirmLabel: loc('إلغاء الطلب', 'Cancel order', 'هەڵوەشاندنەوەی داواکاری'),
            cancelLabel: loc('الإبقاء على الطلب', 'Keep order', 'هێشتنەوەی داواکاری'),
            destructive: true,
          }
        : {
            title: loc(`تحويل الطلب إلى «${orderStatusLabel(to, loc)}»؟`, `Mark the order as “${orderStatusLabel(to, loc)}”?`),
            consequence:
              to === 'delivered'
                ? loc(
                    'يصلك المبلغ حين يؤكد الزبون الاستلام، أو تلقائيًا بعد 3 أيام ما لم تُفتح شكوى. يُبلَّغ الزبون.',
                    'Your money arrives when the customer confirms receipt — or automatically after 3 days unless a complaint is opened. The customer is told.'
                  )
                : loc('يُبلَّغ الزبون بالحالة الجديدة.', 'The customer is told about the new status.'),
            confirmLabel: orderStatusLabel(to, loc),
          }),
    });
    if (!ok) return;
    setMoving(to);
    try {
      await orderDetailApi.setStatus(id, to);
      toast.success(cancel ? loc('أُلغي الطلب وأُعيد المبلغ للزبون', 'Order cancelled and the customer refunded') : loc(`صار الطلب: ${orderStatusLabel(to, loc)}`, `Order is now: ${orderStatusLabel(to, loc)}`));
    } catch (e) {
      toast.error(merchantRefusal(e, L, loc('تعذّر تحديث الطلب', 'Could not update the order')));
    } finally {
      setMoving('');
      load();
    }
  };

  const openChat = async () => {
    if (story.chat) {
      ws.go(story.chat.link);
      return;
    }
    try {
      const r = await orderDetailApi.openChat(id);
      ws.go(ws.mainHref(`/chat/${r.chatId}`));
    } catch (e) {
      toast.error(merchantRefusal(e, L, loc('تعذّر فتح المحادثة', 'Could not open the chat')));
    }
  };

  const addr = order.address ?? {};
  const addressText = [addr.area, addr.address ?? addr.line1, addr.city, addr.landmark].filter((x) => typeof x === 'string' && x).join('، ');
  const gov = story.delivery.governorate ?? (typeof addr.governorate === 'string' ? addr.governorate : null);
  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast.success(loc('نُسخ', 'Copied', 'کۆپی کرا')),
      () => toast.error(loc('تعذّر النسخ', 'Could not copy'))
    );

  return (
    <div className="space-y-4" data-order-detail={id}>
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        {back}
        <Button variant="ghost" size="sm" icon={<Printer className="h-4 w-4" aria-hidden="true" />} onClick={() => window.print()} data-print-order>
          {loc('طباعة ملصق الشحن', 'Print packing slip')}
        </Button>
      </div>

      {/* ---- header */}
      <header className="lv-surface p-4 print:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[18px] font-bold leading-tight text-text-primary">
              <bdi dir="ltr">{id}</bdi>
            </h1>
            <p className="mt-1 text-[12.5px] text-text-muted">
              {loc('وصل في', 'Placed')} <bdi>{when(order.created_at)}</bdi>
            </p>
          </div>
          <StatusChip tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status, loc)}</StatusChip>
        </div>
        {next.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2" data-order-actions>
            {next.map((s) => (
              <Button
                key={s}
                variant={s === 'cancelled' ? 'ghost' : 'primary'}
                className={s === 'cancelled' ? 'text-danger' : ''}
                loading={moving === s}
                disabled={moving !== '' && moving !== s}
                onClick={() => move(s)}
                data-order-move={s}
              >
                {s === 'cancelled' ? loc('إلغاء الطلب', 'Cancel order', 'هەڵوەشاندنەوەی داواکاری') : orderStatusLabel(s, loc)}
              </Button>
            ))}
          </div>
        )}
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] print:hidden">
        <div className="min-w-0 space-y-4">
          {/* ---- items */}
          <Section title={loc('المنتجات', 'Items', 'بەرهەمەکان')}>
            <ul className="divide-y divide-border-subtle" data-order-items>
              {story.items.map((it) => (
                <li key={it.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface-raised">
                    {it.image && <img src={it.image} alt="" className="h-full w-full object-cover" loading="lazy" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold text-text-primary">{it.name}</p>
                    {it.option && <p className="text-[12px] text-text-secondary" dir="auto">{it.option}</p>}
                    {it.sku && (
                      <p className="text-[11.5px] text-text-muted">
                        SKU <bdi dir="ltr">{it.sku}</bdi>
                      </p>
                    )}
                    <p className="mt-0.5 text-[12px] text-text-muted">
                      <bdi dir="ltr">×{formatFigure(it.qty, 'en')}</bdi> · <Money iqd={it.unit_price_iqd} />
                    </p>
                  </div>
                  <Money iqd={it.line_total_iqd} className="shrink-0 text-[13.5px] font-semibold text-text-primary" />
                </li>
              ))}
            </ul>
          </Section>

          {/* ---- timeline */}
          <Section title={loc('ما حدث للطلب', 'What happened to this order')}>
            <ol className="relative" data-order-timeline>
              {story.events.map((e, i) => {
                const txt = eventText(e, loc, (v) => formatSignedMoney(v, L).replace(/^\+/, ''));
                const expected = e.kind === 'release_due';
                const dot =
                  txt.tone === 'success' ? 'bg-success' : txt.tone === 'danger' ? 'bg-danger' : txt.tone === 'warning' ? 'bg-warning' : txt.tone === 'info' ? 'bg-info' : 'bg-text-muted';
                return (
                  <li key={`${e.kind}-${i}`} className="relative flex gap-3 pb-4 last:pb-0" data-event={e.kind}>
                    {i < story.events.length - 1 && <span aria-hidden="true" className="absolute start-[5px] top-4 bottom-0 w-px bg-border-subtle" />}
                    <span
                      aria-hidden="true"
                      className={`relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full ring-2 ring-surface ${expected ? 'border-2 border-text-muted bg-transparent' : dot}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold leading-snug text-text-primary">
                        {txt.title}
                        {expected && <span className="ms-2 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-semibold text-text-secondary">{loc('متوقع', 'Expected')}</span>}
                      </p>
                      {txt.detail && <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">{txt.detail}</p>}
                      <p className="mt-0.5 text-[11.5px] text-text-muted">
                        <time dateTime={e.at}>{when(e.at)}</time>
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </Section>
        </div>

        <aside className="min-w-0 space-y-4">
          {/* ---- customer */}
          <Section title={loc('الزبون', 'Customer')}>
            <div className="space-y-2.5 text-[13px]">
              <p className="flex items-center gap-2 font-semibold text-text-primary">
                <User aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0 truncate">{order.customer_name}</span>
              </p>
              {order.customer_phone && (
                <div className="flex items-center justify-between gap-2">
                  <a href={`tel:${order.customer_phone}`} className="flex min-h-11 items-center gap-2 text-text-primary">
                    <Phone aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                    <bdi dir="ltr" className="tabular-nums">{order.customer_phone}</bdi>
                  </a>
                  <IconCopy label={loc('نسخ الرقم', 'Copy number')} onClick={() => copy(order.customer_phone)} />
                </div>
              )}
              {(gov || addressText) && (
                <div className="flex items-start justify-between gap-2">
                  <p className="flex items-start gap-2 text-text-secondary">
                    <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
                    <span className="min-w-0">{[gov ? governorateName(gov, L) : '', addressText].filter(Boolean).join('، ')}</span>
                  </p>
                  <IconCopy label={loc('نسخ العنوان', 'Copy address')} onClick={() => copy([gov ? governorateName(gov, L) : '', addressText].filter(Boolean).join('، '))} />
                </div>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="secondary" icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />} onClick={openChat} data-order-chat>
                  {loc('محادثة حول الطلب', 'Chat about this order', 'گفتوگۆ لەسەر داواکاری')}
                </Button>
                <Link
                  to={ws.href(merchantHref.customer(id))}
                  className="inline-flex min-h-11 items-center px-2 text-[13px] font-semibold text-text-secondary underline decoration-border-subtle underline-offset-2 hover:text-text-primary"
                  data-order-customer-link
                >
                  {loc('طلباته من متجرك', 'Their orders here')}
                </Link>
              </div>
            </div>
          </Section>

          {/* ---- delivery */}
          <Section title={loc('التوصيل', 'Delivery', 'گەیاندن')}>
            {story.delivery.recorded ? (
              <dl className="space-y-1.5 text-[13px]" data-order-delivery>
                <Row label={loc('الطريقة', 'Method')} value={story.delivery.fulfilment === 'pickup' ? loc('استلام من المتجر', 'Pickup') : loc('توصيل', 'Delivery', 'گەیاندن')} />
                {story.delivery.governorate && <Row label={loc('المحافظة', 'Governorate')} value={governorateName(story.delivery.governorate, L)} />}
                <Row label={loc('القاعدة المطبّقة', 'Rule applied')} value={ruleText(story.delivery.rule, loc)} />
                <Row label={loc('الرسوم', 'Fee')} value={<Money iqd={story.delivery.fee_iqd} />} />
                {story.delivery.prep_days !== null && (
                  <Row label={loc('أيام التجهيز', 'Preparation days')} value={<bdi>{formatFigure(story.delivery.prep_days, L)}</bdi>} />
                )}
              </dl>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-text-muted" data-order-delivery-legacy>
                {loc('طلب سبق التوصيل حسب المحافظة — رسومه', 'This order predates delivery by governorate — its fee was')} <Money iqd={order.shipping_iqd} />
              </p>
            )}
          </Section>

          {/* ---- money */}
          <Section title={loc('المال', 'Money')}>
            <dl className="space-y-1.5 text-[13px]" data-order-money>
              <Row label={loc('المنتجات', 'Items', 'بەرهەمەکان')} value={<Money iqd={order.subtotal_iqd} />} />
              {order.coupon_discount_iqd > 0 && (
                <Row label={<>{loc('كوبون', 'Coupon', 'کۆبۆن')} <bdi dir="ltr">{order.coupon_code}</bdi></>} value={<Money iqd={-order.coupon_discount_iqd} />} />
              )}
              <Row label={loc('التوصيل', 'Delivery', 'گەیاندن')} value={<Money iqd={order.shipping_iqd} />} />
              <Row label={loc('دفع الزبون', 'The customer paid')} value={<Money iqd={order.total_iqd} />} strong />
              <Row label={loc('طريقة الدفع', 'Payment')} value={order.payment_method_id === 'wallet' ? loc('محفظة (مدفوع)', 'Wallet (paid)') : loc('عند الاستلام', 'Cash on delivery', 'لە گەیاندن')} />
            </dl>
            <div className="my-3 h-px bg-border-subtle" />
            {story.money ? (
              <dl className="space-y-1.5 text-[13px]" data-order-ledger>
                <Row label={ledgerLineText('sale_gross', loc)} value={<Money iqd={story.money.gross_iqd} />} />
                <Row
                  label={<>{ledgerLineText('commission', loc)} <bdi className="text-text-muted">({formatFigure(story.commission_percent, L, 2)}%)</bdi></>}
                  value={<Money iqd={story.money.commission_iqd} />}
                />
                {story.money.delivery_fee_iqd !== 0 && <Row label={ledgerLineText('delivery_fee', loc)} value={<Money iqd={story.money.delivery_fee_iqd} />} />}
                {story.money.reversed_iqd !== 0 && <Row label={loc('عكوس الإلغاء', 'Reversals')} value={<Money iqd={story.money.reversed_iqd} signed />} />}
                {story.money.adjustments_iqd !== 0 && <Row label={loc('تسويات', 'Adjustments')} value={<Money iqd={story.money.adjustments_iqd} signed />} />}
                <Row label={loc('صافيك', 'Your net')} value={<Money iqd={story.money.net_iqd} />} strong />
                <p className="pt-1 text-[12px] leading-relaxed text-text-muted" data-credit-state={story.credit_state ?? ''}>
                  {creditLine(story, order, loc, when)}
                </p>
              </dl>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-text-muted">
                {loc('لا قيود لهذا الطلب في دفترك — ما سُجّل على الطلب نفسه: لك', 'No ledger lines for this order — what the order itself recorded: yours')}{' '}
                <Money iqd={order.merchant_receivable_iqd} />
              </p>
            )}
          </Section>
        </aside>
      </div>

      <PackingSlip order={order} story={story} storeName={ws.store.name} gov={gov} addressText={addressText} lang={L} />
      {confirmDialog}
    </div>
  );
}

function creditLine(story: OrderTimeline, order: OrderRecord, loc: (a: string, e: string, c?: string) => string, when: (iso: string) => string): string {
  if (order.status === 'cancelled') return loc('أُلغي الطلب: لا مال لك فيه.', 'The order was cancelled: none of it is yours.');
  if (story.credit_state === 'available') return loc('المبلغ متاح في رصيدك.', 'The money is in your available balance.');
  if (story.credit_state === 'pending') {
    if (story.disputed) return loc('معلّق — شكوى مفتوحة تجمّده حتى يقرّر فريق Levonis.', 'Pending — an open complaint freezes it until Levonis decides.');
    if (order.status === 'delivered' && order.release_after)
      return loc(`معلّق — يصبح متاحًا بتأكيد الزبون أو تلقائيًا في ${when(order.release_after)}.`, `Pending — available when the customer confirms, or automatically on ${when(order.release_after)}.`);
    return loc('معلّق — يصبح متاحًا بعد التسليم وتأكيد الزبون أو بعد 3 أيام.', 'Pending — available after delivery, on the customer’s confirmation or 3 days later.');
  }
  return '';
}

function ruleText(rule: string | null, loc: (a: string, e: string) => string): string {
  switch (rule) {
    case 'override': return loc('سعر خاص بالمحافظة', 'Governorate price');
    case 'default': return loc('السعر الافتراضي', 'Default price');
    case 'free_governorate': return loc('مجاني لهذه المحافظة', 'Free for this governorate');
    case 'free_over': return loc('مجاني فوق الحد', 'Free over the threshold');
    case 'pickup': return loc('استلام من المتجر', 'Pickup');
    default: return '—';
  }
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="lv-surface min-w-0 p-4">
      <h2 className="mb-3 text-[15px] font-bold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value, strong = false }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="min-w-0 text-text-secondary">{label}</dt>
      <dd className={`shrink-0 tabular-nums ${strong ? 'font-bold text-text-primary' : 'text-text-primary'}`}>{value}</dd>
    </div>
  );
}

function IconCopy({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-white/[0.05] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <Copy aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}

/** Only this prints (./orderPrint.css): who, where, what, and what to collect. */
function PackingSlip({
  order, story, storeName, gov, addressText, lang,
}: { order: OrderRecord; story: OrderTimeline; storeName: string; gov: string | null; addressText: string; lang: Lang }) {
  const { loc } = useLanguage();
  return (
    <section className="order-print-slip" aria-hidden="true" data-print-slip>
      <header>
        <strong>{storeName}</strong>
        <span dir="ltr">{order.id}</span>
      </header>
      <p>
        <strong>{order.customer_name}</strong>
        {order.customer_phone ? (
          <>
            {' · '}
            <bdi dir="ltr">{order.customer_phone}</bdi>
          </>
        ) : null}
      </p>
      <p>{[gov ? governorateName(gov, lang) : '', addressText].filter(Boolean).join('، ')}</p>
      <table>
        <thead>
          <tr>
            <th>{loc('المنتج', 'Item')}</th>
            <th>SKU</th>
            <th>{loc('الكمية', 'Qty')}</th>
          </tr>
        </thead>
        <tbody>
          {story.items.map((it) => (
            <tr key={it.id}>
              <td>{it.name}{it.option ? ` — ${it.option}` : ''}</td>
              <td dir="ltr">{it.sku || '—'}</td>
              <td dir="ltr">{it.qty}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {order.due_on_delivery_iqd > 0
          ? `${loc('يُحصَّل عند الاستلام', 'Collect on delivery')}: ${formatMoney(order.due_on_delivery_iqd, lang)}`
          : loc('مدفوع — لا يُحصَّل شيء عند الاستلام', 'Paid — nothing to collect on delivery')}
      </p>
    </section>
  );
}
