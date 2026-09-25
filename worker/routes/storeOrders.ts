/**
 * Checkout and orders for merchant STORE PRODUCTS — /api/store-orders/*.
 *
 * The second of the two merchant commerce paths (§74). The other is the
 * request → offer → escrow path in marketplace.ts. Both belong to the
 * merchant; they are different origins and are recorded as such
 * (`orders.origin`), so a merchant can see them in one list and still tell
 * them apart.
 *
 * WHY NOT THE PLATFORM CHECKOUT. `worker/routes/orders.ts` resolves
 * membership pricing tiers, transport methods, warranty plans, points
 * accrual, support-gift eligibility and Levonis inventory. None of that
 * applies to a merchant's own goods: a merchant sets one price, ships it
 * their own way, and Levonis takes a commission. Threading a second product
 * source through that resolver would make the platform path harder to read in
 * order to serve a path that needs almost none of it. The two share what
 * genuinely is shared — the `orders` table, the wallet, idempotency, the
 * address book — and diverge where they genuinely differ.
 *
 * MONEY. A store sale is not escrowed the way custom work is: the goods
 * exist, and the customer is buying rather than commissioning. The merchant's
 * share — the goods after the coupon, less the platform's commission, PLUS
 * the merchant's own delivery fee — is written to the payout ledger as
 * `pending` when the order is placed. It becomes `available` when the
 * CUSTOMER confirms receipt, or three days after delivery with no open
 * complaint (the owner's rule, worker/lib/storeOrderOps.ts) — never on the
 * merchant's own «تم التسليم».
 *
 * AND IT IS PREPAID. Every order on this path is paid from the customer's
 * wallet before the merchant ships — there is no cash on delivery and no
 * Levonis-warehouse pickup, because Levonis holds neither the merchant's stock
 * nor their cash and has nobody at either end to collect. `payment_method_id`
 * is fixed to `'wallet'` with nothing due on delivery. `delivery_method_id` is
 * the MERCHANT's: `'merchant'` (their own delivery) or `'merchant_pickup'`
 * (collected from the store, when the merchant offers it — W2-A).
 *
 * THE DELIVERY IS PRICED FROM THE CUSTOMER'S SAVED ADDRESS (W2-A,
 * docs/MERCHANT_PLATFORM.md §4.2): address → governorate → the merchant's
 * profile and per-governorate rules (worker/lib/merchantDelivery.ts, the
 * resolver in packages/shipping). At the quote and again at place-order;
 * nothing the client sends is a fee.
 *
 * THE QUOTE AND THE ORDER ARE ONE AGREEMENT (B12). The quote returns a
 * `quote_fingerprint` over everything that costs money; place-order re-prices
 * from the database and refuses `409 QUOTE_CHANGED` — with the fresh quote —
 * unless the fingerprint the customer confirmed is the one it computes now. A
 * merchant raising a price or a delivery fee between the two used to be
 * charged silently.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, str, HttpError } from '../lib/http';
import { newId, sha256Hex } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { feeFor } from '../lib/merchantOps';
import { exchangeRate } from '../lib/escrowOps';
import {
  createPurchaseHold, commitHoldStatements, holdSettledEventStatements, getAvailableBalances,
  readWalletDust, releaseHold, walletIqdAvailable, walletLedgerDinarsReady, walletSpendCents,
} from '../lib/walletOps';
import { rootDomainFrom } from '../lib/hosts';
import { announceAfterResponse, orderAnnouncement, orderTopic } from '../lib/adminTopicRouting';
import { storeById } from '../lib/merchantAuth';
import { storeSaleLedgerStatements, storeSaleReceivable } from '../lib/merchantLedger';
import { CART_SELLER_CONFLICT } from '../lib/cartSeller';
import { LINE_VARIANT_COLUMNS, LINE_VARIANT_JOIN, resolveCatalogLine } from '../lib/catalog/lines';
import { alertLowStock, type StockMove } from '../lib/catalog/lowStock';
import {
  isOwnStore,
  notifyMerchantOfStoreOrder,
  storeOrderPublic,
  storeTakesOrders,
} from '../lib/storeOrderOps';
import {
  checkoutDelivery,
  checkoutWhere,
  deliveryFenceStatement,
  isDeliveryFenceAbort,
  type CheckoutDelivery,
  type CheckoutWhere,
} from '../lib/merchantDelivery';

export const storeOrderRoutes = new Hono<AppContext>();
storeOrderRoutes.use('*', requireAuth);

const nowIso = () => new Date().toISOString();

interface PricedLine {
  cart_item_id: string;
  product_id: string;
  name: string;
  image: string;
  qty: number;
  unit_price_iqd: number;
  line_total_iqd: number;
  option_id: string;
  color_id: string;
  /**
   * The chosen option and colour as the merchant NAMED them, «خيار / لون» —
   * for the admin group's order message only (`merchantVariant`). Empty when
   * nothing was chosen or the id no longer names anything on the product.
   */
  variant: string;
  /**
   * What `order_items.option_snapshot` records: the merchant's own words for
   * a choice VALIDATED against the product (worker/lib/storeOrderOps.ts,
   * `merchantVariantLabel`) — never the text a client posted (B16). For a
   * variant, its values in group order (W2-F).
   */
  option_snapshot: string;
  /** The variant this line buys (W2-F), or null for a product without variants. */
  variant_id: string | null;
  /** The variant's (or product's) SKU, snapshotted on the order line for the merchant. */
  sku: string;
}

/**
 * THE MERCHANT'S OWN WORDS FOR WHAT WAS CHOSEN.
 *
 * `cart_items` stores the option and colour as IDS, and the admin message used
 * to print this line without either («an id in a group message is noise»), so
 * a store sale of «قميص — أحمر» reached the group as «قميص». The product row
 * already carries both lists (`community_products.options` / `.colors`, 0030),
 * so the name is one lookup in memory.
 *
 * DEFENSIVE BY NECESSITY: those two columns are merchant-authored JSON with no
 * schema of their own (merchant.ts stores what the form sends). An entry may be
 * a plain string — the value IS its name — or an object whose id matches and
 * whose display name sits under one of the usual keys. Anything else yields
 * nothing, never an id: the rule the old comment gave still holds.
 */
function namedEntry(listJson: unknown, id: string): string {
  if (!id) return '';
  const list = safeParse<unknown[]>(listJson, []);
  if (!Array.isArray(list)) return '';
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry === id) return entry;
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (String(e.id ?? e.value ?? '') !== id) continue;
    for (const key of ['name_ar', 'name', 'label', 'title', 'value']) {
      const v = e[key];
      if (typeof v === 'string' && v.trim() && v !== id) return v.trim();
    }
    return '';
  }
  return '';
}

export function merchantVariant(optionsJson: unknown, colorsJson: unknown, optionId: string, colorId: string): string {
  return [namedEntry(optionsJson, optionId), namedEntry(colorsJson, colorId)].filter(Boolean).join(' / ');
}

