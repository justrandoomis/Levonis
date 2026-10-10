/**
 * «الشراء السريع» — the session: add, change, remove, cancel, and the view
 * (owner brief 2026-10-06 §8–§20, docs/GIFTS_QUICK_BUY.md §3.3).
 *
 * EVERY CHANGE IS PRICED BY THE CART'S OWN CHECKOUT and written in ONE batch.
 *
 *   price  `computeCheckout` with the session as its line source: the same
 *          resolver, stock authority, membership rules, delivery engine (and
 *          its wallet free-delivery rule) and wallet arithmetic as a cart
 *          checkout. Lines already in the session keep the unit price they
 *          were quoted at (a lower live price is honoured); the session's own
 *          reserved units and held money are credited back so they never
 *          refuse it.
 *   write  one D1 batch: the idempotency row → the session (inserted, or
 *          updated only while `rev` is unchanged AND `expires_at` is still in
 *          the future by the DATABASE's clock, fenced) → the lines → the stock
 *          (release, then reserve, each fenced on its ledger rows) → the money
 *          (the old hold released and asserted released, the new hold for the
 *          new total inserted under the wallet's own availability guard and
 *          fenced) → the trail. Any guard that does not hold rolls everything
 *          back: no half-applied change can exist (§18–§19).
 *
 * The hold always equals the session total (D11): a change replaces it, so a
 * smaller total is a partial release and a larger one is a larger hold.
 */
import { listing } from '../listing';
import type { Context } from 'hono';
import type { AppContext, SessionUser } from '../types';
import { HttpError, badRequest, conflict, int, str } from '../http';
import { newId, newOrderId } from '../crypto';
import { fence } from '../operations';
import { freeOnTargets, planInventory, stockRowKey, type InventoryPlan, type StockMove, type StockTarget } from '../inventory';
import { assertHoldStateStatement, purchaseHoldInsertStatement, releaseHoldStatement } from '../walletOps';
import { walletFreeDeliveryPublic, WALLET_FREE_DELIVERY_LABEL } from '../walletFreeDelivery';
import { PRINTER_STANDARD_DELIVERY_POLICY, isPrinterStandardAcceptance } from '@levonis/shipping/printerDeliveryPolicy';
import { CART_LINE_COLUMNS } from '../cartLineProjection';
import {
  checkoutInputFrom,
  computeCheckout,
  type CheckoutComputation,
  type CheckoutSource,
  type ComputedLine,
} from '../../routes/orders';
import {
  canonicalOptionValues,
  isoIn,
  parseJson,
  QUICK_BUY_MAX_LINES,
  QUICK_BUY_MAX_QTY,
  QUICK_BUY_WINDOW_MS,
  sameTargets,
  SQL_NOW,
  type HeldTarget,
  type QuickBuyItemRow,
  type QuickBuySessionRow,
} from './model';
import { addressRow, consentIdsOf, currentVersions, loadProfile, needsConsent } from './profile';

// --------------------------------------------------------------------- reads

export function loadOpenSession(db: D1Database, userId: string): Promise<QuickBuySessionRow | null> {
  return db.prepare(`SELECT * FROM quick_buy_sessions WHERE user_id = ? AND state = 'open'`).bind(userId).first<QuickBuySessionRow>();
}

export function loadSession(db: D1Database, id: string): Promise<QuickBuySessionRow | null> {
  return db.prepare('SELECT * FROM quick_buy_sessions WHERE id = ?').bind(id).first<QuickBuySessionRow>();
}

export async function liveItems(db: D1Database, sessionId: string): Promise<QuickBuyItemRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM quick_buy_items WHERE session_id = ? AND qty > 0 ORDER BY created_at, id')
    .bind(sessionId)
    .all<QuickBuyItemRow>();
  return results ?? [];
}

export const isExpired = (s: Pick<QuickBuySessionRow, 'expires_at'>, nowMs = Date.now()) => Date.parse(s.expires_at) <= nowMs;

/** The counters each line's units are held on, summed per counter row. */
export function heldCredit(items: readonly QuickBuyItemRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (it.reserved_qty <= 0) continue;
    for (const t of parseJson<HeldTarget[]>(it.stock_targets, [])) {
      const key = stockRowKey(it.product_id, t as Pick<StockTarget, 'scope' | 'scope_id'>);
      out.set(key, (out.get(key) ?? 0) + it.reserved_qty);
    }
  }
  return out;
}

/** A release/reserve move aimed at stored counters (the shape orderInventory replays). */
export function heldMove(productId: string, lineId: string, targets: readonly HeldTarget[], qty: number): StockMove {
  return {
    product_id: productId,
    qty,
    line_id: lineId,
    targets: targets.map((t) => ({
      scope: t.scope as StockTarget['scope'],
      scope_id: t.scope_id,
      stock: 0,
      reserved: 0,
      low_stock_threshold: null,
      label: t.scope_id || 'base',
    })),
  };
}

/** Every ledger row a plan intends to write must exist after its statements ran. */
export function planFence(db: D1Database, plan: InventoryPlan): D1PreparedStatement[] {
  if (plan.keys.length === 0) return [];
  return fence(db, '(SELECT COUNT(*) FROM inventory_ledger WHERE idempotency_key IN (SELECT value FROM json_each(?))) = ?', [
    JSON.stringify(plan.keys),
    plan.keys.length,
  ]);
}

const EMPTY_PLAN: InventoryPlan = { applied: 0, skipped: 0, rejected: [], keys: [], statements: [], eventIds: [], plannedLedgerRows: 0 };

