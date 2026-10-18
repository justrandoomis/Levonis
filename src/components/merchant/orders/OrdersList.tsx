/**
 * THE ORDERS LIST v2 — the merchant's store orders on `DataList` (merchant
 * platform v2 workspace §3.3, §4.2). A lazy chunk of its own, opened by
 * `shell/sections/OrdersSection.tsx` for `/merchant/orders[?status=]`; it
 * replaced `SalesTabs.OrdersTab` there.
 *
 * WHAT IT DOES. Cards under 640 px of container, a table above (the
 * primitive decides); a server search (`?q=`: order number, customer, phone
 * digits — the phone never comes back); a status filter that the address
 * may open (`?status=`, the contract's word) with the attention counts on
 * the stages that need the merchant; the next step of MERCHANT_ORDER_FLOW
 * per row and, on a ship, the tracking number the customer's tracker shows;
 * a selection whose tray moves many at once (never a cancel — it refunds,
 * and stays one at a time on the order screen); packing slips for the
 * selection, printed from the browser (./orderPrint.css); the current filter
 * as a CSV, over all time or a period (this month, last month, two days).
 *
 * PAYMENT IS NOT A STATUS. Each row carries a second chip — paid from the
 * wallet, cash at the door, instalments (./PaymentChip.tsx) — and each slip
 * says in its header what the courier collects. Display only.
 *
 * THE LIST'S STATE IS ITS ADDRESS. The status tab, the search and how many
 * pages are open arrive as props from `?status&q&pages` and every change goes
 * back out through `onViewChange` (the section writes it, replacing the
 * entry). The last list seen is kept in memory with its scroll depth, so
 * Back from an order shows it at once, where it was, while it re-reads.
 *
 * THE TRAY IS IN FLOW. It is `DataList`'s selection bar, above the rows, an
 * `m.div` toolbar that arrives with `m.spring('ui')` — never pinned to the
 * viewport's bottom edge (tests/uiSystem.test.ts forbids that). Escape on the
 * list clears the selection (§8).
 *
 * WORDS: ./strings.ts (ar / en / real Sorani); the status words are
 * ./labels.ts, shared with the order screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
// `m` + <MotionFeatures>, never the `motion` proxy: the proxy would pull the
// animation-features chunk into the orders screen for a tray and a chip.
import * as Motion from 'motion/react-m';
import { CalendarRange, Download, Printer, Search } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { formatMoney } from '../../../lib/money';
import { useMotion } from '../../../lib/motion';
import { MotionFeatures } from '../../../lib/motionFeatures';
import { governorateName } from '../../../../packages/shipping/src/iraqGovernorates';
import { DataList, type DataListColumn } from '../../ui/DataList';
import { Field, Input, Select } from '../../ui/Field';
import { Button } from '../../ui/Button';
import { Badge, StatusChip } from '../../ui/Badge';
import { Segmented } from '../../ui/Segmented';
import { Money } from '../../ui/Money';
import type { MenuEntry } from '../../ui/Menu';
import { useConfirm } from '../../ui/ConfirmDialog';
import { usePrompt } from '../../ui/PromptDialog';
import { useToast } from '../../ui/Toast';
import { merchantRefusal } from '../shell/refusal';
import { dateLocale, itemCountLabel } from '../../orders/format';
import type { OrdersView } from './ordersView';
import { locIn, ORDER_FLOW, orderPaymentLabel, orderStatusLabel, orderStatusTone, paymentMark } from './labels';
import { PaymentChip } from './PaymentChip';
import {
  applyMoves, baghdadDay, bulkOutcome, bulkPlan, csvHref, EXPORT_PERIODS, exportRange, listParams, mapLimit, ordersListApi,
  readPages, searchTerm, TRACKING_NO_MAX, type BulkAnswer, type BulkStep, type ExportPeriod, type OrderListRow, type SlipOrder,
} from './bulk';
import { fill, moveLabel, ordersCount, ordersLang, useOrdersStrings, type OrdersLang, type OrdersStrings } from './strings';
import './orderPrint.css';

/** The filter's chips, in the flow's order — `''` is «الكل». */
const STATUS_FILTERS = ['', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] as const;