interface PricedCart {
  merchant_id: string;
  store_id: string;
  store_name: string;
  store_slug: string;
  lines: PricedLine[];
  /** Units per product, summed across option/colour lines — what stock is judged against. */
  products: Array<{ product_id: string; qty: number }>;
  /** Units per VARIANT (W2-F): each variant's own stock is fenced like the product's. */
  variants: Array<{ variant_id: string; product_id: string; qty: number }>;
  /** What each stock line stood at when priced, for the low-stock notice after the order. */
  stockMoves: StockMove[];
  /** Merchandise at the store's own prices, before any coupon. */
  subtotal_iqd: number;
  coupon_code: string;
  coupon_id: string | null;
  discount_iqd: number;
  /** What the customer pays for the GOODS: the subtotal after the coupon. */
  merchandise_iqd: number;
  delivery_iqd: number;
  total_iqd: number;
  /**
   * The order's commission snapshot. The platform's fee is taken on the goods
   * only; the merchant receives the rest of the goods AND their whole delivery
   * fee, so fee + receivable = total, to the dinar (B4).
   */
  commission: { commission_percent_x100: number; platform_fee_iqd: number; merchant_receivable_iqd: number };
  quote_fingerprint: string;
  /** How it reaches the customer, priced from their saved address (W2-A, worker/lib/merchantDelivery.ts). */
  delivery: CheckoutDelivery;
}

/**
 * A merchant coupon, validated against THIS store's own codes.
 *
 * Only consulted when the customer actually typed a code: an empty code is a
 * normal cart, never an error. A code that does not apply is a 400 with the
 * reason — a discount silently not applied is worse than a refusal.
 *
 * ITS MINIMUM IS JUDGED ON THE MERCHANDISE AT THE STORE'S OWN PRICES, before
 * this coupon's discount (B22, docs/DECISIONS.md) — a minimum that included
 * the coupon's own discount would be circular, and it is the platform
 * coupon's rule too (worker/routes/orders.ts: the basis is after line
 * discounts, before the coupon).
 */
async function resolveCoupon(
  db: D1Database,
  storeId: string,
  rawCode: string,
  subtotal: number
): Promise<{ id: string; code: string; discount: number } | null> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return null;
  const cp = await db.prepare(
    'SELECT * FROM merchant_coupons WHERE store_id = ? AND code = ?'
  ).bind(storeId, code).first<Record<string, unknown>>();

  const fail = (why: string) => badRequest('This code cannot be used', 'COUPON_INVALID', { reason: why });
  if (!cp || !cp.active) throw fail('unknown_or_inactive');
  const now = Date.now();
  if (cp.starts_at && now < new Date(String(cp.starts_at)).getTime()) throw fail('not_started');
  if (cp.ends_at && now > new Date(String(cp.ends_at)).getTime()) throw fail('expired');
  if (cp.max_uses !== null && Number(cp.used_count) >= Number(cp.max_uses)) throw fail('exhausted');
  if (subtotal < Number(cp.min_total_iqd)) throw fail('below_minimum');

  const discount = cp.kind === 'percent'
    ? Math.floor((subtotal * Number(cp.value)) / 100)
    : Math.min(Number(cp.value), subtotal);
  if (discount <= 0) return null;
  return { id: String(cp.id), code, discount };
}

/** 409 with the machine-readable context the checkout needs to say which line. */
const refuse = (msg: string, code: string, details?: Record<string, unknown>) => new HttpError(409, msg, code, details);

/**
 * Prices the merchant cart from the DATABASE, refusing anything that cannot
 * actually be sold right now.
 *
 * Every number here is read server-side (§17). A client that posts prices,
 * totals or a delivery fee is ignored entirely — those fields are not read.
 *
 * WHAT IT REFUSES, IN ORDER, AND WHY EACH ONE IS HERE:
 *   · a cart spanning two stores (B8): the order is written with ONE seller,
 *     and the first line's seller used to be billed for — and credited with —
 *     the second store's goods;
 *   · the merchant's own store (B17);
 *   · a store that may not sell (B11): paused, suspended, restricted, not
 *     selling products, or an owner without the store entitlement;
 *   · a hidden or moved product, and an option or colour that names nothing
 *     on its product (B16);
 *   · stock judged on the units per PRODUCT, not per line (B5): two colours
 *     of a product with one unit left used to both pass.
 */
