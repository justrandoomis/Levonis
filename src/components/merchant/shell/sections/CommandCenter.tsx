/**
 * TODAY — `/merchant`: «ما الذي يحتاج انتباهي الآن» (merchant platform v2
 * §3.2, «The Counter»).
 *
 * The status strip (the store, the clock word from the server's hours, the
 * pause switch), the Pulse (open · published · P4: fast), the problems, ONE
 * queue of what is waiting — each ticket a door to the screen where it is
 * done, its first rows under it with the action done ON the row (confirm an
 * order, restock a product) — this week's figures, the dock of daily doors,
 * and «جهّز متجرك» while it is not finished. All the counts come from ONE
 * read (GET /api/merchant/attention, shared with the shell's badges).
 *
 * WHAT IT WILL NOT DO:
 *   · show a row whose source did not answer — the server leaves the field
 *     out and so does this screen; a «0» here always means zero;
 *   · show a row for zero — the list is what needs attention, and «nothing
 *     waiting» is said once, in words, when every source answered and all
 *     of them are zero;
 *   · invent a trend — the figures, their week-on-week change and the
 *     fortnight line are the report's own rows (../kpis.ts says how);
 *   · decide anything on the client — a confirm is POST /orders/:id/status,
 *     a restock is PATCH /products/:id, and a refusal is rendered as the
 *     store's own sentence (src/lib/refusalStrings.ts), never the raw text;
 *   · stop a lapsed merchant — the analytics are PLUS, and without it the
 *     figures say so in one line instead of standing where the list is.
 *
 * Motion (§5): a ticket leaves after its action succeeds — `m.li layout`
 * inside `AnimatePresence`, `m.spring('ui')`; under reduced motion it
 * cross-fades. Every spring through `useMotion()`.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
// `AnimatePresence` is in the core half of the library; the elements are
// `m.*` under <MotionFeatures> (src/lib/motionFeatures.tsx), never the
// `motion` proxy — this is the merchant's landing screen, and the proxy would
// add the animation-features chunk to every workspace open.
import { AnimatePresence } from 'motion/react';
import * as Motion from 'motion/react-m';
import {
  AlertTriangle, ChevronRight, Circle, CircleCheck, ClipboardList, Hourglass, Inbox, MessageCircle, Package, PackageX,
  ShoppingBag, Star, Tag, Truck, Undo2, Wallet,
} from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { api, ApiError } from '../../../../lib/api';
import { formatFigure } from '../../../../lib/localeNumber';
import { useMotion } from '../../../../lib/motion';
import { MotionFeatures } from '../../../../lib/motionFeatures';
import { KpiTile, Sparkline } from '../../../ui/KpiTile';
import { Money } from '../../../ui/Money';
import { ErrorState } from '../../../ui/AsyncStates';
import { Button, IconButton } from '../../../ui/Button';
import { KpiRowSkeleton, ListRowsSkeleton } from '../../../ui/DashboardSkeletons';
import { useToast } from '../../../ui/Toast';
import { merchantHref } from '../../../../lib/merchantRoutes';
import { useWorkspace } from '../context';
import type { Attention, StoreProblem } from '../attention';
import { commandKpis, type ReportLike } from '../kpis';
import { storeStatus } from '../status';
import { say, sellingReason, type Loc } from '../strings';
import { Door, type PulseLine } from '../../counter/PulseRow';
import PulseRow from '../../counter/PulseRow';
import QuickDock from '../../counter/QuickDock';
import type { RestockTarget } from '../../counter/RestockSheet';
import StatusStrip, { openStateSentence } from '../../counter/StatusStrip';
import { fill, useCounterStrings, type CounterLang, type CounterStrings } from '../../counter/strings';

type Setup = NonNullable<Attention['setup']>;

/** The restock sheet opens on a tap of a sold-out row; its chunk (a Sheet, a Field, a NumberInput) is fetched then, not with Today. */
const RestockSheet = lazy(() => import('../../counter/RestockSheet'));

/** The steps of «جهّز متجرك», in the order a new store should take them. */
export function setupSteps(setup: Setup, s: CounterStrings): Array<{ id: string; done: boolean; text: string; link: string }> {
  return [
    { id: 'logo', done: setup.logo, text: s.setup.logo, link: setup.links.settings },
    { id: 'banner', done: setup.banner, text: s.setup.banner, link: setup.links.settings },
    { id: 'about', done: setup.about, text: s.setup.about, link: setup.links.settings },
    { id: 'phone', done: setup.phone, text: s.setup.phone, link: setup.links.settings },
    { id: 'delivery', done: setup.delivery, text: s.setup.delivery, link: setup.links.delivery },
    { id: 'products', done: setup.products > 0, text: s.setup.products, link: setup.links.products },
    { id: 'design', done: setup.design, text: s.setup.design, link: setup.links.design },
  ];
}