export interface OrdersListProps {
  /** The list opened on one status — a workspace address's `?status=`. */
  initialStatus?: string;
  /** The search the address carries (`?q=`). */
  initialQuery?: string;
  /** How many pages the address says were open (`?pages=`); the list re-reads that deep. */
  initialPages?: number;
  /** The tab, the search or the depth changed: the section writes it to the address. */
  onViewChange?: (view: OrdersView) => void;
  /** The order's own screen: the row's title links to it. */
  orderHref: (orderId: string) => string;
  /** On the packing slips' header. */
  storeName: string;
  /** Whose list it is: the remembered list is only ever this store's. */
  storeId?: string;
  /** The attention counts on the stages that need the merchant (badges on the filter). */
  stageCounts?: Partial<Record<string, number>>;
  /** After a move landed: the shell re-counts what needs the merchant. */
  onChanged?: () => void;
}

/** «منذ 12 د» / «أمس», in the viewer's own words (Intl), never a hand-written table. */
export function since(iso: string, lang: OrdersLang, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(dateLocale(lang), { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3_600], ['minute', 60]];
  for (const [unit, size] of units) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return rtf.format(0, 'minute');
}

/**
 * The list's columns — the same seven on a card and in the table (the
 * primitive re-casts them): the order number (the row's link), the customer,
 * the lines and the governorate, the amount, how it is paid (its own chip,
 * beside the amount on a card), the status chip, and how long ago.
 * `chip` is the screen's own, so a just-moved row's chip can arrive with a
 * spring; a pure caller passes a plain one.
 */
export function orderColumns(
  s: OrdersStrings,
  lang: OrdersLang,
  loc: (ar: string, en: string, ckb?: string) => string,
  chip: (row: OrderListRow) => ReactNode
): DataListColumn<OrderListRow>[] {
  return [
    { id: 'order', header: s.colOrder, cell: (r) => <bdi dir="ltr">{r.id}</bdi>, card: 'title', width: '11rem' },
    { id: 'customer', header: s.colCustomer, cell: (r) => r.customer_name || '—', card: 'meta' },
    {
      id: 'gov',
      header: s.colGovernorate,
      // Where first (the column is the governorate), then how much.
      cell: (r) => [r.governorate ? governorateName(r.governorate, lang) : '', itemCountLabel(r.item_count, lang)].filter(Boolean).join(' · '),
      card: 'meta',
    },
    { id: 'total', header: s.colAmount, cell: (r) => <Money iqd={r.total_iqd} />, numeric: true },
    { id: 'payment', header: s.colPayment, cell: (r) => <PaymentChip order={r} loc={loc} fallback="—" />, width: '10rem' },
    { id: 'status', header: s.colStatus, cell: chip, card: 'badge', width: '9rem' },
    { id: 'since', header: s.colSince, cell: (r) => since(r.created_at, lang), card: 'meta', width: '7rem' },
  ];
}

/**
 * The tray's actions: one button per forward step the selection can take,
 * counted, and the slips. Rendered inside `DataList`'s in-flow selection bar.
 */