async function priceMerchantCart(c: Context<AppContext>, couponCode: string, where: CheckoutWhere): Promise<PricedCart> {
  const user = c.get('user')!;
  const db = c.env.DB;
  const { results } = await db.prepare(
    `SELECT ci.id AS cart_item_id, ci.qty, ci.option_id, ci.color_id,
            ci.merchant_id AS line_merchant_id, ci.store_id AS line_store_id,
            p.id, p.name, p.images, p.price_iqd, p.stock, p.track_stock, p.lifecycle, p.status,
            p.options, p.colors, p.store_id AS product_store_id, p.prep_days, p.sku, ${LINE_VARIANT_COLUMNS}
       FROM cart_items ci
       JOIN community_products p ON p.id = ci.community_product_id
       ${LINE_VARIANT_JOIN}
      WHERE ci.user_id = ? AND ci.seller_type = 'merchant'
      ORDER BY ci.created_at, ci.id`
  ).bind(user.id).all<Record<string, unknown>>();

  if (!results.length) throw badRequest('Your cart is empty', 'CART_EMPTY');

  const merchants = new Set(results.map((r) => String(r.line_merchant_id ?? '')));
  const stores = new Set(results.map((r) => String(r.line_store_id ?? '')));
  if (merchants.size !== 1 || stores.size !== 1) {
    throw refuse('Your cart holds items from more than one store. Keep one store’s items to check out.', CART_SELLER_CONFLICT, {
      stores: stores.size,
    });
  }
  const storeId = [...stores][0];

  const ctx = await storeById(db, storeId);
  if (!ctx || ctx.merchant.id !== [...merchants][0]) {
    throw refuse('This store is not taking orders right now', 'STORE_CLOSED');
  }
  if (isOwnStore(ctx, user.id)) {
    throw new HttpError(403, 'A store cannot buy from itself', 'OWN_STORE_PURCHASE');
  }
  // Each refusal names only what a shopper needs to know. "This store is not
  // taking orders" is true whether the merchant paused it, an admin
  // suspended it, or their subscription lapsed — a customer has no business
  // being told which, and a probe learns nothing about another account.
  const verdict = await storeTakesOrders(db, ctx);
  if (!verdict.ok) throw refuse('This store is not taking orders right now', 'STORE_CLOSED');

  const lines: PricedLine[] = [];
  const perProduct = new Map<string, { qty: number; stock: number; tracked: boolean; name: string; threshold: number | null }>();
  const perVariant = new Map<
    string,
    { product_id: string; qty: number; stock: number; tracked: boolean; name: string; label: string; threshold: number | null }
  >();
  let subtotal = 0;
  let productPrepDays = 0;
  for (const r of results) {
    const productId = String(r.id);
    productPrepDays = Math.max(productPrepDays, Math.trunc(Number(r.prep_days) || 0));
    // Availability is re-checked at checkout, not trusted from when the item
    // was added. A product hidden, archived or moved in between must stop
    // the order rather than create one the merchant cannot fulfil.
    if (r.lifecycle !== 'active' || r.status !== 'active' || String(r.product_store_id ?? '') !== storeId) {
      throw refuse(`"${r.name}" is no longer available`, 'PRODUCT_UNAVAILABLE', { product_id: productId });
    }
    const optionId = String(r.option_id ?? '');
    const colorId = String(r.color_id ?? '');
    // THE SERVER PRICES THE CHOSEN VARIANT (W2-F, worker/lib/catalog/lines.ts):
    // its override or the product's price, from the database; a variant that
    // is gone or inactive, or none on a product that has variants, stops here.
    const variant = resolveCatalogLine(r);
    if (!variant.ok) {
      throw refuse(`The option chosen for "${r.name}" is no longer offered`, 'OPTION_UNAVAILABLE', {
        product_id: productId,
        which: variant.which ?? 'option',
      });
    }
    const qty = Math.max(1, Math.trunc(Number(r.qty) || 1));
    const unit = variant.unit;
    // A line at 0 IQD is not sold (owner decision 2026-09-25): commission is
    // on the goods, so a free product with a delivery fee was a sale with no
    // commission. A product left at 0 from before the rule is unpurchasable.
    if (!(unit > 0)) {
      throw refuse(`"${r.name}" has no price and cannot be bought right now`, 'PRODUCT_PRICE_REQUIRED', { product_id: productId });
    }
    if (variant.variantId) {
      const vagg = perVariant.get(variant.variantId) ?? {
        product_id: productId, qty: 0, stock: variant.stock, tracked: !!Number(r.track_stock),
        name: String(r.name), label: variant.label, threshold: variant.threshold,
      };
      vagg.qty += qty;
      perVariant.set(variant.variantId, vagg);
    }
    const line = unit * qty;
    subtotal += line;
    const agg = perProduct.get(productId) ?? {
      qty: 0, stock: Number(r.stock) || 0, tracked: !!Number(r.track_stock), name: String(r.name),
      threshold: r.p_threshold === null || r.p_threshold === undefined ? null : Number(r.p_threshold),
    };
    agg.qty += qty;
    perProduct.set(productId, agg);
    lines.push({
      cart_item_id: String(r.cart_item_id),
      product_id: productId,
      name: String(r.name),
      image: (safeParse<string[]>(r.images, [])[0] ?? ''),
      qty,
      unit_price_iqd: unit,
      line_total_iqd: line,
      option_id: optionId,
      color_id: colorId,
      variant: variant.variantId ? variant.label : merchantVariant(r.options, r.colors, optionId, colorId),
      option_snapshot: variant.label,
      variant_id: variant.variantId,
      sku: variant.sku,
    });
  }
  for (const [variantId, agg] of perVariant) {
    if (agg.tracked && agg.stock < agg.qty) {
      throw refuse('There is not enough stock for this order', 'OUT_OF_STOCK', {
        product_id: agg.product_id,
        variant_id: variantId,
        available: Math.max(0, agg.stock),
      });
    }
  }
  for (const [productId, agg] of perProduct) {
    if (agg.tracked && agg.stock < agg.qty) {
      throw refuse('There is not enough stock for this order', 'OUT_OF_STOCK', {
        product_id: productId,
        available: Math.max(0, agg.stock),
      });
    }
  }

  const coupon = await resolveCoupon(db, storeId, couponCode, subtotal);
  const discount = coupon?.discount ?? 0;
  const merchandise = subtotal - discount;

  // THE MERCHANT'S OWN DELIVERY, PRICED FROM THE CUSTOMER'S SAVED ADDRESS
  // (W2-A, docs/MERCHANT_PLATFORM.md §4.2): address → governorate → the
  // merchant's rules (packages/shipping/src/merchantDelivery.ts). Nothing the
  // client sends is a fee. The free-over threshold is judged on what the
  // customer pays for the GOODS, after the coupon (B22). An address with no
  // governorate, a governorate the store does not serve, or no address at all
  // is a 409 carrying the cart's summary — so the page can keep showing what
  // is being bought while it asks for a different address.
  const resolved = await checkoutDelivery(db, ctx.store, where, merchandise, productPrepDays);
  if (!resolved.ok) {
    throw refuse(resolved.message, resolved.code, {
      ...resolved.details,
      preview: {
        store_id: storeId,
        store_name: ctx.store.name,
        store_slug: ctx.store.slug,
        lines: lines.map(publicLine),
        subtotal_iqd: subtotal,
        coupon_code: coupon?.code ?? '',
        discount_iqd: discount,
      },
    });
  }
  const delivery = resolved.resolution.fee_iqd;

  const total = merchandise + delivery;
  // Commission on the goods only — never on delivery, which is the merchant's
  // own cost of shipping and is credited to them whole (B4).
  const split = await feeFor(db, 'store', merchandise);
  const commission = {
    commission_percent_x100: split.commission_percent_x100,
    platform_fee_iqd: split.platform_fee_iqd,
    merchant_receivable_iqd: split.merchant_receivable_iqd + delivery,
  };

  const fingerprint = (
    await sha256Hex(
      JSON.stringify({
        // v2 (W2-A): the delivery half names the fulfilment, the address, its
        // governorate, the rule that priced it, the fee and the merchant's
        // profile version — an edit to any of them is a new agreement.
        v: 2,
        store: storeId,
        lines: lines.map((l) => [l.cart_item_id, l.product_id, l.qty, l.unit_price_iqd, l.option_id, l.color_id]),
        subtotal,
        coupon: coupon?.code ?? '',
        discount,
        delivery: resolved.fingerprint,
        total,
      })
    )
  ).slice(0, 40);

  return {
    merchant_id: ctx.merchant.id,
    store_id: storeId,
    store_name: ctx.store.name,
    store_slug: ctx.store.slug,
    lines,
    products: [...perProduct].map(([product_id, agg]) => ({ product_id, qty: agg.qty })),
    variants: [...perVariant].map(([variant_id, agg]) => ({ variant_id, product_id: agg.product_id, qty: agg.qty })),
    stockMoves: [
      ...[...perVariant.values()].map((a) => ({
        productId: a.product_id, productName: a.name, variantLabel: a.label, before: a.stock, after: a.stock - a.qty, threshold: a.threshold,
      })),
      ...[...perProduct]
        .filter(([pid]) => ![...perVariant.values()].some((v) => v.product_id === pid))
        .map(([productId, a]) => ({ productId, productName: a.name, before: a.stock, after: a.stock - a.qty, threshold: a.threshold })),
    ].filter((m) => m.threshold !== null),
    subtotal_iqd: subtotal,
    coupon_code: coupon?.code ?? '',
    coupon_id: coupon?.id ?? null,
    discount_iqd: discount,
    merchandise_iqd: merchandise,
    delivery_iqd: delivery,
    total_iqd: total,
    commission,
    quote_fingerprint: fingerprint,
    delivery: resolved,
  };
}