export function eventStatement(
  db: D1Database,
  e: {
    session_id: string;
    user_id: string;
    kind: string;
    amount_iqd?: number;
    amount_cents?: number;
    item_id?: string | null;
    hold_id?: string | null;
    order_id?: string | null;
    action_key?: string | null;
    detail?: Record<string, unknown>;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO quick_buy_events (id, session_id, user_id, kind, amount_iqd, amount_cents, item_id, hold_id, order_id, action_key, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      newId('qbe'),
      e.session_id,
      e.user_id,
      e.kind,
      Math.trunc(e.amount_iqd ?? 0),
      Math.trunc(e.amount_cents ?? 0),
      e.item_id ?? null,
      e.hold_id ?? null,
      e.order_id ?? null,
      e.action_key ?? null,
      JSON.stringify(e.detail ?? {})
    );
}

// ---------------------------------------------------------------------- view

interface ItemSnapshot {
  name?: string;
  name_ar?: string;
  name_ku?: string;
  variant?: string;
  sku?: string;
  slug?: string;
  regular_unit_iqd?: number;
  membership_discount_iqd?: number;
}

export async function sessionView(db: D1Database, s: QuickBuySessionRow, nowMs = Date.now(), lang: string = 'ar') {
  const { results } = await db
    .prepare(
      `SELECT qi.*, p.slug AS product_slug, p.status AS product_status
         FROM quick_buy_items qi LEFT JOIN products p ON p.id = qi.product_id
        WHERE qi.session_id = ? AND qi.qty > 0
        ORDER BY qi.created_at, qi.id`
    )
    .bind(s.id)
    .all<QuickBuyItemRow & { product_slug: string | null; product_status: string | null }>();
  const quote = parseJson<{ wallet_free_delivery?: { applied?: boolean } }>(s.quote_json, {});
  const address = parseJson<Record<string, unknown>>(s.address_snapshot, {});
  const pick = (k: string) => (typeof address[k] === 'string' ? (address[k] as string) : '');
  const open = s.state === 'open';
  const remaining = Math.max(0, Date.parse(s.expires_at) - nowMs);
  // The «+» ceiling of each line: what it holds plus what the shelf has free
  // right now (an untracked product is limited only by the per-line maximum).
  const rows = results ?? [];
  const ceilings = open
    ? await Promise.all(
        rows.map(async (it) => {
          const free = await freeOnTargets(db, it.product_id, parseJson<HeldTarget[]>(it.stock_targets, []) as Array<Pick<StockTarget, 'scope' | 'scope_id'>>);
          return Math.min(QUICK_BUY_MAX_QTY, free === null ? QUICK_BUY_MAX_QTY : it.qty + free);
        })
      )
    : rows.map((it) => it.qty);
  const labelLang = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  return {
    id: s.id,
    state: s.state,
    started_at: s.started_at,
    expires_at: s.expires_at,
    server_now: new Date(nowMs).toISOString(),
    remaining_ms: open ? remaining : 0,
    /** Edits are accepted only while this is true — and the server re-checks it in the batch. */
    editable: open && remaining > 0,
    items: rows.map((it, i) => {
      const snap = parseJson<ItemSnapshot>(it.snapshot, {});
      return {
        id: it.id,
        product_id: it.product_id,
        slug: it.product_slug ?? snap.slug ?? '',
        name: snap.name ?? '',
        name_ar: snap.name_ar ?? snap.name ?? '',
        name_ku: snap.name_ku ?? '',
        image: it.image_snapshot,
        variant: snap.variant ?? '',
        /** The selection as checkout resolved it — option values and colour in one label. */
        option_label: snap.variant ?? '',
        color_label: '',
        sku: snap.sku ?? '',
        qty: it.qty,
        max_qty: ceilings[i],
        unit_price_iqd: it.unit_price_iqd,
        line_total_iqd: it.line_total_iqd,
        option_value_ids: parseJson<string[]>(it.option_value_ids, []),
        color_id: it.color_id,
        warranty_plan_id: it.warranty_plan_id,
      };
    }),
    items_iqd: s.items_iqd,
    discount_iqd: s.discount_iqd,
    shipping_iqd: s.shipping_iqd,
    shipping_before_iqd: s.shipping_before_iqd,
    free_delivery: {
      applied: quote.wallet_free_delivery?.applied === true,
      /** «توصيل عادي مجاني — للدفع الكامل من محفظة Levo», in the reader's language, when applied. */
      label: quote.wallet_free_delivery?.applied === true ? WALLET_FREE_DELIVERY_LABEL[labelLang] : null,
      labels: WALLET_FREE_DELIVERY_LABEL,
    },
    total_iqd: s.total_iqd,
    // What the wallet holds for it NOW: an open session's hold, and a `failed`
    // one's too — a row parked before DECISIONS row 188 keeps its hold until
    // the next minute's sweep cancels it and returns the money.
    held_iqd: (open || s.state === 'failed') && s.hold_id ? s.held_iqd : 0,
    address: {
      name: pick('name'),
      phone: pick('phone'),
      governorate: pick('governorate'),
      area: pick('area'),
      address: pick('address'),
      landmark: pick('landmark'),
    },
    delivery_method: 'standard' as const,
    order_id: s.state === 'submitted' ? s.order_id : null,
    submitted_at: s.submitted_at,
    finalize_error: s.state === 'failed' ? s.finalize_error : null,
    /** Why a cancelled session closed — `not_submitted` when the system gave up on it and refunded it. */
    cancel_reason: s.state === 'cancelled' ? s.cancel_reason : null,
    rev: s.rev,
  };
}

export type SessionView = Awaited<ReturnType<typeof sessionView>>;

// ---------------------------------------------------------------- the change

export interface QuickBuyAddInput {
  productId: string;
  qty: number;
  optionId: string;
  optionValueIds: string;
  colorId: string;
  warrantyPlanId: string;
}

export type QuickBuyChange =
  | { kind: 'add'; key: string; add: QuickBuyAddInput; printerAck: unknown }
  | { kind: 'update'; key: string; itemId: string; qty: number }
  | { kind: 'remove'; key: string; itemId: string };

export function parseAdd(body: Record<string, unknown>): QuickBuyAddInput {
  const optionValueIds = Array.isArray(body.optionValueIds) ? body.optionValueIds.map(String).slice(0, 20) : [];
  return {
    productId: str(body.productId, 'productId', { min: 1, max: 80 }),
    qty: int(body.qty ?? 1, 'qty', { min: 1, max: QUICK_BUY_MAX_QTY }),
    optionId: str(body.optionId, 'optionId', { max: 80, required: false }),
    optionValueIds: canonicalOptionValues(optionValueIds),
    colorId: str(body.colorId, 'colorId', { max: 80, required: false }),
    warrantyPlanId: str(body.warrantyPlanId, 'warrantyPlanId', { max: 80, required: false }),
  };
}

/** A stable digest of what was asked, so one key cannot be reused for a different request. */
export async function requestHash(kind: string, payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}:${JSON.stringify(payload)}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Candidate {
  id: string;
  product_id: string;
  qty: number;
  option_id: string;
  option_value_ids: string;
  color_id: string;
  warranty_plan_id: string;
  existing: QuickBuyItemRow | null;
}

/** What a Quick Buy line says for each cart column; any other column reads as
 *  its own migration's default (CART_LINE_COLUMNS), so a column the cart gains
 *  later can never break a Quick Buy read. */
const CANDIDATE_VALUES: Record<string, string> = {
  option_id: "json_extract(value, '$.option_id')",
  option_value_ids: "json_extract(value, '$.option_value_ids')",
  color_id: "json_extract(value, '$.color_id')",
  fulfillment_type: "'direct_sale'",
  warranty_plan_id: "json_extract(value, '$.warranty_plan_id')",
};

/** The session's lines as a cart: one JSON parameter however many lines. */
function linesSource(lines: readonly Candidate[]): NonNullable<CheckoutSource['lines']> {
  const columns = CART_LINE_COLUMNS.map((col) => `${CANDIDATE_VALUES[col.name] ?? col.sqlDefault} AS ${col.name}`).join(',\n               ');
  return {
    build: (projection) => `WITH ci AS (
        SELECT json_extract(value, '$.id') AS id,
               json_extract(value, '$.product_id') AS product_id,
               CAST(json_extract(value, '$.qty') AS INTEGER) AS qty,
               ${columns}
          FROM json_each(?))
      SELECT ci.id AS cart_item_id, ci.qty, ${projection}, p.*
        FROM ci JOIN products p ON p.id = ci.product_id`,
    params: [
      JSON.stringify(
        lines.map((l) => ({
          id: l.id,
          product_id: l.product_id,
          qty: l.qty,
          option_id: l.option_id,
          option_value_ids: l.option_value_ids,
          color_id: l.color_id,
          warranty_plan_id: l.warranty_plan_id,
        }))
      ),
    ],
  };
}

/** The columns quick_buy_items itself carries (0176), read as they are. */
const ITEM_COLUMNS = new Set([
  'option_id', 'option_value_ids', 'color_id', 'shipping_method_id', 'transport_method',
  'fulfillment_type', 'warranty_plan_id', 'draw_salt',
]);

/** A session's stored lines as a cart, for the finaliser — same rule as above. */
export function storedLinesSource(sessionId: string): NonNullable<CheckoutSource['lines']> {
  const columns = CART_LINE_COLUMNS.map((col) => `${ITEM_COLUMNS.has(col.name) ? `qi.${col.name}` : col.sqlDefault} AS ${col.name}`).join(', ');
  return {
    build: (projection) => `WITH ci AS (
        SELECT qi.id, qi.qty, qi.product_id, ${columns}
          FROM quick_buy_items qi WHERE qi.session_id = ? AND qi.qty > 0)
      SELECT ci.id AS cart_item_id, ci.qty, ${projection}, p.*
        FROM ci JOIN products p ON p.id = ci.product_id`,
    params: [sessionId],
  };
}

const directOnly = () =>
  conflict(
    'الشراء السريع متاح للمنتجات المعروضة للبيع المباشر فقط — استعمل السلة للطلب المسبق والعروض / Quick Buy is for direct-sale products only — use the cart for pre-orders and bundles',
    'QUICK_BUY_DIRECT_ONLY'
  );

/** Price the candidate lines exactly as the cart checkout would. */
async function quoteCandidates(
  c: Context<AppContext>,
  user: SessionUser,
  session: QuickBuySessionRow | null,
  address: Record<string, unknown>,
  items: readonly QuickBuyItemRow[],
  lines: readonly Candidate[]
): Promise<CheckoutComputation> {
  const input = checkoutInputFrom(
    { addressId: String(address.id ?? session?.address_id ?? 'quick_buy'), deliveryMethodId: 'standard', paymentMethodId: 'wallet' },
    true
  );
  const comp = await computeCheckout(c, user, input, {
    allocate: false,
    source: {
      lines: linesSource(lines),
      address,
      reservedCredit: heldCredit(items),
      walletCreditCents: session?.hold_id ? session.held_cents : 0,
      unitCeilings: new Map(items.map((it) => [it.id, it.unit_price_iqd])),
      exchangeRate: session?.exchange_rate,
    },
  });
  if (comp.delivery.id !== 'standard') throw directOnly();
  if (comp.shippingType !== 'direct') throw directOnly();
  for (const l of comp.lines) {
    if (l.pricing_basis !== 'direct' || l.bundle_parent_item_id || l.mystery_spool) throw directOnly();
  }
  if (comp.shipping.needs_config.length > 0) {
    throw conflict(
      'أجور التوصيل لجزء من الطلب غير مضبوطة بعد / Delivery fees for part of this order are not configured yet',
      'SHIPPING_NEEDS_CONFIG'
    );
  }
  return comp;
}

function insufficient(comp: CheckoutComputation): HttpError {
  return new HttpError(
    409,
    'رصيد محفظة Levo غير كافٍ لإتمام الشراء السريع. / Your Levo Wallet balance is not enough for this Quick Buy.',
    'QUICK_BUY_INSUFFICIENT_BALANCE',
    { available_iqd: Math.max(0, Math.trunc(comp.walletBalanceIqd)), required_iqd: Math.max(0, Math.trunc(comp.totalIqd)) }
  );
}

const busy = () =>
  conflict('طلب الشراء السريع يتغيّر الآن — أعد المحاولة / Your Quick Buy order is changing — try again', 'QUICK_BUY_BUSY');
const expired = () =>
  conflict('انتهى وقت التعديل على طلب الشراء السريع / The Quick Buy order can no longer be changed', 'QUICK_BUY_EXPIRED');

function itemSnapshot(l: ComputedLine, product: Record<string, unknown> | undefined, membershipDiscount: number): string {
  const breakdown = (l.breakdown ?? {}) as { regular_iqd?: unknown };
  const snap: ItemSnapshot = {
    name: l.name,
    name_ar: l.name_ar,
    name_ku: typeof product?.name_ku === 'string' ? (product.name_ku as string) : '',
    variant: l.variant,
    sku: typeof product?.sku === 'string' ? (product.sku as string) : '',
    slug: typeof product?.slug === 'string' ? (product.slug as string) : '',
    regular_unit_iqd: typeof breakdown.regular_iqd === 'number' ? breakdown.regular_iqd : undefined,
    membership_discount_iqd: membershipDiscount,
  };
  return JSON.stringify(snap);
}

/** The session's totals and the quote the hold was sized from. */
function totalsOf(comp: CheckoutComputation) {
  return {
    items_iqd: Math.max(0, Math.trunc(comp.subtotal)),
    discount_iqd: Math.max(0, Math.trunc(comp.benefits.line_discount_iqd)),
    shipping_iqd: Math.max(0, Math.trunc(comp.shipping.total_iqd)),
    shipping_before_iqd: Math.max(0, Math.trunc(comp.shipping.total_before_waiver_iqd)),
    total_iqd: Math.max(0, Math.trunc(comp.totalIqd)),
    held_iqd: Math.max(0, Math.trunc(comp.walletApplied)),
    held_cents: Math.max(0, Math.trunc(comp.walletUsdCents)),
    quote_json: JSON.stringify({
      wallet_free_delivery: walletFreeDeliveryPublic(comp.walletFreeDelivery),
      waiver_source: comp.shipping.waiver_source,
      membership_discount_iqd: comp.benefits.discount_total_iqd,
      exchange_rate: comp.exchangeRate,
    }),
  };
}

export interface ChangeResult {
  session: QuickBuySessionRow | null;
  added: { item_id: string; qty: number } | null;
  replay: boolean;
}

/**
 * Add a product, change a line's quantity or remove it. `finalizeIfDue` is the
 * lazy half of D13: an expired session found here is submitted before
 * anything else happens (the cron is the other half).
 */
export async function applyQuickBuyChange(
  c: Context<AppContext>,
  user: SessionUser,
  change: QuickBuyChange,
  finalizeIfDue: (s: QuickBuySessionRow) => Promise<void>
): Promise<ChangeResult> {
  const db = c.env.DB;
  const hash = await requestHash(change.kind, change.kind === 'add' ? change.add : { itemId: change.itemId, qty: change.kind === 'update' ? change.qty : 0 });
  const prior = await db
    .prepare('SELECT session_id, request_hash, response_json FROM quick_buy_actions WHERE user_id = ? AND key = ?')
    .bind(user.id, change.key)
    .first<{ session_id: string | null; request_hash: string; response_json: string }>();
  if (prior) {
    if (prior.request_hash !== hash) {
      throw conflict('This Quick Buy key was already used for a different request.', 'IDEMPOTENCY_KEY_REUSED');
    }
    return {
      session: prior.session_id ? await loadSession(db, prior.session_id) : null,
      added: parseJson<{ item_id: string; qty: number } | null>(prior.response_json, null),
      replay: true,
    };
  }

  let session = await loadOpenSession(db, user.id);
  if (session && isExpired(session)) {
    await finalizeIfDue(session);
    // The time ran out: a change to THAT order is refused (§12), whatever the
    // finaliser managed; only a new purchase may go on to open a new one.
    if (change.kind !== 'add') throw expired();
    session = await loadOpenSession(db, user.id);
    if (session && isExpired(session)) {
      throw conflict(
        'طلب الشراء السريع السابق قيد الإرسال — انتظر لحظة / Your previous Quick Buy order is being submitted — one moment',
        'QUICK_BUY_PREVIOUS_PENDING'
      );
    }
  }

  if (change.kind === 'add') {
    const profile = await loadProfile(db, user.id);
    if (!profile || profile.enabled !== 1) {
      throw conflict('فعّل الشراء السريع أولاً / Switch Quick Buy on first', 'QUICK_BUY_NOT_ACTIVE');
    }
    if (needsConsent(profile)) {
      throw conflict('وافق على السياسات المحدّثة لمتابعة الشراء السريع / Accept the updated policies to keep using Quick Buy', 'QUICK_BUY_RECONSENT_REQUIRED');
    }
  } else if (!session) {
    throw conflict('لا يوجد طلب شراء سريع مفتوح / There is no open Quick Buy order', 'QUICK_BUY_NO_SESSION');
  }

  const items = session ? await liveItems(db, session.id) : [];

  // The address: the session's frozen snapshot, or — for a new session — the
  // profile's address as it stands right now, which is then frozen (§15).
  let address: Record<string, unknown> | null = session ? parseJson<Record<string, unknown>>(session.address_snapshot, {}) : null;
  if (!session) {
    const profile = await loadProfile(db, user.id);
    address = await addressRow(db, user.id, profile?.address_id ?? null);
    if (!address) {
      throw conflict('اختر عنواناً للشراء السريع من الإعدادات / Choose a Quick Buy address in settings', 'QUICK_BUY_ADDRESS_INVALID');
    }
  }

  // --- the candidate lines
  const lines: Candidate[] = items.map((it) => ({
    id: it.id,
    product_id: it.product_id,
    qty: it.qty,
    option_id: it.option_id,
    option_value_ids: it.option_value_ids,
    color_id: it.color_id,
    warranty_plan_id: it.warranty_plan_id,
    existing: it,
  }));
  let touched: Candidate | null = null;
  let product: Record<string, unknown> | undefined;
  if (change.kind === 'add') {
    const a = change.add;
    product =
      (await db.prepare('SELECT * FROM products WHERE id = ?').bind(a.productId).first<Record<string, unknown>>()) ?? undefined;
    // Listed to customers (worker/lib/listing.ts): a product the owner's «hide incomplete» switch holds is not available here either.
    const L = await listing(db);
    if (!product || !L.isListedRow(product, await L.heldIds([a.productId]))) {
      throw conflict('هذا المنتج غير متاح حالياً / This product is not available', 'QUICK_BUY_UNSUPPORTED_PRODUCT');
    }
    if (String(product.composition ?? '') !== '') throw directOnly();
    touched =
      lines.find(
        (l) =>
          l.product_id === a.productId &&
          l.option_value_ids === a.optionValueIds &&
          l.color_id === a.colorId &&
          l.warranty_plan_id === a.warrantyPlanId
      ) ?? null;
    if (touched) {
      touched.qty += a.qty;
      if (touched.qty > QUICK_BUY_MAX_QTY) throw badRequest(`qty must be at most ${QUICK_BUY_MAX_QTY}`, 'VALIDATION');
    } else {
      if (lines.length >= QUICK_BUY_MAX_LINES) {
        throw conflict(`يتسع طلب الشراء السريع لـ ${QUICK_BUY_MAX_LINES} منتجاً / A Quick Buy order holds at most ${QUICK_BUY_MAX_LINES} lines`, 'QUICK_BUY_FULL');
      }
      touched = {
        id: newId('qbi'),
        product_id: a.productId,
        qty: a.qty,
        option_id: a.optionId,
        option_value_ids: a.optionValueIds,
        color_id: a.colorId,
        warranty_plan_id: a.warrantyPlanId,
        existing: null,
      };
      lines.push(touched);
    }
  } else {
    touched = lines.find((l) => l.id === change.itemId) ?? null;
    if (!touched) throw new HttpError(404, 'هذا المنتج ليس في طلب الشراء السريع / Not in your Quick Buy order', 'QUICK_BUY_ITEM_NOT_FOUND');
    touched.qty = change.kind === 'remove' ? 0 : change.qty;
  }

  const remaining = lines.filter((l) => l.qty > 0);
  if (remaining.length === 0) {
    // Removing the last line is cancelling the order (§10, §19).
    await cancelQuickBuySession(c, user, change.key, 'last_item_removed', session!, { kind: change.kind, hash });
    return { session: await loadSession(db, session!.id), added: null, replay: false };
  }

  // --- price it
  const comp = await quoteCandidates(c, user, session, address!, items, remaining);
  if (comp.requiredAdvance > comp.walletApplied || comp.walletUsdCents <= 0) throw insufficient(comp);
  const containsPrinter = comp.lines.some((l) => l.is_printer);
  let printerAck: string | null = session?.printer_ack_json ?? null;
  if (containsPrinter && !printerAck) {
    const ack = change.kind === 'add' ? change.printerAck : null;
    if (!isPrinterStandardAcceptance(ack)) {
      throw new HttpError(
        409,
        'تجب الموافقة على تحذير التوصيل العادي للطابعات قبل الشراء السريع. / Acknowledge the printer standard-delivery warning first.',
        'PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED',
        { policy: PRINTER_STANDARD_DELIVERY_POLICY }
      );
    }
    printerAck = JSON.stringify({ ...PRINTER_STANDARD_DELIVERY_POLICY, accepted: true, accepted_at: new Date().toISOString() });
  }

  const now = new Date().toISOString();
  const sid = session?.id ?? newId('qbs');
  const rev = session ? session.rev + 1 : 1;
  const actionId = newId('qba');
  const totals = totalsOf(comp);
  const byCandidate = new Map(comp.lines.map((l) => [l.cart_item_id, l]));
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    db
      .prepare(
        `INSERT INTO quick_buy_actions (user_id, key, session_id, kind, request_hash, response_json) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        user.id,
        change.key,
        sid,
        change.kind,
        hash,
        JSON.stringify(change.kind === 'add' && touched ? { item_id: touched.id, qty: touched.qty } : null)
      )
  );

  // --- the money: release the old hold, take the new one, all or nothing
  const holdId = newId('whold');
  const holdStatements: D1PreparedStatement[] = [];
  if (session?.hold_id) {
    holdStatements.push(
      releaseHoldStatement(db, { holdId: session.hold_id, reason: `quick_buy:${change.kind}` }),
      assertHoldStateStatement(db, session.hold_id, 'released')
    );
  }
  holdStatements.push(
    purchaseHoldInsertStatement(db, holdId, {
      userId: user.id,
      amountCents: totals.held_cents,
      eventKey: `qb:${sid}:${rev}`,
      refType: 'quick_buy',
      refId: sid,
      note: `Quick Buy ${sid}`,
    }),
    ...fence(db, `EXISTS (SELECT 1 FROM wallet_holds WHERE id = ? AND state = 'active')`, [holdId])
  );

  // --- the session row
  if (!session) {
    const profile = await loadProfile(db, user.id);
    stmts.push(
      db
        .prepare(
          `INSERT INTO quick_buy_sessions
             (id, user_id, state, started_at, expires_at, order_id, address_id, address_snapshot, delivery_method_id,
              exchange_rate, rev, hold_id, held_iqd, held_cents, items_iqd, discount_iqd, shipping_iqd, shipping_before_iqd,
              total_iqd, quote_json, consent_json, printer_ack_json, created_at, updated_at)
           VALUES (?, ?, 'open', ?, ?, ?, ?, ?, 'standard', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          sid,
          user.id,
          now,
          isoIn(QUICK_BUY_WINDOW_MS, Date.parse(now)),
          newOrderId(),
          String(address!.id ?? ''),
          JSON.stringify(address),
          comp.exchangeRate,
          holdId,
          totals.held_iqd,
          totals.held_cents,
          totals.items_iqd,
          totals.discount_iqd,
          totals.shipping_iqd,
          totals.shipping_before_iqd,
          totals.total_iqd,
          totals.quote_json,
          JSON.stringify({ versions: currentVersions(), acceptance_ids: consentIdsOf(profile) }),
          printerAck,
          now,
          now
        )
    );
  } else {
    stmts.push(
      db
        .prepare(
          `UPDATE quick_buy_sessions
              SET rev = rev + 1, hold_id = ?, held_iqd = ?, held_cents = ?, items_iqd = ?, discount_iqd = ?,
                  shipping_iqd = ?, shipping_before_iqd = ?, total_iqd = ?, quote_json = ?,
                  printer_ack_json = COALESCE(printer_ack_json, ?), updated_at = ${SQL_NOW}
            WHERE id = ? AND rev = ? AND state = 'open' AND expires_at > ${SQL_NOW}`
        )
        .bind(
          holdId,
          totals.held_iqd,
          totals.held_cents,
          totals.items_iqd,
          totals.discount_iqd,
          totals.shipping_iqd,
          totals.shipping_before_iqd,
          totals.total_iqd,
          totals.quote_json,
          printerAck,
          sid,
          session.rev
        ),
      // The guard: this change, and no other, moved the session. A change that
      // lost a race, or that the clock overtook, rolls back here.
      ...fence(db, '(SELECT hold_id FROM quick_buy_sessions WHERE id = ?) = ?', [sid, holdId])
    );
  }

  // --- the lines and their stock
  const releaseMoves: StockMove[] = [];
  const reserveMoves: StockMove[] = [];
  const lineStatements: D1PreparedStatement[] = [];
  const trail: D1PreparedStatement[] = [];
  for (const l of lines) {
    const priced = l.qty > 0 ? byCandidate.get(l.id) : undefined;
    if (l.qty > 0 && !priced) throw busy();
    const oldTargets = l.existing ? parseJson<HeldTarget[]>(l.existing.stock_targets, []) : [];
    const oldReserved = l.existing?.reserved_qty ?? 0;
    const newTargets: HeldTarget[] = priced ? priced.stock_targets.map((t) => ({ scope: t.scope, scope_id: t.scope_id })) : oldTargets;
    const newReserved = priced && newTargets.length > 0 ? l.qty : 0;
    if (sameTargets(oldTargets, newTargets)) {
      const delta = newReserved - oldReserved;
      if (delta > 0) reserveMoves.push(heldMove(l.product_id, l.id, newTargets, delta));
      if (delta < 0 && oldTargets.length) releaseMoves.push(heldMove(l.product_id, l.id, oldTargets, -delta));
    } else {
      if (oldReserved > 0 && oldTargets.length) releaseMoves.push(heldMove(l.product_id, l.id, oldTargets, oldReserved));
      if (newReserved > 0) reserveMoves.push(heldMove(l.product_id, l.id, newTargets, newReserved));
    }
    const membership = priced ? (comp.benefits.byLine.get(priced.id)?.total_iqd ?? 0) : 0;
    if (!l.existing) {
      lineStatements.push(
        db
          .prepare(
            `INSERT INTO quick_buy_items
               (id, session_id, user_id, product_id, option_id, option_value_ids, color_id, fulfillment_type, warranty_plan_id,
                qty, reserved_qty, stock_targets, unit_price_iqd, line_total_iqd, snapshot, image_snapshot, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'direct_sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            l.id,
            sid,
            user.id,
            l.product_id,
            l.option_id,
            l.option_value_ids,
            l.color_id,
            l.warranty_plan_id,
            l.qty,
            newReserved,
            JSON.stringify(newTargets),
            priced!.unit,
            priced!.line,
            itemSnapshot(priced!, product, membership),
            priced!.image ?? '',
            now,
            now
          )
      );
      trail.push(eventStatement(db, { session_id: sid, user_id: user.id, kind: 'add', item_id: l.id, action_key: change.key, detail: { product_id: l.product_id, qty: l.qty } }));
    } else {
      const ex = l.existing;
      lineStatements.push(
        db
          .prepare(
            `UPDATE quick_buy_items
                SET qty = ?, reserved_qty = ?, stock_targets = ?, unit_price_iqd = ?, line_total_iqd = ?,
                    snapshot = COALESCE(?, snapshot), image_snapshot = COALESCE(?, image_snapshot),
                    removed_at = CASE WHEN ? = 0 THEN ${SQL_NOW} ELSE NULL END, updated_at = ${SQL_NOW}
              WHERE id = ? AND session_id = ?`
          )
          .bind(
            l.qty,
            newReserved,
            JSON.stringify(newTargets),
            priced ? priced.unit : ex.unit_price_iqd,
            priced ? priced.line : 0,
            priced && l === touched ? itemSnapshot(priced, product ?? undefined, membership) : null,
            priced && l === touched ? (priced.image ?? '') : null,
            l.qty,
            l.id,
            sid
          )
      );
      if (ex.qty !== l.qty) {
        trail.push(
          eventStatement(db, {
            session_id: sid,
            user_id: user.id,
            kind: l.qty === 0 ? 'remove' : change.kind === 'add' ? 'add' : 'update',
            item_id: l.id,
            action_key: change.key,
            detail: { product_id: l.product_id, qty_from: ex.qty, qty_to: l.qty },
          })
        );
      }
    }
  }

  const op = actionId.slice(0, 24);
  const releasePlan = releaseMoves.length
    ? await planInventory(db, releaseMoves, { kind: 'release', operationId: `qbu_${op}`, actorUserId: user.id, reason: `quick_buy:${sid}` })
    : EMPTY_PLAN;
  if (releasePlan.rejected.length > 0) throw busy();
  const freed = new Map<string, number>();
  for (const m of releaseMoves) for (const t of m.targets) freed.set(stockRowKey(m.product_id, t), (freed.get(stockRowKey(m.product_id, t)) ?? 0) + m.qty);
  const reservePlan = reserveMoves.length
    ? await planInventory(db, reserveMoves, {
        kind: 'reserve',
        operationId: `qbr_${op}`,
        actorUserId: user.id,
        reason: `quick_buy:${sid}`,
        reservedCredit: freed,
      })
    : EMPTY_PLAN;
  if (reservePlan.rejected.length > 0) {
    const line = reserveMoves.find((m) => reservePlan.rejected.some((r) => r.line_id === m.line_id));
    throw new HttpError(409, 'نفدت الكمية المطلوبة من المخزون / Not enough stock for this Quick Buy', 'OUT_OF_STOCK', {
      product_id: line?.product_id ?? null,
    });
  }
  for (const m of reserveMoves) trail.push(eventStatement(db, { session_id: sid, user_id: user.id, kind: 'reserve', item_id: m.line_id, action_key: change.key, detail: { qty: m.qty } }));
  for (const m of releaseMoves) trail.push(eventStatement(db, { session_id: sid, user_id: user.id, kind: 'unreserve', item_id: m.line_id, action_key: change.key, detail: { qty: m.qty } }));

  if (!session) {
    trail.unshift(eventStatement(db, { session_id: sid, user_id: user.id, kind: 'start', action_key: change.key, detail: { expires_at: isoIn(QUICK_BUY_WINDOW_MS, Date.parse(now)) } }));
  } else if (session.hold_id) {
    trail.push(
      eventStatement(db, {
        session_id: sid,
        user_id: user.id,
        kind: 'release',
        amount_iqd: session.held_iqd,
        amount_cents: session.held_cents,
        hold_id: session.hold_id,
        action_key: change.key,
        detail: { replaced_by: holdId },
      })
    );
  }
  trail.push(
    eventStatement(db, {
      session_id: sid,
      user_id: user.id,
      kind: 'hold',
      amount_iqd: totals.held_iqd,
      amount_cents: totals.held_cents,
      hold_id: holdId,
      action_key: change.key,
      detail: { delta_iqd: totals.held_iqd - (session?.held_iqd ?? 0), delta_cents: totals.held_cents - (session?.held_cents ?? 0) },
    })
  );

  stmts.push(
    ...lineStatements,
    ...releasePlan.statements,
    ...planFence(db, releasePlan),
    ...reservePlan.statements,
    ...planFence(db, reservePlan),
    ...holdStatements,
    ...trail
  );

  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg) && /quick_buy_actions/.test(msg)) {
      // The same key committed concurrently: answer as its replay.
      return applyQuickBuyChange(c, user, change, finalizeIfDue);
    }
    const fresh = session ? await loadSession(db, session.id) : await loadOpenSession(db, user.id);
    if (session && fresh && (fresh.state !== 'open' || isExpired(fresh))) throw expired();
    if (/ops_guards|CHECK|NOT NULL/i.test(msg)) {
      // Which guard? Re-read the money: a hold that could not be placed is the balance.
      const avail = await db
        .prepare(
          `SELECT (SELECT COALESCE(SUM(CASE WHEN t.type='deposit' THEN t.amount ELSE -t.amount END),0)
                     FROM wallet_transactions t WHERE t.user_id = ?1 AND t.currency='USD' AND t.status='approved')
                - (SELECT COALESCE(SUM(h.amount_cents),0) FROM wallet_holds h
                     LEFT JOIN wallet_transactions ht ON ht.id = h.tx_id
                    WHERE h.user_id = ?1 AND h.state='active' AND (h.tx_id IS NULL OR ht.status <> 'approved')) AS cents`
        )
        .bind(user.id)
        .first<{ cents: number }>();
      const ownHold = fresh?.hold_id ? fresh.held_cents : 0;
      if ((avail?.cents ?? 0) + ownHold < totals.held_cents) throw insufficient(comp);
    }
    if (/UNIQUE/i.test(msg) || /ops_guards|CHECK|NOT NULL/i.test(msg)) throw busy();
    throw e;
  }
  return {
    session: await loadSession(db, sid),
    added: change.kind === 'add' && touched ? { item_id: touched.id, qty: touched.qty } : null,
    replay: false,
  };
}

/**
 * «إلغاء الكل»: close the session, release every reserved unit and the whole
 * hold — only while it is still open and its time has not run out (after
 * that, the finaliser owns it). One batch, fenced like every other change.
 */
export async function cancelQuickBuySession(
  c: Context<AppContext>,
  user: SessionUser,
  key: string,
  reason: string,
  known?: QuickBuySessionRow,
  /** The change that asked for it (removing the last line), recorded under its own key. */
  action?: { kind: string; hash: string }
): Promise<void> {
  const db = c.env.DB;
  const session = known ?? (await loadOpenSession(db, user.id));
  if (!session) return;
  if (isExpired(session)) throw expired();
  const items = await liveItems(db, session.id);
  const releaseMoves = items
    .filter((it) => it.reserved_qty > 0)
    .map((it) => heldMove(it.product_id, it.id, parseJson<HeldTarget[]>(it.stock_targets, []), it.reserved_qty))
    .filter((m) => m.targets.length > 0);
  const releasePlan = releaseMoves.length
    ? await planInventory(db, releaseMoves, { kind: 'release', operationId: `qbc_${session.id}`, actorUserId: user.id, reason: `quick_buy:${session.id}` })
    : EMPTY_PLAN;
  if (releasePlan.rejected.length > 0) throw busy();
  const stmts: D1PreparedStatement[] = [
    // The key is recorded in the same batch, so a retry of THIS request is a
    // replay — whether it was «إلغاء الكل» or the removal of the last line.
    db
      .prepare(`INSERT INTO quick_buy_actions (user_id, key, session_id, kind, request_hash, response_json) VALUES (?, ?, ?, ?, ?, 'null')`)
      .bind(user.id, key, session.id, action?.kind ?? 'cancel', action?.hash ?? (await requestHash('cancel', { session: session.id }))),
  ];
  stmts.push(
    db
      .prepare(
        `UPDATE quick_buy_sessions
            SET state = 'cancelled', cancelled_at = ${SQL_NOW}, cancel_reason = ?, rev = rev + 1, updated_at = ${SQL_NOW}
          WHERE id = ? AND rev = ? AND state = 'open' AND expires_at > ${SQL_NOW}`
      )
      .bind(reason, session.id, session.rev),
    ...fence(db, `(SELECT state FROM quick_buy_sessions WHERE id = ?) = 'cancelled'`, [session.id]),
    db.prepare(`UPDATE quick_buy_items SET reserved_qty = 0, updated_at = ${SQL_NOW} WHERE session_id = ?`).bind(session.id),
    ...releasePlan.statements,
    ...planFence(db, releasePlan)
  );
  if (session.hold_id) {
    stmts.push(
      releaseHoldStatement(db, { holdId: session.hold_id, reason: `quick_buy:${reason}` }),
      assertHoldStateStatement(db, session.hold_id, 'released'),
      eventStatement(db, {
        session_id: session.id,
        user_id: user.id,
        kind: 'release',
        amount_iqd: session.held_iqd,
        amount_cents: session.held_cents,
        hold_id: session.hold_id,
        action_key: key,
        detail: { reason },
      })
    );
  }
  for (const m of releaseMoves) {
    stmts.push(eventStatement(db, { session_id: session.id, user_id: user.id, kind: 'unreserve', item_id: m.line_id, action_key: key, detail: { qty: m.qty } }));
  }
  stmts.push(eventStatement(db, { session_id: session.id, user_id: user.id, kind: 'cancel', action_key: key, detail: { reason } }));
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg) && /quick_buy_actions/.test(msg)) return;
    const fresh = await loadSession(db, session.id);
    if (fresh?.state === 'cancelled') return;
    if (fresh && (fresh.state !== 'open' || isExpired(fresh))) throw expired();
    throw busy();
  }
}