export function SelectionTray({
  plan, s, lang, busy, printing, onMove, onPrint,
}: {
  plan: BulkStep[];
  s: OrdersStrings;
  lang: OrdersLang;
  busy: boolean;
  printing: boolean;
  onMove: (step: BulkStep) => void;
  onPrint: () => void;
}) {
  const m = useMotion();
  const total = new Set(plan.flatMap((p) => p.ids)).size;
  return (
    <MotionFeatures>
    <Motion.div
      role="toolbar"
      aria-label={fill(s.selected, { orders: ordersCount(total, lang) })}
      className="flex flex-wrap items-center gap-2"
      initial={{ y: m.travel(16), opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={m.spring('ui')}
      data-orders-tray
    >
      {plan.map((step) => (
        <Button key={step.to} size="sm" variant={step.to === 'shipped' ? 'primary' : 'secondary'} disabled={busy} onClick={() => onMove(step)} data-bulk-move={step.to}>
          {moveLabel(s, step.to)} <bdi dir="ltr">({step.ids.length})</bdi>
        </Button>
      ))}
      <Button size="sm" variant="ghost" icon={<Printer className="h-4 w-4" aria-hidden="true" />} loading={printing} loadingLabel={s.printPreparing} onClick={onPrint} data-bulk-print>
        {s.printSlips}
      </Button>
    </Motion.div>
    </MotionFeatures>
  );
}

/** Only this prints (./orderPrint.css): one slip per selected order, each on its own page. */
export function PackingSlips({ slips, storeName, s, lang }: { slips: SlipOrder[]; storeName: string; s: OrdersStrings; lang: OrdersLang }) {
  return (
    <section className="order-print-slip" aria-hidden="true" data-print-slips={slips.length}>
      {slips.map(({ order, items }) => {
        const addr = order.address ?? {};
        const text = (v: unknown) => (typeof v === 'string' ? v : '');
        const gov = text(addr.governorate);
        const line = [gov ? governorateName(gov, lang) : '', text(addr.area), text(addr.address) || text(addr.line1), text(addr.city), text(addr.landmark)]
          .filter(Boolean)
          .join('، ');
        // What the courier collects, in the header where it cannot be missed.
        const pay = paymentMark(order);
        const due = order.due_on_delivery_iqd > 0 ? order.due_on_delivery_iqd : 0;
        return (
          <article key={order.id} style={{ breakAfter: 'page' }} data-print-slip={order.id}>
            <header>
              <strong>{storeName}</strong>
              {pay && (
                <span className="order-print-pay" data-slip-pay={pay}>
                  {due ? `${s.slipCollect}: ${formatMoney(due, lang)}` : orderPaymentLabel(pay, locIn(lang))}
                </span>
              )}
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
            {line && <p>{line}</p>}
            <table>
              <thead>
                <tr>
                  <th>{s.slipItem}</th>
                  <th>{s.slipQty}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td>{it.name_snapshot}{it.option_snapshot ? ` — ${it.option_snapshot}` : ''}</td>
                    <td dir="ltr">{it.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>{order.due_on_delivery_iqd > 0 ? `${s.slipCollect}: ${formatMoney(order.due_on_delivery_iqd, lang)}` : s.slipPaid}</p>
          </article>
        );
      })}
    </section>
  );
}

/** The last list this tab showed — its rows, its depth and where it was scrolled. Memory only, never stored. */
interface SeenList {
  key: string;
  rows: OrderListRow[];
  cursor: string | null;
  pages: number;
  scrollTop: number;
}
let seen: SeenList | null = null;
const viewKey = (store: string, status: string, q: string) => `${store}|${listParams({ status, q }).toString()}`;
/**
 * The deepest the list re-reads — ./ordersView.ts `LIST_PAGES_MAX`, repeated
 * (tests/ordersListUi.test.ts holds them equal) so the address module stays
 * the section's alone: shared, it would be one more chunk the shell names.
 */
const PAGES_MAX = 10;
const clampPages = (n: number | undefined) => Math.min(Math.max(1, Math.floor(Number(n)) || 1), PAGES_MAX);

export default function OrdersList({
  initialStatus = '', initialQuery = '', initialPages = 1, onViewChange, orderHref, storeName, storeId = '', stageCounts, onChanged,
}: OrdersListProps) {
  const { loc, lang } = useLanguage();
  const L = ordersLang(lang);
  const s = useOrdersStrings();
  const m = useMotion();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [prompt, promptDialog] = usePrompt();

  const known = (v: string) => (STATUS_FILTERS as readonly string[]).includes(v);
  const [filter, setFilter] = useState(() => (known(initialStatus) ? initialStatus : ''));
  const [text, setText] = useState(initialQuery);
  const [q, setQ] = useState(() => searchTerm(initialQuery) ?? '');
  /** How deep the next full read goes: the address's depth on arrival, one page after a new tab or search. */
  const depth = useRef(clampPages(initialPages));
  const [pages, setPages] = useState(depth.current);
  /** The same list, seen moments ago (Back from an order): shown at once, then re-read underneath. */
  const [restored] = useState(() => {
    const hit = seen && seen.key === viewKey(storeId, filter, q) && seen.pages === depth.current ? seen : null;
    return hit ? { rows: hit.rows, cursor: hit.cursor, scrollTop: hit.scrollTop } : null;
  });
  const [rows, setRows] = useState<OrderListRow[] | null>(() => restored?.rows ?? null);
  const [cursor, setCursor] = useState<string | null>(() => restored?.cursor ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<BulkAnswer['refused']>([]);
  const [slips, setSlips] = useState<SlipOrder[]>([]);
  const [printing, setPrinting] = useState(false);
  const [period, setPeriod] = useState<ExportPeriod>('all');
  const [days, setDays] = useState({ from: '', to: '' });
  /** A list answer that lands after the filter or the search changed is dropped, not shown. */
  const seq = useRef(0);
  /** Rows whose status chip should arrive with a spring: the ones the merchant just moved. */
  const justMoved = useRef(new Set<string>());
  const printPending = useRef(false);

  const now = useRef({ filter, q });
  now.current = { filter, q };

  // The address changed under the list (a link from Today, the menu): it wins.
  useEffect(() => {
    const status = known(initialStatus) ? initialStatus : '';
    const term = searchTerm(initialQuery) ?? '';
    if (status === now.current.filter && term === now.current.q) return;
    depth.current = 1;
    setPages(1);
    if (status !== now.current.filter) {
      setRows(null);
      setCursor(null);
      setSelected(new Set());
    }
    setFilter(status);
    if (term !== now.current.q) {
      setText(term);
      setQ(term);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStatus, initialQuery]);

  // The search is the server's; typing waits a beat before asking.
  useEffect(() => {
    const term = searchTerm(text);
    if (term === null || term === now.current.q) return;
    const t = window.setTimeout(() => {
      depth.current = 1;
      setPages(1);
      setQ(term);
    }, 300);
    return () => window.clearTimeout(t);
  }, [text]);
  const tooLong = searchTerm(text) === null;

  // Every change of tab, search or depth goes back to the address (the section replaces the entry).
  const viewChange = useRef(onViewChange);
  useEffect(() => {
    viewChange.current = onViewChange;
  });
  const written = useRef(`${filter}\n${q}\n${pages}`);
  useEffect(() => {
    const key = `${filter}\n${q}\n${pages}`;
    if (key === written.current) return;
    written.current = key;
    viewChange.current?.({ status: filter || undefined, q: q || undefined, pages: pages > 1 ? pages : undefined });
  }, [filter, q, pages]);

  /** The whole list, as deep as it is open — a refresh after a move keeps the pages the merchant had. */
  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    readPages((at) => ordersListApi.list(listParams({ status: filter, q, cursor: at })), depth.current)
      .then((d) => {
        if (mine !== seq.current) return;
        setRows(d.rows);
        setCursor(d.cursor);
        depth.current = d.pages;
        setPages(d.pages);
        setMore('idle');
      })
      .catch((e: unknown) => mine === seq.current && setError(e))
      .finally(() => mine === seq.current && setLoading(false));
  }, [filter, q]);
  useEffect(load, [load]);

  const loadMore = async () => {
    if (!cursor) return;
    const mine = seq.current;
    setMore('loading');
    try {
      const d = await ordersListApi.list(listParams({ status: filter, q, cursor }));
      if (mine !== seq.current) return;
      setRows((prev) => {
        const seenIds = new Set((prev ?? []).map((r) => r.id));
        return [...(prev ?? []), ...d.orders.filter((r) => !seenIds.has(r.id))];
      });
      setCursor(d.next_cursor);
      depth.current = clampPages(depth.current + 1);
      setPages(depth.current);
      setMore('idle');
    } catch {
      if (mine === seq.current) setMore('error');
    }
  };

  const changeFilter = (next: string) => {
    if (next === filter) return;
    depth.current = 1;
    setPages(1);
    setRows(null);
    setCursor(null);
    setSelected(new Set());
    setFilter(next);
  };

  // The list as it stands is the one Back returns to; the scroll owner (the
  // shell's) says how far down it was. Restored a frame after mount, once the
  // shell has put a new screen at its top.
  const root = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(restored?.scrollTop ?? 0);
  useEffect(() => {
    if (rows && !loading) seen = { key: viewKey(storeId, filter, q), rows, cursor, pages, scrollTop: scrolled.current };
  }, [rows, cursor, pages, filter, q, loading, storeId]);
  useEffect(() => {
    const owner = root.current?.closest<HTMLElement>('[data-scroll-owner]');
    if (!owner) return;
    const onScroll = () => {
      if (root.current?.isConnected) scrolled.current = owner.scrollTop;
    };
    owner.addEventListener('scroll', onScroll, { passive: true });
    const top = restored?.scrollTop ?? 0;
    const frame = top > 0 ? window.requestAnimationFrame(() => owner.scrollTo({ top })) : 0;
    return () => {
      owner.removeEventListener('scroll', onScroll);
      window.cancelAnimationFrame(frame);
      if (seen) seen.scrollTop = scrolled.current;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The tracking number a ship may carry — asked in the prompt dialog; null when the merchant backed out. */
  const askTracking = (description: string) =>
    prompt({
      title: s.trackingTitle,
      description,
      label: s.trackingLabel,
      placeholder: s.trackingPlaceholder,
      inputMode: 'text',
      maxLength: TRACKING_NO_MAX,
      validate: (v) => ([...v.trim()].length > TRACKING_NO_MAX ? s.trackingTooLong : null),
      confirmLabel: s.shipConfirm,
      cancelLabel: s.cancel,
    });

  const landed = (ids: string[], to: string, trackingNo: string) => {
    for (const id of ids) justMoved.current.add(id);
    setRows((prev) => (prev ? applyMoves(prev, ids, to, filter, trackingNo) : prev));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    onChanged?.();
  };

  const moveOne = async (row: OrderListRow, to: string) => {
    let trackingNo = '';
    if (to === 'shipped') {
      const t = await askTracking(row.id);
      if (t === null) return;
      trackingNo = t.trim();
    }
    setBusy(true);
    try {
      await ordersListApi.setStatus(row.id, to, trackingNo);
      landed([row.id], to, trackingNo);
      toast.success(fill(s.moved, { status: orderStatusLabel(to, loc) }), trackingNo ? { description: s.trackingSaved } : undefined);
    } catch (e) {
      toast.error(merchantRefusal(e, L, s.refreshFailed));
      // A refusal that says the order moved on: show where it is now.
      if (e instanceof ApiError && (e.code === 'ORDER_CHANGED' || e.code === 'ORDER_TRANSITION_INVALID')) load();
    } finally {
      setBusy(false);
    }
  };

  const moveMany = async (step: BulkStep) => {
    const count = ordersCount(step.ids.length, L);
    const question = fill(s.bulkAsk, { orders: count, status: orderStatusLabel(step.to, loc) });
    let trackingNo = '';
    if (step.to === 'shipped') {
      // The prompt is the confirmation: one dialog, not two.
      const t = await askTracking(question);
      if (t === null) return;
      trackingNo = t.trim();
    } else if (!(await confirm({ title: question, consequence: s.bulkConsequence, confirmLabel: moveLabel(s, step.to), cancelLabel: s.cancel }))) {
      return;
    }
    setBusy(true);
    setRefused([]);
    try {
      const answer = await ordersListApi.bulkStatus(step.ids, step.to, trackingNo);
      const outcome = bulkOutcome(answer);
      if (answer.done.length) landed(answer.done, step.to, trackingNo);
      if (outcome.kind === 'done') toast.success(fill(s.bulkDone, { orders: ordersCount(outcome.n, L) }));
      else if (outcome.kind === 'partial') toast.info(fill(s.bulkPartial, { n: outcome.n, m: outcome.m }));
      else toast.error(s.bulkNone);
      if (outcome.kind !== 'done') {
        setRefused(outcome.refused);
        load();
      }
    } catch (e) {
      toast.error(merchantRefusal(e, L, s.refreshFailed));
      // The server moves the orders one by one and may still be moving them
      // when the client stops waiting: the list is re-read so the screen shows
      // the true state instead of «failed» beside rows that moved.
      load();
    } finally {
      setBusy(false);
    }
  };

  /** The slips: each order in full (its lines, the address), a few at a time, then the browser's print. */
  const printSlips = async (ids: string[]) => {
    if (!ids.length || printing) return;
    setPrinting(true);
    try {
      const got = await mapLimit(ids, 4, (id) => ordersListApi.order(id));
      const ok = got.filter((x): x is SlipOrder => x !== null);
      if (ok.length < ids.length) toast.error(s.printFailed);
      printPending.current = ok.length > 0;
      setSlips(ok);
    } finally {
      setPrinting(false);
    }
  };
  useEffect(() => {
    // The slips are in the DOM once this runs; only then is there something to print.
    if (printPending.current && slips.length) {
      printPending.current = false;
      window.print();
    }
  }, [slips]);

  const chip = useCallback((row: OrderListRow) => (
    <MotionFeatures>
      <Motion.span
        key={row.status}
        className="inline-flex"
        initial={justMoved.current.has(row.id) ? { scale: m.reduced ? 1 : 0.8, opacity: 0 } : false}
        animate={{ scale: 1, opacity: 1 }}
        transition={m.spring('quick')}
      >
        <StatusChip tone={orderStatusTone(row.status)}>{orderStatusLabel(row.status, loc)}</StatusChip>
      </Motion.span>
    </MotionFeatures>
  ), [loc, m]);

  const columns = useMemo(() => orderColumns(s, L, loc, chip), [s, L, loc, chip]);

  const rowActions = (row: OrderListRow): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    for (const to of (ORDER_FLOW[row.status] ?? []).filter((t) => t !== 'cancelled')) {
      entries.push({ id: `move-${to}`, label: moveLabel(s, to), onSelect: () => void moveOne(row, to), disabled: busy });
    }
    if (entries.length) entries.push({ id: 'sep', separator: true });
    entries.push({ id: 'open', label: s.openOrder, href: orderHref(row.id) });
    entries.push({ id: 'slip', label: s.printSlip, onSelect: () => void printSlips([row.id]), disabled: printing });
    return entries;
  };

  const plan = useMemo(() => bulkPlan(rows ?? [], selected), [rows, selected]);
  const chosen = useMemo(() => (rows ?? []).filter((r) => selected.has(r.id)).map((r) => r.id), [rows, selected]);
  const badge = (st: string) => {
    const n = stageCounts?.[st];
    return n ? <Badge tone="accent">{n}</Badge> : undefined;
  };
  const empty = q
    ? { title: fill(s.emptySearch, { q }) }
    : filter
      ? { title: s.emptyFilter }
      : { title: s.emptyAll, description: s.emptyAllHint };

  const range = exportRange(period, days);
  const today = baghdadDay();
  const periodLabel: Record<ExportPeriod, string> = {
    all: s.periodAll, this_month: s.periodThisMonth, last_month: s.periodLastMonth, custom: s.periodCustom,
  };

  return (
    <div ref={root} className="space-y-3" data-orders-list>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={s.search} error={tooLong ? s.searchTooLong : undefined} className="min-w-0 max-w-md flex-1 basis-60">
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <Input type="search" inputMode="search" enterKeyHint="search" value={text} onChange={(e) => setText(e.target.value)} className="ps-9" data-orders-search />
          </div>
        </Field>
        {/* The CSV: the current filter over a period — none (all time), a month, or two typed days. */}
        <div className="flex min-w-0 flex-wrap items-end gap-2" data-orders-export>
          <Field label={s.exportPeriod} className="w-44">
            <Select value={period} onChange={(e) => setPeriod(e.target.value as ExportPeriod)} data-orders-period>
              {EXPORT_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {periodLabel[p]}
                </option>
              ))}
            </Select>
          </Field>
          {period === 'custom' && (
            <>
              <Field label={s.exportFrom} className="w-40">
                <Input ltr type="date" value={days.from} max={days.to || today} onChange={(e) => setDays((d) => ({ ...d, from: e.target.value }))} data-orders-from />
              </Field>
              <Field label={s.exportTo} className="w-40">
                <Input ltr type="date" value={days.to} min={days.from || undefined} max={today} onChange={(e) => setDays((d) => ({ ...d, to: e.target.value }))} data-orders-to />
              </Field>
            </>
          )}
          {/* A GET the session's cookie authorises: opened by the browser's own download. */}
          <a href={csvHref({ status: filter, q, ...range })} download className="lv-button lv-button-secondary lv-button-sm" title={s.exportHint} data-orders-csv>
            {range.from || range.to ? <CalendarRange className="h-4 w-4" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            {s.exportCsv}
          </a>
        </div>
      </div>

      {/* Seven chips do not fit a phone's width; the row scrolls, as the old tab's did. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-1 hide-scrollbar">
        <div className="min-w-max">
          <Segmented
            size="sm"
            group="orders-status"
            label={s.filterLabel}
            value={filter}
            onChange={changeFilter}
            dataAttr="data-orders-filter"
            items={STATUS_FILTERS.map((st) => ({ id: st, label: st ? orderStatusLabel(st, loc) : s.all, badge: st ? badge(st) : undefined }))}
          />
        </div>
      </div>

      <div
        onKeyDown={(e) => {
          // Escape clears the selection (§8) — from a row, a checkbox or the tray itself.
          if (e.key === 'Escape' && selected.size > 0) {
            e.stopPropagation();
            setSelected(new Set());
          }
        }}
        data-orders-list
      >
      <DataList
        label={s.listLabel}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => `${r.id} · ${r.customer_name}`}
        rowHref={(r) => orderHref(r.id)}
        rowActions={rowActions}
        loading={loading}
        error={error}
        onRetry={load}
        wideAt={640}
        empty={empty}
        selection={{
          selected,
          onChange: setSelected,
          actions: <SelectionTray plan={plan} s={s} lang={L} busy={busy} printing={printing} onMove={(step) => void moveMany(step)} onPrint={() => void printSlips(chosen)} />,
        }}
      />
      </div>

      {refused.length > 0 && (
        <ul role="alert" className="space-y-1 text-[12.5px] text-danger" data-bulk-refused>
          {refused.map((r) => (
            <li key={r.id}>
              <bdi dir="ltr">{r.id}</bdi>: {merchantRefusal(new ApiError(409, r.code, r.code), L, r.code)}
            </li>
          ))}
        </ul>
      )}

      {rows && cursor && (
        <Button variant="ghost" block onClick={loadMore} loading={more === 'loading'} data-orders-more>
          {more === 'error' ? s.loadMoreError : s.loadMore}
        </Button>
      )}
      {error && rows ? <p role="alert" className="text-[12.5px] text-danger">{merchantRefusal(error, L, s.refreshFailed)}</p> : null}

      <PackingSlips slips={slips} storeName={storeName} s={s} lang={L} />
      {confirmDialog}
      {promptDialog}
    </div>
  );
}