/** A priced line as the customer's quote shows it. */
function publicLine(l: PricedLine) {
  return {
    cart_item_id: l.cart_item_id,
    product_id: l.product_id,
    name: l.name,
    image: l.image,
    qty: l.qty,
    unit_price_iqd: l.unit_price_iqd,
    line_total_iqd: l.line_total_iqd,
    variant: l.option_snapshot,
  };
}

/**
 * The quote as the CUSTOMER sees it (B18): prices, delivery, the coupon, the
 * wallet's answer and the fingerprint to confirm — and nothing of the
 * commission, which is the merchant's and the platform's business.
 */
async function publicQuote(c: Context<AppContext>, cart: PricedCart, checkoutKey = '') {
  const user = c.get('user')!;
  // PREPAID ONLY. On this path the wallet is not one payment method among
  // several — it is the only one — so whether it covers this total decides
  // whether the order can be placed at all. That has to be on the screen
  // BEFORE the button: a customer who finds out at the last tap has already
  // chosen an address and typed a coupon for an order they cannot place.
  //
  // THE COMPARISON IS DONE IN DINARS, which is the unit both sides are quoted
  // in — «يضاف كما هو ولكن يحول الى الدولار وليس العكس», migration 0108.
  //
  // It used to be done in CENTS through `iqdToUsdCents`, which CEILS, and that
  // is the platform checkout's refusal wearing a different coat: a wallet the
  // wallet page prints as exactly 50,000 د.ع holds 3,571 cents, a 50,000 د.ع
  // cart asked for ceil(5,000,000 / 1,400) = 3,572, and `wallet_covers` came
  // back false one cent short — beside a `wallet_available_iqd` of 49,994 that
  // contradicted the wallet page by six dinars. Both figures now come from
  // `walletIqdAvailable`, the one function that turns a balance into dinars,
  // so this screen and the wallet screen cannot disagree at all.
  const [rate, balances, dust, ownHoldCents] = await Promise.all([
    exchangeRate(c.env.DB),
    getAvailableBalances(c.env, user.id),
    readWalletDust(c.env.DB, user.id),
    // The checkout's own attempt key, when the page sends it: a reservation
    // that attempt left behind is money this very order can still use
    // (review F6), so it must not read as "your wallet does not cover this".
    activeCheckoutHoldCents(c.env.DB, user.id, checkoutKey),
  ]);
  const walletAvailableIqd = walletIqdAvailable(balances.usd_cents_available + ownHoldCents, dust.dust_iqd, rate);
  return {
    store_id: cart.store_id,
    store_name: cart.store_name,
    store_slug: cart.store_slug,
    lines: cart.lines.map(publicLine),
    subtotal_iqd: cart.subtotal_iqd,
    coupon_code: cart.coupon_code,
    discount_iqd: cart.discount_iqd,
    delivery_iqd: cart.delivery_iqd,
    /** The delivery breakdown (W2-A): how, where, which rule, the fee, preparation — never a figure the client sent. */
    delivery: cart.delivery.public,
    total_iqd: cart.total_iqd,
    /** What place-order charges if nothing moves — the figure the button shows. */
    expected_total_iqd: cart.total_iqd,
    /** Send this back to place the order; it names every figure above. */
    quote_fingerprint: cart.quote_fingerprint,
    payment_method: 'wallet' as const,
    /** Spendable only — money already held for another order is not it. */
    wallet_available_iqd: walletAvailableIqd,
    wallet_covers: cart.total_iqd <= walletAvailableIqd,
    wallet_shortfall_iqd: Math.max(0, cart.total_iqd - walletAvailableIqd),
    /**
     * Where to top up, as an ABSOLUTE url.
     *
     * A merchant subdomain serves the storefront app, which routes the
     * cart, the checkout and the order history but deliberately not the
     * wallet (§94) — so a relative `/wallet` from `ali3d.levonis-iq.com`
     * lands on the shop's catch-all instead of the wallet, which is the
     * one screen a customer who cannot pay actually needs. Only the server
     * knows the root domain, so it is the server that answers.
     */
    wallet_topup_url: (() => {
      const root = rootDomainFrom(c.env);
      return root ? `https://${root}/wallet` : '/wallet';
    })(),
  };
}

/** What the order will cost, before committing to it. */
storeOrderRoutes.post('/quote', async (c) => {
  // Re-quoted on return and polled while the checkout is open (StoreCheckout
  // .tsx) — generous, but no longer unbounded.
  await rateLimit(c, 'store-quote', 120, 300);
  const body = await c.req.json().catch(() => ({}));
  // `{addressId, fulfilment: delivery|pickup, couponCode?}` — the address is
  // read as the customer's own; without one the quote prices their default
  // address (worker/lib/merchantDelivery.ts `checkoutWhere`).
  const where = await checkoutWhere(c.env.DB, c.get('user')!.id, body, 'quote');
  const cart = await priceMerchantCart(c, typeof body.couponCode === 'string' ? body.couponCode : '', where);
  // Optional: the attempt key the checkout will place with (review F6). Only
  // a well-formed key is read — anything else is simply no key.
  const key = typeof body.idempotencyKey === 'string' && /^[\w:.-]{8,80}$/.test(body.idempotencyKey)
    ? body.idempotencyKey
    : '';
  return c.json({ success: true, quote: await publicQuote(c, cart, key) });
});

/** The event key of the wallet hold one checkout attempt places — server-minted from the user and their key. */
const checkoutHoldKey = (userId: string, idempotencyKey: string) => `store-order:${userId}:${idempotencyKey}`;

/**
 * The cents this checkout key's OWN hold still reserves: an active purchase
 * hold not yet settled into an order (review F6). Zero when there is none.
 */
async function activeCheckoutHoldCents(db: D1Database, userId: string, idempotencyKey: string): Promise<number> {
  if (!idempotencyKey) return 0;
  const row = await db
    .prepare(
      `SELECT amount_cents FROM wallet_holds
        WHERE user_id = ? AND kind = 'purchase' AND event_key = ? AND state = 'active' AND tx_id IS NULL`
    )
    .bind(userId, checkoutHoldKey(userId, idempotencyKey))
    .first<{ amount_cents: number }>();
  return Math.max(0, Number(row?.amount_cents) || 0);
}

/** The customer's own order, as they may see it — for a replay of a placed order. */
async function placedOrder(c: Context<AppContext>, idempotencyKey: string) {
  const user = c.get('user')!;
  return c.env.DB.prepare(
    'SELECT * FROM orders WHERE user_id = ?1 AND (client_idempotency_key = ?2 OR idempotency_key = ?2)'
  ).bind(user.id, idempotencyKey).first<Record<string, unknown>>();
}

/**
 * After a fence aborted the batch: which product ran out, read from the rows
 * as they are NOW. A product hidden in between says so; one that is merely
 * short names the units left, which the checkout shows as a number.
 */