export interface Row {
  id: string;
  icon: ReactNode;
  text: string;
  detail?: ReactNode;
  value: ReactNode;
  link: string;
  tone?: 'warning' | 'neutral';
}

const ic = (Icon: typeof ShoppingBag) => <Icon aria-hidden="true" className="h-5 w-5" />;

/** The sources whose silence forbids «nothing waiting». */
export const EVERY_SOURCE = ['orders', 'custom_orders', 'inbox', 'stock', 'reviews', 'returns'] as const;

/** The rows, in the order a merchant should act on them. Zero and absent make no row. */
export function attentionRows(a: Attention, s: CounterStrings): Row[] {
  const rows: Row[] = [];
  const add = (cond: unknown, row: Row) => {
    if (cond) rows.push(row);
  };
  const o = a.orders;
  add(o?.by_stage.pending, { id: 'orders-pending', icon: ic(ShoppingBag), text: s.tickets.ordersPending, value: o?.by_stage.pending, link: o?.links.pending ?? '', tone: 'warning' });
  add(o?.by_stage.confirmed, { id: 'orders-confirmed', icon: ic(Package), text: s.tickets.ordersConfirmed, value: o?.by_stage.confirmed, link: o?.links.confirmed ?? '' });
  add(o?.by_stage.processing, { id: 'orders-processing', icon: ic(Truck), text: s.tickets.ordersProcessing, value: o?.by_stage.processing, link: o?.links.processing ?? '' });
  const co = a.custom_orders;
  add(co?.to_start, { id: 'custom-start', icon: ic(ClipboardList), text: s.tickets.customStart, value: co?.to_start, link: co?.link ?? '', tone: 'warning' });
  add(co?.in_progress, { id: 'custom-progress', icon: ic(Hourglass), text: s.tickets.customProgress, value: co?.in_progress, link: co?.link ?? '' });
  const inbox = a.inbox;
  add(inbox?.threads, {
    id: 'inbox',
    icon: ic(MessageCircle),
    text: s.tickets.inbox,
    detail: inbox && inbox.messages > inbox.threads ? fill(s.tickets.inboxMessages, { n: inbox.messages }) : undefined,
    value: inbox?.threads,
    link: inbox?.link ?? '',
  });
  add(a.requests?.matching, { id: 'requests', icon: ic(Inbox), text: s.tickets.requests, value: a.requests?.matching, link: a.requests?.link ?? '' });
  const st = a.stock;
  add(st?.out, { id: 'stock-out', icon: ic(PackageX), text: s.tickets.stockOut, value: st?.out, link: st?.link_out ?? '', tone: 'warning' });
  add(st?.low, { id: 'stock-low', icon: ic(Package), text: s.tickets.stockLow, value: st?.low, link: st?.link_low ?? '' });
  add(a.returns?.open, { id: 'returns', icon: ic(Undo2), text: s.tickets.returns, detail: s.returns.adminDecides, value: a.returns?.open, link: a.returns?.link ?? '' });
  const rv = a.reviews;
  add(rv?.new, { id: 'reviews-new', icon: ic(Star), text: s.tickets.reviewsNew, value: rv?.new, link: rv?.link ?? '' });
  add(rv?.unanswered, { id: 'reviews-unanswered', icon: ic(Star), text: s.tickets.reviewsUnanswered, value: rv?.unanswered, link: rv?.link ?? '' });
  add(a.money && a.money.available_iqd > 0, { id: 'money', icon: ic(Wallet), text: s.tickets.money, value: <Money iqd={a.money?.available_iqd} />, link: a.money?.link ?? '' });
  const po = a.payouts;
  add(po?.in_flight, { id: 'payouts', icon: ic(Wallet), text: s.tickets.payouts, detail: po ? <Money iqd={po.amount_iqd} /> : undefined, value: po?.in_flight, link: po?.link ?? '' });
  const cp = a.coupons;
  add(cp?.ending_soon, { id: 'coupons', icon: ic(Tag), text: fill(s.tickets.coupons, { n: cp?.within_days ?? 7 }), value: cp?.ending_soon, link: cp?.link ?? '' });
  return rows.filter((r) => r.link);
}

