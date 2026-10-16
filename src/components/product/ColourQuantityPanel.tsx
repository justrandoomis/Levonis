/**
 * «عدة ألوان» — SEVERAL COLOURS IN ONE ADD (docs/ux/COLOUR-QUANTITIES.md §3).
 *
 * The incident's customer meant «50 black, 5 white, 1 beige», tapped three
 * single-select chips, kept one quantity of 56 and ordered «beige × 56». This
 * is the tool built for what they meant: one row per colour with its own
 * stepper, the running total, and ONE press that adds every colour or none
 * (`POST /api/cart/items/batch`, worker/routes/cart.ts §4).
 *
 * ITS OWN CHUNK (§3.11): the page imports it through `React.lazy`, warmed when
 * a finger or the focus reaches the switch, so the product page's opening
 * never pays for it.
 *
 *   · Each row with a quantity is quoted ONCE for the shared selection
 *     (`POST /api/products/:slug/quote`, qty 1): its unit price, its ceiling
 *     and its errors. A quantity change never re-quotes; at most 3 quotes are
 *     in flight; a superseded one is aborted.
 *   · A counter shared by the colours (the product's or the option's shelf)
 *     gives each row what the pool leaves after the others (`rowCeilings`).
 *   · A refusal adds NOTHING (the server guarantees it): the refused rows are
 *     marked, their sentence is read with the stepper, focus moves to the
 *     first one. A press whose answer was lost is caught (`CART_LINES_CHANGED`).
 *   · The confirmation sheet lists what the SERVER reports was added.
 *
 * The total and the add are drawn into the page's bar and panel slots
 * (portals), the pattern of the price-request panel.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Check, ShoppingCart } from 'lucide-react';
import { api, ApiError, type CartItem } from '../../lib/api';
import { QuantityInput } from '../ui/QuantityInput';
import { Sheet } from '../ui/Sheet';
import { ColourSwatch, ColourTag } from './ColourTag';
import ShippingConflictDialog from '../cart/ShippingConflictDialog';
import { toast } from '../../lib/toastStore';
import { groupedNumber } from '../../lib/localeNumber';
import { refusalText, stockRefusal } from '../../lib/refusalStrings';
import { LINE_QTY_MAX } from '../../../packages/pricing/src/quantity';
import {
  colourLang,
  colourStrings,
  heldOnSharedCounter,
  isolate,
  lineQtyIn,
  lostAnswerVerdict,
  multiAddButton,
  rowCeilings,
} from '../../lib/colourQuantities';

/** One colour row, as the page describes it (names English, figures the server's). */
export interface ColourRow {
  /** A product colour's id, or the colour group's value id. */
  id: string;
  name: string;
  hex: string;
  /** The colour's own picture or swatch, '' for none. */
  image: string;
  /** It can take a quantity: offered, priced, and not sold out on a direct sale. */
  offered: boolean;
  noPrice: boolean;
  soldOut: boolean;
  /** The page's availability words for it («نفد» / «بقي n» / «متوفر n»), direct sale only. */
  chip: { text: string; cls: string } | null;
  /** Its own shelf on a direct sale; null = untracked or not a per-colour counter. */
  ownMax: number | null;
  /** The page's level price for it, shown before its quote lands (never used for an add). */
  levelUnit: number | null;
  levelRegular: number | null;
  levelApplied: number | null;
}

export interface ColourQuantityPanelProps {
  lang: string;
  productId: string;
  productSlug: string;
  rows: ColourRow[];
  quantities: Record<string, number>;
  onQuantities: (next: Record<string, number>) => void;
  dimension: { kind: 'color' } | { kind: 'group'; groupId: string };
  /** The selection every colour shares (without the colour group's value). */
  sharedOptionValueIds: string[];
  fulfillmentType: '' | 'direct_sale' | 'pre_order';
  /** The pre-order route the page's filter kept (`effectiveTransport`), or ''. */
  route: string;
  warrantyPlanId: string;
  /** The product-level half of the page's buy gate, without the colour. */
  sharedReady: boolean;
  /** The shared selection in words («With spool · بيع مباشر»), for the notice when it changes (§3.4). */
  sharedLabel?: string;
  cartLines: CartItem[];
  cartLinesLoaded: boolean;
  isAuthenticated: boolean;
  /** The page's own «سجّل الدخول للشراء»: a guest's press goes to sign-in, and the button says so. */
  signInLabel: string;
  onSignIn: () => void;
  onCartItems: (items: CartItem[]) => void;
  /** The row to focus when the list opens (a hint's colour). */
  focusRow: string | null;
  onFocused: () => void;
  barSlot: HTMLElement | null;
  panelSlot: HTMLElement | null;
  /** The desktop layout is on screen: the summary rides in the panel slot; on a phone it sits under the list. */
  wide?: boolean;
  money: (iqd: number) => string;
  /** Quick Buy was on in single mode: ⚡ steps aside here, and says why. */
  quickBuyOn?: boolean;
  /** The page's own sentence for a refusal code ('' when it has none). */
  reasonFor?: (code: string) => string;
}