async function stockRefusal(db: D1Database, cart: PricedCart): Promise<HttpError> {
  for (const need of cart.products) {
    const p = await db.prepare(
      'SELECT stock, track_stock, lifecycle, status, store_id FROM community_products WHERE id = ?'
    ).bind(need.product_id).first<{ stock: number; track_stock: number; lifecycle: string; status: string; store_id: string }>();
    if (!p || p.lifecycle !== 'active' || p.status !== 'active' || p.store_id !== cart.store_id) {
      return refuse('A product in your cart is no longer available', 'PRODUCT_UNAVAILABLE', { product_id: need.product_id });
    }
    if (Number(p.track_stock) && Number(p.stock) < need.qty) {
      return refuse('There is not enough stock for this order', 'OUT_OF_STOCK', {
        product_id: need.product_id,
        available: Math.max(0, Number(p.stock) || 0),
      });
    }
  }
  for (const need of cart.variants) {
    const v = await db.prepare(
      `SELECT v.stock, v.active, p.track_stock FROM community_product_variants v
         JOIN community_products p ON p.id = v.product_id WHERE v.id = ? AND v.product_id = ?`
    ).bind(need.variant_id, need.product_id).first<{ stock: number; active: number; track_stock: number }>();
    if (!v || Number(v.active) !== 1) {
      return refuse('An option in your cart is no longer offered', 'OPTION_UNAVAILABLE', { product_id: need.product_id, which: 'option' });
    }
    if (Number(v.track_stock) && Number(v.stock) < need.qty) {
      return refuse('There is not enough stock for this order', 'OUT_OF_STOCK', {
        product_id: need.product_id,
        variant_id: need.variant_id,
        available: Math.max(0, Number(v.stock) || 0),
      });
    }
  }
  // Nothing is short any more — another order was cancelled in between. The
  // honest answer is still "try again", and the checkout re-quotes.
  return refuse('The stock changed while you were checking out — please try again', 'OUT_OF_STOCK');
}

/**
 * A placed order answered to its own key: the order when the request names
 * the fingerprint it was placed with (or none, or the order predates
 * fingerprints), a spent key when it names ANOTHER agreement (W2-A — the key
 * is bound to what was agreed). Only the customer's own order is ever read.
 */
function replayOrKeyReused(c: Context<AppContext>, order: Record<string, unknown>, confirmed: string) {
  const bound = typeof order.quote_fingerprint === 'string' && order.quote_fingerprint ? order.quote_fingerprint : '';
  if (bound && confirmed && bound !== confirmed) {
    throw refuse('This checkout key was already used for another order. Start the checkout again.', 'IDEMPOTENCY_KEY_REUSED');
  }
  return c.json({ success: true, order: storeOrderPublic(order), replay: true });
}

/**
 * The merchant's delivery moved between the price check and the commit (the
 * batch's delivery fence aborted): the same answer an earlier edit gets — the
 * fresh quote to confirm — or the delivery refusal when the governorate is no
 * longer served at all.
 */