/** The store problem, in words, and the verb that fixes it. */
function problemText(code: StoreProblem, loc: Loc, s: CounterStrings): { text: string; action: string } {
  switch (code) {
    case 'layout_unpublished':
      return { text: s.problems.layoutUnpublished, action: s.problems.reviewAndPublish };
    case 'subscription_inactive':
      return { text: sellingReason(code, loc), action: s.problems.renew };
    case 'benefit_restricted':
      return { text: sellingReason(code, loc), action: s.problems.contactSupport };
    case 'store_suspended':
    case 'merchant_suspended':
    case 'merchant_restricted':
    case 'store_paused':
    default:
      return { text: sellingReason(code, loc), action: s.problems.storeSetup };
  }
}

// ------------------------------------------------------------ row actions

/** What a row action needs from the outside — the client and the refresh — so the tests can hand it stubs. */
export interface RowActionDeps {
  post: <T>(path: string, body?: unknown) => Promise<T>;
  refresh: (force?: boolean) => void;
}

/**
 * «تأكيد» on an order's sub-row: the same route the order screen uses
 * (POST /api/merchant/orders/:id/status {status:'confirmed'}), then the ONE
 * attention read is re-done so the ticket, the badge and the sub-rows all
 * move together. The server keeps the transition table; a refused move
 * (ORDER_TRANSITION_INVALID, ORDER_CHANGED) is thrown to the caller.
 */
export async function confirmOrder(deps: RowActionDeps, orderId: string): Promise<void> {
  await deps.post(`/api/merchant/orders/${encodeURIComponent(orderId)}/status`, { status: 'confirmed' });
  deps.refresh(true);
}

/** The Pulse lines from what the shell and the attention read already know. */
export function pulseLines(args: { s: CounterStrings; statusKey: string; statusWord: string; openSentence: string; unpublished: boolean }): PulseLine[] {
  const { s, statusKey, statusWord, openSentence, unpublished } = args;
  const lines: PulseLine[] = [
    statusKey === 'open'
      ? { id: 'open', tone: 'success', text: openSentence, to: merchantHref.storeSettings() }
      : { id: 'open', tone: 'warning', text: `${statusWord} · ${openSentence}`, to: merchantHref.storeSettings() },
  ];
  if (unpublished) lines.push({ id: 'unpublished', tone: 'warning', text: s.pulse.unpublished, to: merchantHref.storeDesign() });
  return lines;
}

// ------------------------------------------------------------------ screen