interface RowQuote {
  unit: number;
  regular: number;
  applied: number;
  maxQty: number;
  tracked: boolean;
  scope: string;
  preorder: boolean;
  quotaTracked: boolean;
  errors: string[];
  unpriced: boolean;
}

interface QuoteAnswer {
  price_status?: 'priced' | 'unpriced';
  quote: { unit_subtotal_iqd: number; regular_iqd: number; applied_iqd: number; errors?: string[] } | null;
  availability: {
    mode?: string;
    stock?: { tracked?: boolean; scope?: string; available?: number | null; max_qty?: number };
    preorder?: { capacity?: { tracked?: boolean; available?: number | null } };
    selection?: { errors?: string[] };
  } | null;
}

interface AddedLine {
  index: number;
  line_id: string | null;
  option_value_ids: string[];
  color_id: string;
  requested: number;
  before: number;
  after: number;
  capped: boolean;
}

/** The counters every colour shares: one shelf on the product, the base row or one option row. */
const SHARED_SCOPES = new Set(['product', 'base', 'option']);
const MAX_IN_FLIGHT = 3;
const VISIBLE_OTHERS = 8;

export default function ColourQuantityPanel(props: ColourQuantityPanelProps) {
  const {
    lang,
    productId,
    productSlug,
    rows,
    quantities,
    onQuantities,
    dimension,
    sharedOptionValueIds,
    fulfillmentType,
    route,
    warrantyPlanId,
    sharedReady,
    sharedLabel = '',
    cartLines,
    cartLinesLoaded,
    isAuthenticated,
    signInLabel,
    onSignIn,
    onCartItems,
    focusRow,
    onFocused,
    barSlot,
    panelSlot,
    wide = false,
    money,
    quickBuyOn = false,
    reasonFor,
  } = props;
  const cs = colourStrings(lang);
  const cl = colourLang(lang);
  const uid = useId();
  const rowDomId = (id: string) => `${uid}-row-${id}`.replace(/[^A-Za-z0-9_-]/g, '_');

  // ------------------------------------------------------------ identities
  const lineIds = useCallback(
    (rowId: string) => (dimension.kind === 'group' ? [...sharedOptionValueIds, rowId] : sharedOptionValueIds),
    [dimension.kind, sharedOptionValueIds]
  );
  const lineColour = useCallback((rowId: string) => (dimension.kind === 'color' ? rowId : ''), [dimension.kind]);
  const inCartOf = useCallback(
    (rowId: string, lines: readonly CartItem[] = cartLines) => lineQtyIn(lines, productId, lineIds(rowId), '', lineColour(rowId)),
    [cartLines, productId, lineIds, lineColour]
  );

  // --------------------------------------------------------------- quotes
  /** The shared selection a quote answers. A change re-quotes every row with a quantity. */
  const sharedKey = JSON.stringify([sharedOptionValueIds, fulfillmentType, route, warrantyPlanId, dimension]);
  const [quotes, setQuotes] = useState<Record<string, RowQuote>>({});
  const [quoteFailed, setQuoteFailed] = useState<Record<string, boolean>>({});
  const inFlight = useRef(new Map<string, AbortController>());
  const [tick, setTick] = useState(0);
  const quoteKey = (rowId: string) => `${sharedKey}|${rowId}`;

  useEffect(
    () => () => {
      for (const ac of inFlight.current.values()) ac.abort();
      inFlight.current.clear();
    },
    []
  );

  // A superseded shared selection: every request for the old one is dropped at the socket.
  useEffect(() => {
    for (const [key, ac] of inFlight.current) {
      if (!key.startsWith(`${sharedKey}|`)) {
        ac.abort();
        inFlight.current.delete(key);
      }
    }
  }, [sharedKey]);

  useEffect(() => {
    if (!sharedReady) return;
    const wanted = rows.filter((r) => r.offered && (quantities[r.id] ?? 0) > 0 && !quotes[quoteKey(r.id)] && !quoteFailed[quoteKey(r.id)]);
    for (const r of wanted) {
      if (inFlight.current.size >= MAX_IN_FLIGHT) break;
      const key = quoteKey(r.id);
      if (inFlight.current.has(key)) continue;
      const ac = new AbortController();
      inFlight.current.set(key, ac);
      const ids = lineIds(r.id);
      void api
        .post<QuoteAnswer>(
          `/api/products/${productSlug}/quote`,
          {
            qty: 1,
            optionId: ids[0] || undefined,
            optionValueIds: ids.length ? ids : undefined,
            colorId: lineColour(r.id) || undefined,
            transportMethod: route || undefined,
            fulfillmentType: fulfillmentType || undefined,
            warrantyPlanId: warrantyPlanId || undefined,
          },
          { signal: ac.signal, timeoutMs: 12000 }
        )
        .then((res) => {
          const stock = res.availability?.stock;
          const capacity = res.availability?.preorder?.capacity;
          const unpriced = res.price_status === 'unpriced' || !res.quote;
          setQuotes((now) => ({
            ...now,
            [key]: {
              unit: res.quote?.unit_subtotal_iqd ?? 0,
              regular: res.quote?.regular_iqd ?? 0,
              applied: res.quote?.applied_iqd ?? 0,
              maxQty: unpriced ? 0 : Math.max(0, Math.trunc(stock?.max_qty ?? LINE_QTY_MAX)),
              tracked: stock?.tracked === true,
              scope: String(stock?.scope ?? ''),
              preorder: res.availability?.mode === 'preorder',
              quotaTracked: capacity?.tracked === true,
              errors: [...(res.quote?.errors ?? []), ...(res.availability?.selection?.errors ?? [])],
              unpriced,
            },
          }));
        })
        .catch((err) => {
          if (ac.signal.aborted) return;
          if (err instanceof ApiError && err.code === 'ABORTED') return;
          setQuoteFailed((now) => ({ ...now, [key]: true }));
        })
        .finally(() => {
          if (inFlight.current.get(key) === ac) inFlight.current.delete(key);
          setTick((n) => n + 1);
        });
    }
    // `tick` re-runs this when a slot frees.
  }, [rows, quantities, quotes, quoteFailed, sharedKey, sharedReady, tick, lineIds, lineColour, productSlug, route, fulfillmentType, warrantyPlanId]); // eslint-disable-line react-hooks/exhaustive-deps

  const freshQuote = (rowId: string): RowQuote | null => quotes[quoteKey(rowId)] ?? null;

  // ------------------------------------------- an option changed under the rows (§3.4)
  const [shareNotice, setShareNotice] = useState('');
  const lastShared = useRef(sharedKey);
  useEffect(() => {
    if (lastShared.current === sharedKey) return;
    lastShared.current = sharedKey;
    const offered = new Set(rows.filter((r) => r.offered).map((r) => r.id));
    const kept: Record<string, number> = {};
    let dropped = 0;
    for (const [id, q] of Object.entries(quantities)) {
      if (q <= 0) continue;
      if (offered.has(id)) kept[id] = q;
      else dropped += 1;
    }
    if (Object.keys(kept).length === 0 && dropped === 0) return;
    if (dropped > 0) onQuantities(kept);
    const changed = sharedLabel ? cs.optionChangedKept(isolate(sharedLabel)) : '';
    setShareNotice([changed, dropped > 0 ? cs.rowsDropped(groupedNumber(dropped)) : ''].filter(Boolean).join(' '));
  }, [sharedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------- ceilings
  const live = rows.filter((r) => (quantities[r.id] ?? 0) > 0);
  const sharedPool = (() => {
    let pool: number | null = null;
    for (const r of live) {
      const q = freshQuote(r.id);
      if (!q) continue;
      const shared = q.preorder ? q.quotaTracked : q.tracked && SHARED_SCOPES.has(q.scope);
      if (!shared) continue;
      // The shelf's `max_qty` does not count the cart: what the cart already holds on this
      // shelf is not there for the rows (the batch door refuses the sum, worker/routes/cart.ts 6b).
      const held = q.preorder ? 0 : heldOnSharedCounter(cartLinesLoaded ? cartLines : [], productId, q.scope, sharedOptionValueIds);
      const left = Math.max(0, q.maxQty - held);
      pool = pool === null ? left : Math.min(pool, left);
    }
    return pool;
  })();
  const ceilings = rowCeilings(
    rows.map((r) => {
      const q = freshQuote(r.id);
      return { id: r.id, qty: quantities[r.id] ?? 0, max: !r.offered ? 0 : q ? q.maxQty : r.ownMax };
    }),
    sharedPool === null ? null : { pool: sharedPool }
  );
  // A per-colour row's ceiling is never the pool's: only shared counters share.
  const ceilingOf = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row || !row.offered) return 0;
    if (sharedPool !== null) return ceilings.get(id) ?? 0;
    const q = freshQuote(id);
    const own = q ? q.maxQty : row.ownMax;
    return own === null ? LINE_QTY_MAX : Math.max(0, Math.min(LINE_QTY_MAX, own));
  };

  // ------------------------------------------------------------ the rows
  const [showAll, setShowAll] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [top, setTop] = useState<{ text: string; reload?: boolean } | null>(null);
  const setRow = (id: string, qty: number) => {
    const next = { ...quantities, [id]: Math.max(0, qty) };
    if (next[id] === 0) delete next[id];
    onQuantities(next);
    if (rowErrors[id]) setRowErrors((now) => Object.fromEntries(Object.entries(now).filter(([k]) => k !== id)));
    if (top) setTop(null);
    if (shareNotice) setShareNotice('');
  };

  const others = rows.filter((r) => !((quantities[r.id] ?? 0) > 0));
  const shownOthers = new Set(others.slice(0, VISIBLE_OTHERS).map((r) => r.id));
  const visible = showAll ? rows : rows.filter((r) => (quantities[r.id] ?? 0) > 0 || shownOthers.has(r.id));
  const hiddenCount = rows.length - visible.length;

  // The row a hint pointed at (or the first refused row) takes the focus, scrolled into view.
  useEffect(() => {
    if (!focusRow) return;
    if (!visible.some((r) => r.id === focusRow)) setShowAll(true);
    const t = window.setTimeout(() => {
      const el = document.getElementById(`${rowDomId(focusRow)}-qty`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        (el as HTMLInputElement).focus({ preventScroll: true });
      }
      onFocused();
    }, 60);
    return () => window.clearTimeout(t);
  }, [focusRow]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Shown only when the rows' prices differ (§3.3). */
  const unitOf = (r: ColourRow): number | null => freshQuote(r.id)?.unit ?? r.levelUnit;
  const priceDiffers = new Set(rows.filter((r) => r.offered).map(unitOf).filter((u): u is number => u !== null)).size > 1;

  // ------------------------------------------------------------- totals
  const pieces = live.reduce((sum, r) => sum + (quantities[r.id] ?? 0), 0);
  const pending = live.some((r) => !freshQuote(r.id));
  const total = live.every((r) => unitOf(r) !== null) && live.length > 0
    ? live.reduce((sum, r) => sum + (unitOf(r) ?? 0) * (quantities[r.id] ?? 0), 0)
    : null;
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    if (live.length === 0) return;
    // Written 600 ms after the last change, so holding + is not read out on every step.
    const t = window.setTimeout(
      () => setAnnounced(cs.announceTotal(pieces, live.length, total === null ? '—' : money(total))),
      600
    );
    return () => window.clearTimeout(t);
  }, [pieces, live.length, total]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------- the gate
  const [busy, setBusy] = useState(false);
  const addInFlight = useRef(false);
  const gateOpen =
    sharedReady &&
    live.length > 0 &&
    !busy &&
    live.every((r) => {
      const q = freshQuote(r.id);
      return !!q && !q.unpriced && q.errors.length === 0 && (quantities[r.id] ?? 0) <= ceilingOf(r.id);
    });
  const lines = live.map((r) => ({ name: r.name, qty: quantities[r.id] ?? 0 }));
  const btn = multiAddButton({ lang: cl, signedIn: isAuthenticated, signInLabel, busy, gateOpen, lines });

  // ------------------------------------------------------------- the add
  const [conflict, setConflict] = useState<{ cartType: unknown; incomingType: unknown } | null>(null);
  /** `keep`: rows that stay after the sheet closes (a lost answer where only some colours landed). */
  const [sheet, setSheet] = useState<{ lines: AddedLine[]; keep?: Record<string, number> } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const sentInCart = useRef<Record<string, number>>({});
  const sentReplace = useRef(false);

  const rowOfLine = (l: { color_id?: unknown; option_value_ids?: unknown }): string | null => {
    if (dimension.kind === 'color') return typeof l.color_id === 'string' ? l.color_id : null;
    const ids = Array.isArray(l.option_value_ids) ? (l.option_value_ids as string[]) : [];
    return rows.find((r) => ids.includes(r.id))?.id ?? null;
  };

  const sentenceFor = (code: string, details: Record<string, unknown>, message: string): string => {
    const counted = stockRefusal({ code, details }, cl);
    if (counted) return counted;
    const own = reasonFor?.(code) ?? '';
    return own || refusalText(code, cl, message);
  };

  const send = async (replaceCart: boolean) => {
    if (addInFlight.current) return;
    if (!isAuthenticated) {
      onSignIn();
      return;
    }
    if (live.length === 0) return;
    addInFlight.current = true;
    setBusy(true);
    setTop(null);
    setRowErrors({});
    const order = live.map((r) => r.id);
    const sent: Record<string, number> = {};
    for (const id of order) sent[id] = inCartOf(id);
    sentInCart.current = sent;
    sentReplace.current = replaceCart;
    try {
      const body: Record<string, unknown> = {
        productId,
        lines: order.map((id) => ({
          optionValueIds: lineIds(id),
          colorId: lineColour(id),
          qty: quantities[id] ?? 0,
          // What the page believes the cart holds of this exact line — only when it knows.
          ...(cartLinesLoaded ? { inCart: sent[id] } : {}),
        })),
      };
      if (fulfillmentType) body.fulfillmentType = fulfillmentType;
      if (fulfillmentType === 'pre_order' && route) body.transportMethod = route;
      if (warrantyPlanId) body.warrantyPlanId = warrantyPlanId;
      if (replaceCart) body.replaceCart = true;
      const res = await api.post<{ items: CartItem[]; added: AddedLine[] }>('/api/cart/items/batch', body);
      setConflict(null);
      onCartItems(Array.isArray(res.items) ? res.items : []);
      setSheet({ lines: Array.isArray(res.added) ? res.added : [] });
    } catch (err) {
      await refused(err, order);
    } finally {
      addInFlight.current = false;
      setBusy(false);
    }
  };

  const refused = async (err: unknown, order: string[]) => {
    if (!(err instanceof ApiError)) {
      setTop({ text: cs.genericFailure });
      return;
    }
    if (err.status === 401) {
      onSignIn();
      return;
    }
    if (err.code === 'CART_SHIPPING_CONFLICT') {
      setConflict({ cartType: err.details?.cart_shipping_type, incomingType: err.details?.incoming_shipping_type });
      return;
    }
    if (err.code === 'CART_LINES_CHANGED') {
      // The earlier press may have landed and only its answer was lost: the cart says which.
      // A line landed when it holds what that press would have left — a merge held to the
      // shelf ends AT the shelf (min(before + want, max(want, max_qty))), never at before + shelf.
      try {
        const fresh = await api.get<{ items: CartItem[] }>('/api/cart');
        const items = Array.isArray(fresh.items) ? fresh.items : [];
        onCartItems(items);
        const read = order.map((id) => ({
          id,
          before: sentInCart.current[id] ?? 0,
          want: quantities[id] ?? 0,
          after: inCartOf(id, items),
          maxQty: freshQuote(id)?.maxQty ?? rows.find((r) => r.id === id)?.ownMax ?? null,
          replaced: sentReplace.current,
        }));
        const verdict = lostAnswerVerdict(read);
        if (verdict.landed.length > 0) {
          // What landed is confirmed from the re-read cart, never «nothing was added».
          const keep: Record<string, number> = {};
          for (const id of verdict.missing) keep[id] = quantities[id] ?? 0;
          setSheet({
            lines: read
              .filter((l) => verdict.landed.includes(l.id))
              .map((l, index) => {
                const from = l.replaced ? 0 : l.before;
                return {
                  index,
                  line_id: null,
                  option_value_ids: lineIds(l.id),
                  color_id: lineColour(l.id),
                  requested: l.want,
                  before: from,
                  after: l.after,
                  capped: l.after < from + l.want,
                };
              }),
            keep,
          });
          setConflict(null);
          if (verdict.missing.length > 0) setTop({ text: cs.partlyAdded });
          return;
        }
      } catch {
        /* the sentence below still says what happened */
      }
      setTop({ text: refusalText('CART_LINES_CHANGED', cl, err.message) });
      return;
    }
    if (err.status === 404) {
      // A page newer than the Worker behind it: the door does not exist there, and nothing was added.
      setTop({ text: cs.genericFailure, reload: true });
      return;
    }
    const details = (err.details ?? {}) as Record<string, unknown>;
    const lineRefusals = Array.isArray(details.lines) ? (details.lines as Array<Record<string, unknown>>) : [];
    const marks: Record<string, string> = {};
    const lowered: Record<string, number> = {};
    for (const l of lineRefusals) {
      const id = rowOfLine(l) ?? order[Number(l.index)] ?? null;
      if (!id) continue;
      const code = String(l.code ?? err.code ?? '');
      marks[id] = sentenceFor(code, l, String(l.message ?? err.message));
      const left = Number(l.available ?? l.max_qty);
      if (code === 'QTY_UNAVAILABLE' && Number.isInteger(left) && left >= 0 && left < (quantities[id] ?? 0)) lowered[id] = left;
    }
    if (details.shared === true && Array.isArray(details.line_indexes)) {
      const n = typeof details.available === 'number' ? details.available : null;
      for (const i of details.line_indexes as number[]) {
        const id = order[i];
        if (!id) continue;
        const sentence = sentenceFor(String(err.code ?? ''), details, err.message);
        marks[id] = n === null ? sentence : `${sentence} ${cs.sharedStock(groupedNumber(n))}`;
      }
    }
    if (Object.keys(marks).length === 0) {
      // A product-level refusal: said once, at the top.
      setTop({ text: sentenceFor(String(err.code ?? ''), details, err.message) });
      return;
    }
    setRowErrors(marks);
    setTop({ text: cs.batchRefusedTop });
    if (Object.keys(lowered).length > 0) onQuantities({ ...quantities, ...lowered });
    const first = order.find((id) => marks[id]);
    if (first) {
      if (!visible.some((r) => r.id === first)) setShowAll(true);
      window.setTimeout(() => {
        const el = document.getElementById(`${rowDomId(first)}-qty`);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        (el as HTMLInputElement | null)?.focus({ preventScroll: true });
      }, 60);
    }
  };

  const closeSheet = () => {
    const keep = sheet?.keep ?? {};
    setSheet(null);
    onQuantities(keep);
    // The button stays focusable with no row filled (aria-disabled, `multiAddButton`), so the
    // focus really comes back to it (§3.8) instead of falling to <body>.
    window.setTimeout(() => addButtonRef.current?.focus(), 0);
  };

  const clearAll = () => {
    const before = { ...quantities };
    onQuantities({});
    toast.info(cs.quantitiesCleared, { action: { label: cs.undo, onClick: () => onQuantities(before) }, duration: 6000 });
  };

  // -------------------------------------------------------------- pieces
  const button = (slot: 'bar' | 'panel') => (
    <button
      ref={(slot === 'panel') === wide ? addButtonRef : undefined}
      type="button"
      data-testid="product-cta"
      data-colour-multi-add={slot}
      onClick={() => {
        if (btn.ariaDisabled) return;
        void send(false);
      }}
      disabled={btn.disabled}
      aria-disabled={btn.ariaDisabled || undefined}
      aria-busy={busy || undefined}
      aria-label={btn.ariaLabel}
      className="lv-button lv-button-primary w-full min-h-[50px] text-[15px] active:scale-[0.985] [touch-action:manipulation]"
    >
      <ShoppingCart aria-hidden="true" className="w-5 h-5" />
      <span className="truncate">{btn.label}</span>
    </button>
  );

  const summary = (
    <div className="space-y-1.5" data-colour-summary>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="tabular-nums text-text-secondary">{cs.totalLine(pieces, live.length)}</span>
        {live.length > 0 ? (
          <button type="button" onClick={clearAll} className="lv-button lv-button-ghost lv-button-sm min-h-[44px] shrink-0">
            {cs.clearQuantities}
          </button>
        ) : null}
      </div>
      {sharedPool !== null ? (
        <p className="text-[12px] text-text-muted" data-shared-stock>
          {fulfillmentType === 'pre_order' ? cs.sharedQuota(groupedNumber(sharedPool)) : cs.sharedStock(groupedNumber(sharedPool))}
        </p>
      ) : null}
    </div>
  );

  const totalFigure = (
    <div className="min-w-0">
      <div className="text-[11px] text-text-muted">{cs.totalCaption}</div>
      <div
        aria-busy={pending || undefined}
        className={`text-text-primary font-black text-[15px] tabular-nums truncate transition-opacity duration-200 ${pending ? 'opacity-55' : 'opacity-100'}`}
      >
        {total !== null ? money(total) : '—'}
      </div>
    </div>
  );

  const topBlock = top ? (
    <p role="alert" className="lv-alert lv-alert-danger text-red-200 text-[13px]" data-colour-batch-refusal>
      {top.text}
      {top.reload ? (
        // The only way forward from this state: a 44 px target around the words (`lv-hit`).
        <button type="button" onClick={() => window.location.reload()} className="relative lv-hit ms-2 font-bold underline underline-offset-2">
          {cs.reloadPage}
        </button>
      ) : null}
    </p>
  ) : null;

  const quickBuyNote = quickBuyOn ? <p className="text-[11px] text-text-muted leading-relaxed">{cs.quickBuyOneColour}</p> : null;

  const addedPieces = (sheet?.lines ?? []).reduce((sum, l) => sum + Math.max(0, l.after - l.before), 0);

  return (
    <div className="mt-3" data-colour-quantity-panel>
      <div className="space-y-2" role="list">
        {visible.map((r, i) => {
          const qty = quantities[r.id] ?? 0;
          const ceiling = ceilingOf(r.id);
          const nameId = `${rowDomId(r.id)}-name`;
          const descId = `${rowDomId(r.id)}-desc`;
          const errId = `${rowDomId(r.id)}-err`;
          const error = rowErrors[r.id] ?? '';
          const q = freshQuote(r.id);
          const inCart = cartLinesLoaded ? inCartOf(r.id) : 0;
          const unit = unitOf(r);
          const regular = q ? q.regular : r.levelRegular;
          const applied = q ? q.applied : r.levelApplied;
          const zero = r.offered && ceiling === 0;
          const facts: React.ReactNode[] = [];
          if (r.chip && !zero && !r.soldOut) facts.push(<span key="chip" className={r.chip.cls}>{r.chip.text}</span>);
          if (zero || r.soldOut) facts.push(<span key="zero" className="text-red-300">{cs.rowSoldOutZero}</span>);
          if (r.noPrice || q?.unpriced) facts.push(<span key="np">{lang === 'en' ? 'No price' : lang === 'ckb' ? 'بێ نرخ' : 'بلا سعر'}</span>);
          if (priceDiffers && unit !== null && !r.noPrice) {
            facts.push(
              <span key="price" className="tabular-nums">
                {money(unit)}
                {regular !== null && applied !== null && applied < regular ? (
                  <span className="ms-1 line-through text-text-muted">{money(regular)}</span>
                ) : null}
              </span>
            );
          }
          if (inCart > 0) facts.push(<span key="cart" className="tabular-nums">{cs.inCart(groupedNumber(inCart))}</span>);
          const lastTwo = i >= visible.length - 2;
          return (
            <div
              key={r.id}
              role="listitem"
              className="lv-choice flex min-h-[56px] items-center gap-3 px-3 py-2"
              data-selected={qty > 0 ? 'true' : undefined}
              data-colour-row={r.id}
              data-row-offered={r.offered ? undefined : 'false'}
            >
              <div role="group" aria-labelledby={nameId} className="flex min-w-0 flex-1 items-center gap-3">
                <ColourSwatch hex={r.hex} image={r.image} px={32} />
                <div className="min-w-0 flex-1">
                  <bdi id={nameId} className="block truncate text-[14px] font-bold text-text-primary">{r.name}</bdi>
                  <p id={descId} className="text-[12px] leading-snug text-text-secondary">
                    {facts.map((f, k) => (
                      <React.Fragment key={k}>
                        {k > 0 ? ' · ' : null}
                        {f}
                      </React.Fragment>
                    ))}
                  </p>
                  {error ? (
                    <p id={errId} className="mt-0.5 text-[12px] leading-snug text-red-300" data-row-refusal>
                      {error}
                    </p>
                  ) : null}
                </div>
                <QuantityInput
                  value={qty}
                  min={0}
                  max={ceiling}
                  size="sm"
                  autoClamp={r.offered}
                  disabled={!r.offered}
                  limitKind={fulfillmentType === 'pre_order' ? 'preorder_quota' : 'stock'}
                  hintPlacement={lastTwo ? 'above' : 'below'}
                  label={cs.rowQty(isolate(r.name))}
                  increaseLabel={cs.rowIncrease(isolate(r.name))}
                  decreaseLabel={cs.rowDecrease(isolate(r.name))}
                  stepButtonsInTabOrder={false}
                  describedBy={[descId, error ? errId : ''].filter(Boolean).join(' ')}
                  invalid={!!error}
                  inputId={`${rowDomId(r.id)}-qty`}
                  onChange={(next) => setRow(r.id, next)}
                />
              </div>
              <span className="lv-choice-mark"><Check aria-hidden="true" className="h-3 w-3" /></span>
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 ? (
        <button type="button" onClick={() => setShowAll(true)} className="lv-button lv-button-ghost lv-button-sm mt-2 min-h-[44px]">
          {cs.showAllColours(groupedNumber(rows.length))}
        </button>
      ) : null}
      {shareNotice ? (
        <p role="status" className="mt-2 text-[12px] text-text-secondary">{shareNotice}</p>
      ) : null}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announced}</p>
      {/* ONE role="alert" per layout: on the desktop the sentence rides in the panel beside the button. */}
      {!(panelSlot && wide) ? <div className="mt-3 space-y-2">{topBlock}</div> : null}

      {barSlot
        ? createPortal(
            <div className="space-y-2" data-colour-bar>
              {totalFigure}
              {button('bar')}
              {quickBuyNote}
            </div>,
            barSlot
          )
        : null}
      {panelSlot && wide
        ? createPortal(
            <div className="space-y-3" data-colour-panel>
              {summary}
              <div className="flex items-end justify-between gap-3">{totalFigure}</div>
              {topBlock}
              {button('panel')}
              {quickBuyNote}
            </div>,
            panelSlot
          )
        : null}
      {!wide ? <div className="mt-3">{summary}</div> : null}

      <ShippingConflictDialog
        open={conflict !== null}
        lang={lang}
        dir={lang === 'en' ? 'ltr' : 'rtl'}
        cartType={conflict?.cartType}
        incomingType={conflict?.incomingType}
        busy={busy}
        onConfirm={() => void send(true)}
        onCancel={() => setConflict(null)}
      />

      <Sheet
        open={sheet !== null}
        onClose={closeSheet}
        label={cs.addedSheetTitle}
        // One resting height on a phone (half the screen; a long list scrolls inside it). A second
        // detent would add the grabber button, whose two words have no Sorani yet (src/components/ui/Sheet.tsx).
        detents={['medium']}
        defaultDetent="medium"
        // From `sm` up a short list in a short window: each colour sits beside its «× n», not 1,200 px away.
        panelClassName="sm:max-w-[440px] sm:w-[92vw]"
        header={
          <h2 className="px-5 pt-1 pb-2 text-[17px] font-black text-text-primary" data-added-sheet-title>
            {cs.addedSheetTitle}
          </h2>
        }
        footer={
          <div className="grid grid-cols-2 gap-2 px-5 py-3">
            <Link to="/cart" className="lv-button lv-button-primary min-h-[48px] text-[14px]" onClick={() => setSheet(null)}>
              {cs.viewCart}
            </Link>
            <button type="button" onClick={closeSheet} className="lv-button lv-button-secondary min-h-[48px] text-[14px]">
              {cs.keepShopping}
            </button>
          </div>
        }
      >
        <div className="px-5 pb-3" data-added-sheet>
          <ul className="divide-y divide-border-subtle">
            {(sheet?.lines ?? []).map((l) => {
              const id = rowOfLine(l) ?? '';
              const row = rows.find((r) => r.id === id);
              const name = row?.name ?? id;
              const added = Math.max(0, l.after - l.before);
              return (
                <li key={`${l.index}-${id}`} className="py-2.5" aria-label={cs.sheetLine(isolate(name), groupedNumber(added))}>
                  <div className="flex items-center justify-between gap-3">
                    <ColourTag name={name} hex={row?.hex} image={row?.image} />
                    <span className="shrink-0 text-[14px] font-bold tabular-nums text-text-primary">× {groupedNumber(added)}</span>
                  </div>
                  {l.capped ? (
                    <p className="mt-1 ps-6 text-[12px] text-amber-300" data-added-capped>
                      {cs.addedLineCapped(groupedNumber(l.after))}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 border-t border-border-subtle pt-3 text-[13px] font-bold tabular-nums text-text-primary">
            {cs.addedTotal(groupedNumber(addedPieces))}
          </p>
        </div>
      </Sheet>
    </div>
  );
}