async function deliveryMovedRefusal(c: Context<AppContext>, couponCode: string, where: CheckoutWhere): Promise<HttpError> {
  try {
    const fresh = await priceMerchantCart(c, couponCode, where);
    return refuse('The delivery changed since you saw it. Review the new total and confirm again.', 'QUOTE_CHANGED', {
      quote: await publicQuote(c, fresh),
    });
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
}

/**
 * Place the order.
 *
 * Idempotent on a client-supplied key, like the platform checkout: a double
 * tap or a network retry must not produce two orders, two stock decrements
 * and two payouts.
 */
storeOrderRoutes.post('/', async (c) => {
  await rateLimit(c, 'store-checkout', 15, 300);
  const user = c.get('user')!;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });
  const confirmed = typeof body.quoteFingerprint === 'string' ? body.quoteFingerprint : '';

  // Per user, both columns (0064): `client_idempotency_key` is where this
  // route now stores the key and is unique per user; `idempotency_key` is the
  // legacy globally-unique column, still holding keys written before the
  // migration, so a retry in flight across the deploy still replays.
  //
  // A REPLAY IS THE SAME AGREEMENT (W2-A). It is answered from the order as it
  // was placed — later edits to prices or delivery change nothing about it —
  // but only for the fingerprint it was placed with: the same key sent with a
  // different agreement is a spent key, never that order returned as if it
  // were the new one. Orders placed before 0120 carry no fingerprint and
  // replay as they always did.
  const replay = await placedOrder(c, idempotencyKey);
  if (replay) return replayOrKeyReused(c, replay, confirmed);

  // The customer's OWN saved address, and how they want the goods: never a
  // governorate or a fee from the body (worker/lib/merchantDelivery.ts).
  const where = await checkoutWhere(db, user.id, body, 'place');
  const address = where.address!;

  // PREPAID ONLY — the rule for every merchant sale in Levo community.
  //
  // A merchant's goods are shipped by the merchant, and Levonis holds neither
  // the stock nor the cash: there is no driver of ours to collect at the door
  // and no counter of ours to collect from, so cash on delivery and pickup
  // from a Levonis warehouse are not options that happen to be turned off —
  // they do not exist on this path. Delivery is the merchant's own (their
  // delivery, or collection from their store — `delivery_method_id`, below),
  // and payment is the wallet, even for a pickup.
  //
  // This route USED TO accept `payWithWallet: false` and write the order as
  // `cod` with the full total due on delivery, which is the order nobody
  // could collect. A client that still offers the choice is now refused IN
  // WORDS rather than having its customer's wallet silently debited for a
  // method they did not pick.
  if (body.payWithWallet === false) {
    throw badRequest(
      'Orders from a community store are paid from your wallet before the store ships them',
      'STORE_PREPAID_ONLY'
    );
  }
  const cart = await priceMerchantCart(c, typeof body.couponCode === 'string' ? body.couponCode : '', where);

  // THE CUSTOMER AGREED TO A QUOTE, NOT TO WHATEVER THE DATABASE SAYS NOW.
  // No fingerprint is no agreement: an old client that never asked for one
  // is answered exactly like a stale one — here is the quote, confirm it.
  // The fingerprint names the address, its governorate, the delivery rule, the
  // fee and the merchant's profile version (W2-A): a changed address, or a
  // merchant editing their delivery mid-checkout, is a new agreement.
  if (confirmed !== cart.quote_fingerprint) {
    throw refuse('The price changed since you saw it. Review the new total and confirm again.', 'QUOTE_CHANGED', {
      quote: await publicQuote(c, cart),
    });
  }

  const rate = await exchangeRate(db);

  /**
   * Wallet payment is reserved and committed in the same request. A hold
   * rather than a bare debit, so an insufficient balance writes nothing at
   * all instead of a half-paid order.
   *
   * THE AMOUNT IS THE CART'S DINARS, CONVERTED DOWN — the same
   * `walletSpendCents` the platform checkout and the membership purchase use,
   * and for the same reason: `iqdToUsdCents` ceils, and the extra cent it asks
   * for is one the wallet that funded the cart does not hold. The refusal that
   * produced was «Your wallet balance does not cover this order» for a wallet
   * the quote above had just said covered it.
   *
   * THE GUARD IS STILL THE HOLD'S OWN. `walletSpendCents` caps at the cents
   * read a moment ago, so the affordability question is answered HERE, in
   * dinars, against the figure the customer was shown. That makes the cap a
   * read-then-write, which is why the hold's `WHERE available >= amount` stays
   * exactly as it was: a balance that moved in between still refuses the hold
   * and still writes nothing.
   */
  const walletDust = await readWalletDust(db, user.id);
  const walletBalances = await getAvailableBalances(c.env, user.id);
  /**
   * A RETRY WITH THE SAME KEY PAYS WITH ITS OWN RESERVATION (review F6).
   *
   * The hold this key placed survives a transient batch failure on purpose, so
   * the retry reuses it rather than reserving twice. But the balance read
   * above has that very hold SUBTRACTED — and on a wallet that holds exactly
   * the order, the retry was refused INSUFFICIENT_FUNDS by the reservation it
   * came to use, the money locked until the orphan sweep. The key's own
   * active, unsettled hold is added back before the question is asked, as
   * `reserveEscrowFunds` does for an acceptance; `createPurchaseHold` then
   * replays it (same key, same cents) and the debit's guard adds it back too.
   */
  const ownHoldCents = await activeCheckoutHoldCents(db, user.id, idempotencyKey);
  const spendableCents = walletBalances.usd_cents_available + ownHoldCents;
  const walletBalanceIqd = walletIqdAvailable(spendableCents, walletDust.dust_iqd, rate);
  if (cart.total_iqd > walletBalanceIqd) {
    throw badRequest('Your wallet balance does not cover this order', 'INSUFFICIENT_FUNDS', {
      required_iqd: cart.total_iqd,
      wallet_available_iqd: walletBalanceIqd,
    });
  }
  /**
   * A PRICE BELOW ONE CENT'S WORTH STILL HAS TO MOVE MONEY.
   *
   * `walletSpendCents` floors, so a charge under 14 د.ع (at 1,400) converts to
   * zero cents — and `CHECK (amount > 0)` on `wallet_transactions` means a
   * zero-cent debit cannot be written at all. On the platform checkout that is
   * answered by the wallet paying nothing and the customer owing the few
   * dinars at the door. HERE THERE IS NO DOOR: a community store order is
   * prepaid from the wallet and by nothing else, so "no ledger row" would
   * mean "shipped free". The charge is therefore raised to one cent, which the balance
   * check above guarantees is there (a positive dinar balance needs at least
   * one cent behind it). The customer pays at most one cent — 13 د.ع — more
   * than the quoted dinars, once, on a price smaller than that.
   */
  const walletCents = Math.max(1, walletSpendCents(cart.total_iqd, spendableCents, rate));
  const hold = await createPurchaseHold(db, {
    userId: user.id,
    amountCents: walletCents,
    // SERVER-MINTED, never the client's key. `wallet_holds.event_key` is
    // global, so a key another account had already spent would refuse this
    // buyer's hold — the same cross-user denial 0064 closes on `orders`.
    // The hold is created before the order id exists, so the key is the
    // user plus their key, which is exactly the pair 0064 makes unique.
    eventKey: checkoutHoldKey(user.id, idempotencyKey),
    refType: 'store_order',
    refId: `${user.id}:${idempotencyKey}`,
    note: `Order from ${cart.store_name}`,
  });
  if (!hold.ok) {
    if (hold.reason === 'INSUFFICIENT_AVAILABLE') {
      throw badRequest('Your wallet balance does not cover this order', 'INSUFFICIENT_FUNDS', {
        required_iqd: cart.total_iqd,
      });
    }
    // THE SAME CHECKOUT KEY, A DIFFERENT AMOUNT — or a key whose hold was
    // already settled or handed back by the orphan sweep. Either way this key
    // is spent: say so in the code the checkout already knows how to recover
    // from (it mints a new key and asks again), never as a bare wallet error.
    if (hold.reason === 'EVENT_KEY_REUSED' || hold.reason === 'DUPLICATE_EVENT') {
      throw refuse('This checkout key was already used. Start the checkout again.', 'IDEMPOTENCY_KEY_REUSED');
    }
    throw badRequest('Could not reserve the payment', 'WALLET_ERROR', { reason: hold.reason });
  }
  const holdId = hold.holdId;

  const orderId = `ORD-${newId().slice(0, 10).toUpperCase()}`;
  const ts = nowIso();

  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO orders
         (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
          payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd,
          due_on_delivery_iqd, wallet_applied_iqd, wallet_applied_usd_cents,
          client_idempotency_key, created_at, updated_at,
          seller_type, merchant_id, store_id, origin,
          commission_percent_x100, platform_fee_iqd, merchant_receivable_iqd,
          stage, stage_changed_at, coupon_code, coupon_discount_iqd,
          delivery_governorate, delivery_rule, delivery_prep_days, quote_fingerprint)
       VALUES (?,?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'merchant', ?, ?, 'store_product', ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orderId, user.id, JSON.stringify(address),
      // The merchant's own delivery, or collection from the store — and the
      // WHOLE applied rule with the profile version it came from, so a later
      // edit never rewrites what this order was charged under (W2-A).
      cart.delivery.method_id,
      JSON.stringify({ by: 'merchant', store: cart.store_name, ...cart.delivery.snapshot }),
      // Always 'wallet', and nothing is ever due at the door: see the
      // prepaid-only rule above.
      'wallet',
      cart.subtotal_iqd, cart.delivery_iqd, rate, cart.total_iqd,
      0,
      cart.total_iqd, walletCents,
      idempotencyKey, ts, ts,
      cart.merchant_id, cart.store_id,
      cart.commission.commission_percent_x100, cart.commission.platform_fee_iqd,
      cart.commission.merchant_receivable_iqd,
      ts, cart.coupon_code, cart.discount_iqd,
      cart.delivery.resolution.governorate, cart.delivery.resolution.rule, cart.delivery.prep_days, cart.quote_fingerprint
    ),
  ];
  // The merchant's delivery profile must still be the version this order was
  // priced at when the batch commits (worker/lib/merchantDelivery.ts).
  if (cart.delivery.fence_version !== null) {
    stmts.push(deliveryFenceStatement(db, orderId, cart.store_id, cart.delivery.fence_version));
  }

  /**
   * THE FENCES ABORT THE ORDER — they used to be no-ops (B5, B6).
   *
   * The stock decrement carried `WHERE stock >= qty` and the coupon counter
   * `WHERE used_count < max_uses`, and both simply matched zero rows when a
   * concurrent order had taken the last unit or the last use — while the
   * order, its discount and its payment committed anyway. Each fence below
   * writes NULL into a NOT NULL column of THIS order's row unless its
   * condition holds, which aborts the whole batch: the order, the debit, the
   * credit, everything. They run BEFORE the decrements, against the rows as
   * they stand inside this transaction, and a missing product aborts too.
   *   · stock / availability → `orders.status`           → 409 OUT_OF_STOCK
   *   · the coupon's cap     → `orders.coupon_code`      → 409 COUPON_EXHAUSTED
   *   · the priced lines     → `orders.address_snapshot` → 409 CART_CHANGED
   *
   * THE CART ITSELF IS FENCED TOO (review F7). Two checkout tabs on one cart,
   * each with its own key, both priced the same lines and both committed —
   * two debits for one cart, the second order paying for lines the first had
   * already taken. Every line this order priced must still be in the cart,
   * inside this transaction, or nothing is written.
   */
  stmts.push(
    db.prepare(
      `UPDATE orders
          SET address_snapshot = CASE WHEN (
                SELECT COUNT(*) FROM cart_items ci
                 WHERE ci.user_id = ?2 AND ci.seller_type = 'merchant'
                   AND ci.id IN (SELECT value FROM json_each(?3))
              ) = ?4 THEN address_snapshot ELSE NULL END
        WHERE id = ?1`
    ).bind(orderId, user.id, JSON.stringify(cart.lines.map((l) => l.cart_item_id)), cart.lines.length)
  );
  for (const need of cart.products) {
    stmts.push(
      db.prepare(
        `UPDATE orders
            SET status = CASE WHEN EXISTS (
                  SELECT 1 FROM community_products p
                   WHERE p.id = ?2 AND p.store_id = ?3 AND p.lifecycle = 'active' AND p.status = 'active'
                     AND (p.track_stock = 0 OR p.stock >= ?4)
                ) THEN status ELSE NULL END
          WHERE id = ?1`
      ).bind(orderId, need.product_id, cart.store_id, need.qty)
    );
  }
  // THE VARIANT'S OWN STOCK IS FENCED THE SAME WAY (W2-F): the chosen variant
  // is still this product's, still active, and holds the units — or NULL into
  // `orders.status` aborts the whole batch (409 OUT_OF_STOCK, re-read below).
  for (const need of cart.variants) {
    stmts.push(
      db.prepare(
        `UPDATE orders
            SET status = CASE WHEN EXISTS (
                  SELECT 1 FROM community_product_variants v JOIN community_products p ON p.id = v.product_id
                   WHERE v.id = ?2 AND v.product_id = ?3 AND v.active = 1 AND (p.track_stock = 0 OR v.stock >= ?4)
                ) THEN status ELSE NULL END
          WHERE id = ?1`
      ).bind(orderId, need.variant_id, need.product_id, need.qty)
    );
  }
  if (cart.coupon_id) {
    stmts.push(
      db.prepare(
        `UPDATE orders
            SET coupon_code = CASE WHEN EXISTS (
                  SELECT 1 FROM merchant_coupons k
                   WHERE k.id = ?2 AND k.store_id = ?3 AND k.active = 1
                     AND (k.max_uses IS NULL OR k.used_count < k.max_uses)
                ) THEN coupon_code ELSE NULL END
          WHERE id = ?1`
      ).bind(orderId, cart.coupon_id, cart.store_id),
      db.prepare(
        'UPDATE merchant_coupons SET used_count = used_count + 1, updated_at = ?2 WHERE id = ?1'
      ).bind(cart.coupon_id, ts)
    );
  }

  for (const l of cart.lines) {
    stmts.push(
      db.prepare(
        `INSERT INTO order_items
           (id, order_id, product_id, community_product_id, seller_type, name_snapshot, image_snapshot,
            option_snapshot, qty, unit_price_iqd, line_total_iqd, variant_id, sku_snapshot)
         VALUES (?,?,NULL,?, 'merchant', ?,?,?,?,?,?,?,?)`
      ).bind(
        newId('oi'), orderId, l.product_id, l.name, l.image,
        l.option_snapshot,
        l.qty, l.unit_price_iqd, l.line_total_iqd, l.variant_id, l.sku
      )
    );
  }
  // Per PRODUCT, after the fences: the units the fences just proved are there.
  for (const need of cart.products) {
    stmts.push(
      db.prepare(
        `UPDATE community_products
            SET stock = stock - ?1, sold_count = sold_count + ?1, updated_at = ?2
          WHERE id = ?3`
      ).bind(need.qty, ts, need.product_id)
    );
  }
  // And each variant's units (W2-F) — a variant product's own `stock` is the
  // sum of its variants, which 0126's trigger keeps true after both writes.
  for (const need of cart.variants) {
    stmts.push(
      db.prepare(
        `UPDATE community_product_variants SET stock = stock - ?1, updated_at = ?2 WHERE id = ?3 AND product_id = ?4`
      ).bind(need.qty, ts, need.variant_id, need.product_id)
    );
  }

  // The merchant's share as the MERCHANT LEDGER's own lines (worker/lib/
  // merchantLedger.ts, stream W2-B): the goods, the platform's commission as
  // its own line, and the merchant's delivery fee as its own line — all
  // PENDING until the customer confirms receipt or three days pass after
  // delivery (worker/lib/storeOrderOps.ts). Keys are `sale:<order>:<part>`,
  // server-minted. The three lines add up to the receivable snapshotted on the
  // order, or this is a programming error and nothing is written.
  {
    const sale = {
      goodsIqd: cart.merchandise_iqd,
      commissionIqd: cart.commission.platform_fee_iqd,
      deliveryIqd: cart.delivery_iqd,
    };
    if (storeSaleReceivable(sale) !== cart.commission.merchant_receivable_iqd) {
      throw new Error(`store order ${orderId}: the ledger lines do not add up to the receivable`);
    }
    stmts.push(
      ...storeSaleLedgerStatements(db, { orderId, merchantId: cart.merchant_id, storeId: cart.store_id, ...sale, ts })
    );
  }
  // ONLY THE LINES THIS ORDER PRICED, at the quantity it priced them (B21).
  // Checkout used to empty the whole cart — a Levonis line it never priced
  // included — and a quantity raised in another tab after the quote vanished
  // with the line. A line that changed stays in the cart, visibly.
  stmts.push(
    db.prepare(
      `DELETE FROM cart_items
        WHERE user_id = ?1 AND seller_type = 'merchant'
          AND EXISTS (SELECT 1 FROM json_each(?2) j
                       WHERE json_extract(j.value, '$.id') = cart_items.id
                         AND json_extract(j.value, '$.qty') = cart_items.qty)`
    ).bind(user.id, JSON.stringify(cart.lines.map((l) => ({ id: l.cart_item_id, qty: l.qty }))))
  );

  // §11.1 settlement rule: the hold commits AND its ledger debit posts inside
  // THIS batch, with the order and the merchant's pending share. Committing
  // the hold in a call of its own — the way this route first did — flipped
  // the state and posted nothing, which handed the reserved money back to the
  // buyer's spendable balance while the merchant was credited for the sale.
  // The debit's guard aborts the whole batch if the hold is not an active,
  // still-funded reservation, so no order can exist unpaid.
  //
  // AND IT RECORDS THE DINARS IT SPENT (0108, B24), exactly as the platform
  // checkout's debit does: the pair is what cancels the deposit remainders
  // that funded it, so a wallet spent down on a store order reads what it
  // should, and a cancellation's refund copies the same dinars back.
  const dinars = Number.isInteger(rate) && (await walletLedgerDinarsReady(db))
    ? { amountIqd: cart.total_iqd, exchangeRateSnapshot: rate }
    : {};
  stmts.push(
    ...commitHoldStatements(db, {
      holdId,
      note: `Wallet payment on order ${orderId}`,
      ref: orderId,
      ...dinars,
    }),
    // The settlement event (§3.9) rides in the SAME batch as the debit,
    // guarded by it: this is the path that actually settles a store order,
    // so publishing afterwards would lose the event to any crash in between.
    // Nothing at all while the bus is off.
    ...(await holdSettledEventStatements(db, holdId))
  );

  // The hold taken above deliberately SURVIVES a TRANSIENT failed batch: the
  // key is deterministic per user and checkout key, so the buyer's retry reuses
  // that same reservation instead of taking a second one out of their balance
  // (tests/walletHoldSettlement.test.ts pins it). This catch therefore does not
  // release it — the orphan sweep does, if no retry ever comes
  // (worker/lib/storeOrderOps.ts `releaseOrphanStoreHolds`). A stock, coupon
  // or cart REFUSAL is not transient, and is handed back below.
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The same-user retry: their own order already exists, so replay it
    // rather than reporting a failure for work that succeeded.
    if (msg.includes('UNIQUE') && (msg.includes('orders.idempotency_key') || msg.includes('orders.client_idempotency_key'))) {
      const again = await placedOrder(c, idempotencyKey);
      if (again) return replayOrKeyReused(c, again, confirmed);
      throw refuse('This checkout key was already used. Start the checkout again.', 'IDEMPOTENCY_KEY_REUSED');
    }
    // A REFUSAL THE DATABASE DECIDED is final for this attempt: the last units
    // went to another buyer, or the coupon ran out. The customer's remedy
    // changes the cart, which changes the quote and with it the checkout key
    // (B12) — so no retry will ever come back for THIS hold, and keeping it
    // would leave the money unspendable until the orphan sweep, refusing the
    // corrected order with INSUFFICIENT_FUNDS on a tight wallet. It is handed
    // back now. Anything else is transient and keeps the hold for the
    // same-key retry, exactly as above.
    const refusal = /NOT NULL constraint failed: orders\.status/i.test(msg)
      ? await stockRefusal(db, cart)
      : /NOT NULL constraint failed: orders\.coupon_code/i.test(msg)
        ? refuse('This coupon has just been used up', 'COUPON_EXHAUSTED', { code: cart.coupon_code })
        : /NOT NULL constraint failed: orders\.address_snapshot/i.test(msg)
          ? refuse(
              'Your cart changed while you were checking out — it may have been ordered from another tab. Check your orders.',
              'CART_CHANGED'
            )
          : isDeliveryFenceAbort(msg)
            ? await deliveryMovedRefusal(c, typeof body.couponCode === 'string' ? body.couponCode : '', where)
            : null;
    if (!refusal) throw e;
    // A failed release is not the customer's problem and does not change the
    // answer: the orphan sweep returns the reservation after its TTL.
    await releaseHold(db, { holdId, reason: `store order refused: ${refusal.code}` }).catch((err: unknown) =>
      console.error('store checkout: could not release the refused hold', holdId, err)
    );
    throw refusal;
  }

  await audit(db, user.id, 'community.store_order_created', orderId, {
    store: cart.store_id,
    total: cart.total_iqd,
    delivery: cart.delivery_iqd,
    fulfilment: cart.delivery.resolution.fulfilment,
    governorate: cart.delivery.resolution.governorate,
    delivery_rule: cart.delivery.resolution.rule,
    delivery_version: cart.delivery.resolution.profile_version,
    fee: cart.commission.platform_fee_iqd,
    receivable: cart.commission.merchant_receivable_iqd,
  });

  /**
   * A WHOLE CLASS OF PAID ORDERS WAS INVISIBLE IN EVERY ORDERS TOPIC.
   *
   * This route writes a REAL `orders` row and commits a real wallet debit, and
   * it told nobody — not the admin group and not, before this, any topic at
   * all. Only worker/routes/orders.ts announced a sale, so the owner's
   * «📝 Orders» topics showed the platform's own sales and silently omitted
   * every purchase made from a community store. A topic that is missing a
   * whole category is worse than a topic that is empty: it looks complete.
   *
   * `orderTopic('direct')` and not the pre-order queue, stated as a literal
   * because there is nothing to derive it from: a store sale is goods that
   * already exist, paid from the wallet before the merchant ships, with no
   * `shipping_type` on this path at all (see the prepaid-only rule above). It
   * is a direct sale by definition, and the day that stops being true this
   * line is the one that has to change.
   *
   * The merchant and the store are in the message because the platform is not
   * the seller here — the first question about a store order is always whose
   * store it was.
   */
  announceAfterResponse(
    c,
    orderTopic('direct'),
    orderAnnouncement({
      orderId,
      storeName: cart.store_name,
      customerName: user.name || user.username || `#${user.id}`,
      recipientName: address?.name,
      phone: address?.phone,
      governorate: address?.governorate,
      area: address?.area,
      address: address?.address,
      landmark: address?.landmark,
      shippingType: 'direct',
      paymentMethodId: 'wallet',
      totalIqd: cart.total_iqd,
      // Nothing is ever due at the door on this path (the prepaid-only rule
      // above), so the message says so with a zero rather than omitting the
      // line — an absent figure reads as "unknown", which is worse here.
      dueOnDeliveryIqd: 0,
      merchantReceivableIqd: cart.commission.merchant_receivable_iqd,
      // `PricedLine.variant` is the option and colour by the MERCHANT'S names
      // (`merchantVariant`), never the ids this path stores — an id in a group
      // message is noise, and a missing name prints no variant at all. No
      // «تم تأكيد الطلب» button here: a store sale is confirmed by the
      // merchant who fulfils it, not by the platform's group.
      lines: cart.lines,
    })
  );

  // THE STORE HEARS ABOUT ITS OWN SALE (B23) — after the response, never
  // holding it, and never able to fail it.
  const tell = notifyMerchantOfStoreOrder(c.env, {
    merchantId: cart.merchant_id,
    orderId,
    event: 'new',
    totalIqd: cart.total_iqd,
  });
  try {
    c.executionCtx.waitUntil(tell);
  } catch {
    await tell;
  }
  // «المخزون ينفد» — a product or variant this sale took to (or under) the
  // merchant's own line is told once per order (W2-F, worker/lib/catalog/lowStock.ts).
  if (cart.stockMoves.length) {
    const low = alertLowStock(c.env, cart.merchant_id, cart.stockMoves, `order:${orderId}`);
    try {
      c.executionCtx.waitUntil(low);
    } catch {
      await low;
    }
  }

  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<Record<string, unknown>>();
  return c.json({ success: true, order: storeOrderPublic(order!) }, 201);
});