export default function CommandCenter() {
  const { loc, lang } = useLanguage();
  const s = useCounterStrings();
  const ws = useWorkspace();
  const m = useMotion();
  const toast = useToast();
  const { data, error, loading, refresh } = ws.attention;
  const status = storeStatus(ws.me);

  const problems = data?.store?.problems ?? [];
  const rows = data ? attentionRows(data, s) : [];
  // «Nothing waiting» is a claim about every source; one that did not answer forbids it.
  const everySource = !!data && EVERY_SOURCE.every((k) => k in data);
  const openSentence = openStateSentence(s, ws.store, lang as CounterLang);
  const lines = pulseLines({
    s,
    statusKey: status.key,
    statusWord: say(loc, status.label),
    openSentence,
    unpublished: problems.some((p) => p.code === 'layout_unpublished'),
  });

  const [confirming, setConfirming] = useState<string | null>(null);
  const [restock, setRestock] = useState<RestockTarget | null>(null);
  const [restockMounted, setRestockMounted] = useState(false);

  // After a confirm lands, focus moves on with the queue (§8): to the next
  // order's «تأكيد», or to the «بانتظارك» heading when no order is left. Done
  // once the re-read attention has arrived, so it lands on the NEXT row —
  // never on a button inside a ticket that AnimatePresence is still showing out.
  const focusNext = useRef(false);
  useEffect(() => {
    if (!focusNext.current || !data) return;
    focusNext.current = false;
    const nextId = data.orders?.first?.[0]?.id;
    const next = nextId ? document.querySelector<HTMLElement>(`[data-row-confirm="${CSS.escape(nextId)}"]`) : null;
    (next ?? document.getElementById('cc-waiting'))?.focus();
  }, [data]);

  const confirm = async (id: string) => {
    setConfirming(id);
    try {
      await confirmOrder({ post: api.post, refresh }, id);
      focusNext.current = true;
      toast.success(fill(s.rows.confirmed, { id }));
    } catch (e) {
      // The sentences (~20 KB gzip) are loaded on the first refusal, not with the screen.
      const { apiRefusal } = await import('../../../../lib/refusalStrings');
      toast.error(apiRefusal(e, lang, s.generic.error));
    } finally {
      setConfirming(null);
    }
  };
  const openRestock = (t: RestockTarget) => {
    setRestockMounted(true);
    setRestock(t);
  };

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="space-y-1">
          <h1 tabIndex={-1} className="text-[22px] font-bold leading-tight text-text-primary [text-wrap:balance] focus:outline-none">
            {s.today.title}
          </h1>
          <p className="text-[13px] text-text-muted">{s.today.subtitle}</p>
        </div>
        <StatusStrip />
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          {/* P4's speed line comes from the attention's `speed` source inside PulseRow. */}
          <PulseRow title={s.pulse.title} lines={lines} />

          {problems.length > 0 && (
            <section aria-labelledby="cc-problems" className="space-y-2">
              <h2 id="cc-problems" className="sr-only">
                {s.today.problems}
              </h2>
              <ul className="space-y-2">
                {problems.map((p) => {
                  const t = problemText(p.code, loc, s);
                  return (
                    <li key={p.code} data-store-problem={p.code} className="lv-alert lv-alert-warning flex flex-col gap-3 sm:flex-row sm:items-center">
                      <AlertTriangle aria-hidden="true" className="hidden h-5 w-5 shrink-0 text-warning sm:block" />
                      <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-text-primary">{t.text}</p>
                      <Door to={p.link} className="lv-button lv-button-secondary lv-button-sm shrink-0 self-start sm:self-auto">
                        {t.action}
                      </Door>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section aria-labelledby="cc-waiting" className="space-y-3">
            <h2 id="cc-waiting" tabIndex={-1} className="text-[15px] font-bold text-text-primary focus:outline-none">
              {s.today.waiting}
            </h2>
            {loading && !data ? (
              <div className="lv-surface overflow-hidden" aria-busy="true" aria-label={s.today.loading}>
                <ListRowsSkeleton rows={4} />
              </div>
            ) : !data ? (
              <ErrorState error={error} onRetry={() => refresh(true)} compact />
            ) : rows.length === 0 ? (
              <div className="lv-surface flex items-center gap-3 p-4" data-attention-clear={everySource || undefined}>
                <CircleCheck aria-hidden="true" className="h-5 w-5 shrink-0 text-success" />
                <p className="text-[13.5px] text-text-secondary">{everySource ? s.today.empty : s.today.emptyPartial}</p>
              </div>
            ) : (
              <ul className="lv-surface divide-y divide-border-subtle overflow-hidden" data-attention-list>
                <MotionFeatures>
                <AnimatePresence initial={false}>
                  {rows.map((r) => (
                    <Motion.li key={r.id} layout initial={false} exit={{ height: 0, opacity: 0 }} transition={m.spring('ui')} data-attention={r.id} className="overflow-hidden">
                      <Door
                        to={r.link}
                        className="group flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                      >
                        <span aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full lv-well ${r.tone === 'warning' ? 'text-warning' : 'text-text-secondary'}`}>
                          {r.icon}
                        </span>
                        {/* The figure leads the sentence it counts — «3 طلبات جديدة…» —
                            so on a wide screen it is not a table's width away from its words. */}
                        <span className={`shrink-0 font-bold tabular-nums text-text-primary ${typeof r.value === 'number' ? 'min-w-7 text-[17px]' : 'text-[15px]'}`}>
                          {typeof r.value === 'number' ? <bdi>{formatFigure(r.value, lang)}</bdi> : r.value}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] font-medium leading-snug text-text-primary">{r.text}</span>
                          {r.detail && <span className="mt-0.5 block text-[12.5px] text-text-muted">{r.detail}</span>}
                        </span>
                        <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted rtl:-scale-x-100" />
                      </Door>
                      <SubRows row={r.id} a={data} s={s} confirming={confirming} onConfirm={confirm} onRestock={openRestock} />
                    </Motion.li>
                  ))}
                </AnimatePresence>
                </MotionFeatures>
              </ul>
            )}
          </section>
        </div>

        <div className="min-w-0 space-y-6">
          <WeekFigures />
          <QuickDock />
          {data?.setup && <SetupChecklist setup={data.setup} />}
        </div>
      </div>

      {restockMounted && (
        <Suspense fallback={null}>
          <RestockSheet target={restock} onClose={() => setRestock(null)} onDone={() => refresh(true)} />
        </Suspense>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- sub-rows

/**
 * The first rows under a ticket (≤ 2, the server's `first[]`): an order with
 * «تأكيد» done here, a thread with its unread words and «رد», a sold-out
 * product with «+ مخزون», an open return with its state. A source without
 * `first` (an older server) draws no sub-row — the ticket alone stands.
 */
function SubRows({
  row,
  a,
  s,
  confirming,
  onConfirm,
  onRestock,
}: {
  row: string;
  a: Attention;
  s: CounterStrings;
  confirming: string | null;
  onConfirm: (id: string) => void;
  onRestock: (t: RestockTarget) => void;
}) {
  const ws = useWorkspace();
  const { lang } = useLanguage();
  const openIcon = <ChevronRight className="h-4 w-4 rtl:-scale-x-100" />;
  const li = 'flex items-center gap-2 text-[12.5px] text-text-secondary';
  const body = 'min-w-0 flex-1 truncate';

  if (row === 'orders-pending' && a.orders?.first?.length) {
    return (
      <ul className="space-y-2 pb-3 ps-8 pe-4" data-sub-rows="orders">
        {a.orders.first.map((o) => (
          <li key={o.id} className={li} data-sub-row={o.id}>
            {/* The customer and the amount first, the id last: at 360 the body truncates
                its tail, and a merchant confirms knowing who and how much (§3.2). */}
            <span className={body}>
              {o.customer_name} · <Money iqd={o.total_iqd} /> · <bdi>#{o.id}</bdi>
            </span>
            <Button size="sm" variant="secondary" loading={confirming === o.id} onClick={() => onConfirm(o.id)} aria-label={`${s.rows.confirm} — ${fill(s.rows.orderLabel, { id: o.id, name: o.customer_name })}`} data-row-confirm={o.id}>
              {s.rows.confirm}
            </Button>
            <IconButton variant="ghost" label={s.generic.open} icon={openIcon} onClick={() => ws.go(o.link)} />
          </li>
        ))}
      </ul>
    );
  }
  if (row === 'inbox' && a.inbox?.first?.length) {
    return (
      <ul className="space-y-2 pb-3 ps-8 pe-4" data-sub-rows="inbox">
        {a.inbox.first.map((t) => (
          <li key={t.id} className={li} data-sub-row={t.id}>
            <span className={body}>
              {t.customer_name}: «{t.last_message || s.rows.attachment}»
            </span>
            <Button size="sm" variant="secondary" onClick={() => ws.go(t.link)} data-row-reply={t.id}>
              {s.rows.reply}
            </Button>
          </li>
        ))}
      </ul>
    );
  }
  if (row === 'stock-out' && a.stock?.first?.length) {
    return (
      <ul className="space-y-2 pb-3 ps-8 pe-4" data-sub-rows="stock">
        {a.stock.first.map((p) => {
          const name = (lang !== 'en' && p.name_ar) || p.name;
          return (
            <li key={p.id} className={li} data-sub-row={p.id}>
              <span className={body}>
                {name} · <bdi>{formatFigure(p.stock, lang)}</bdi>
              </span>
              <Button size="sm" variant="secondary" onClick={() => onRestock({ id: p.id, name, stock: p.stock })} data-row-restock={p.id}>
                + {s.rows.restock}
              </Button>
              <IconButton variant="ghost" label={s.generic.open} icon={openIcon} onClick={() => ws.go(p.link)} />
            </li>
          );
        })}
      </ul>
    );
  }
  if (row === 'returns' && a.returns?.first?.length) {
    return (
      <ul className="space-y-2 pb-3 ps-8 pe-4" data-sub-rows="returns">
        {a.returns.first.map((r) => (
          <li key={r.id} className={li} data-sub-row={r.id}>
            <span className={body}>
              <bdi>#{r.order_id}</bdi> · {s.returns.state[r.state] ?? r.state}
            </span>
            <IconButton variant="ghost" label={s.generic.open} icon={openIcon} onClick={() => ws.go(r.link)} />
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

// ------------------------------------------------------------------ setup

/**
 * «جهّز متجرك» — a new store's first steps, until every one is done (or the
 * merchant hides the card on this device). Each open step is a door to the
 * screen where it is done; a done one says so with a check, not a colour.
 */
function SetupChecklist({ setup }: { setup: Setup }) {
  const { lang } = useLanguage();
  const s = useCounterStrings();
  const ws = useWorkspace();
  const key = `levo_setup_hidden:${ws.store.id}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const steps = setupSteps(setup, s);
  const done = steps.filter((x) => x.done).length;
  if (hidden || done === steps.length) return null;
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* hidden for this visit */
    }
  };
  return (
    <section aria-labelledby="cc-setup" className="lv-surface space-y-3 p-4" data-setup-checklist>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="cc-setup" className="text-[15px] font-bold text-text-primary">
            {s.setup.title}
          </h2>
          <p className="text-[12.5px] leading-relaxed text-text-muted">
            <bdi>{formatFigure(done, lang)}</bdi> / <bdi>{formatFigure(steps.length, lang)}</bdi>
            {' — '}
            {s.setup.each}
          </p>
        </div>
        <button
          type="button"
          onClick={hide}
          className="relative lv-hit min-h-9 shrink-0 rounded-lg px-2 text-[12.5px] font-medium text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-setup-hide
        >
          {s.setup.hide}
        </button>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full lv-well"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-label={s.setup.progress}
      >
        <div className="h-full rounded-full bg-success transition-[width] motion-reduce:transition-none" style={{ width: `${Math.round((done / steps.length) * 100)}%` }} />
      </div>
      <ul className="divide-y divide-border-subtle">
        {steps.map((x) => (
          <li key={x.id} data-setup-step={x.id} data-done={x.done ? 'true' : 'false'}>
            {x.done ? (
              <p className="flex min-h-12 items-center gap-3 text-[13.5px] text-text-muted">
                <CircleCheck aria-hidden="true" className="h-5 w-5 shrink-0 text-success" />
                <span className="min-w-0 flex-1">{x.text}</span>
                <span className="sr-only">{s.setup.done}</span>
              </p>
            ) : (
              <Door
                to={x.link}
                className="group flex min-h-12 items-center gap-3 rounded-lg text-[13.5px] font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Circle aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">{x.text}</span>
                <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted rtl:-scale-x-100" />
              </Door>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ figures

function WeekFigures() {
  const { lang } = useLanguage();
  const s = useCounterStrings();
  const ws = useWorkspace();
  const [report, setReport] = useState<ReportLike | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [locked, setLocked] = useState(false);

  const load = () => {
    setError(null);
    api
      .get<{ success: true } & ReportLike>('/api/merchant/analytics/report')
      .then(setReport)
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'ANALYTICS_NOT_INCLUDED') setLocked(true);
        else setError(e);
      });
  };
  useEffect(load, []);

  const k = report ? commandKpis(report) : null;
  const analytics = ws.href(merchantHref.analytics());
  const orders = ws.href(merchantHref.orders());

  return (
    <section aria-labelledby="cc-week" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="cc-week" className="text-[15px] font-bold text-text-primary">
          {s.week.title}
        </h2>
        {!locked && (
          <Link to={analytics} className="rounded-md text-[13px] font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {s.week.all}
          </Link>
        )}
      </div>
      {locked ? (
        <p className="text-[13px] leading-relaxed text-text-muted" data-analytics-locked>
          {s.week.locked}
        </p>
      ) : error ? (
        <ErrorState error={error} onRetry={load} compact />
      ) : !k ? (
        <KpiRowSkeleton count={4} />
      ) : (
        <div className="grid grid-cols-2 gap-3" data-command-kpis>
          <KpiTile label={s.week.ordersToday} value={<bdi>{formatFigure(k.today.orders, lang)}</bdi>} to={orders} />
          <KpiTile label={s.week.salesToday} value={<Money iqd={k.today.gross_iqd} />} to={analytics} />
          <KpiTile
            label={s.week.orders7}
            value={<bdi>{formatFigure(k.week.orders, lang)}</bdi>}
            delta={k.week.previous ? { value: k.week.orders - k.week.previous.orders, format: 'number', label: s.week.vsLastWeek } : null}
            trend={k.week.trend ? <Sparkline series={k.week.trend} /> : undefined}
            to={analytics}
          />
          <KpiTile
            label={s.week.sales7}
            value={<Money iqd={k.week.gross_iqd} />}
            delta={k.week.previous ? { value: k.week.gross_iqd - k.week.previous.gross_iqd, format: 'money', label: s.week.vsLastWeek } : null}
            hint={k.visitors7 !== undefined ? fill(s.week.visitors, { n: formatFigure(k.visitors7, lang) }) : undefined}
            to={analytics}
          />
        </div>
      )}
    </section>
  );
}
