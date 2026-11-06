/**
 * THE POINTS SHOP'S PRODUCTS (owner, 2026-11-05; migration 0229; docs/DECISIONS.md
 * row 299).
 *
 *   «23000 points to redeem filament of esun pla plus beige , 23100 points to redeem
 *    filament of esun pla plus black and 23250 points to redeem filament of esun pla
 *    plus cold white»
 *
 * A PRODUCT FOR POINTS IS AN ORDINARY GIFT. `gift_entitlements`, mode 'product', reason
 * 'reward', born `redeemed`, so the rest of the road is the gift's own and nothing new:
 * «هداياي», the 0 IQD cart line, delivery charged as usual, the checkout that re-checks
 * the product, the 0175 triggers (a cancelled order hands the gift back, a delivered one
 * fulfils it), and a product that is not sellable today refused at the door.
 *
 * Which products, at what price, is the owner's: `rewardProgramConfig.shop.items`. A row
 * names the store's own product exactly as a gift does (gifts/selection.ts), and the one
 * rule `checkGiftSelection` judges it at every door: on the owner's save, in the hub, at
 * the swap. A product a customer may not see is not shown here either.
 *
 * THE SWAP IS ONE BATCH, and reads no figure from the client: the gift (only while this
 * customer holds no un-ordered gift of the same item, «one at a time»), its fence, its
 * redemption row, its audit row, and the POINT withdrawal by the negative-amount abort
 * of `buyShopCoupon`, under a key that names the gift (`wtx_rwshop_<gift>`).
 *
 * THE POINTS COME BACK ONCE, ONLY WHEN THE TEAM CANCELS THE GIFT BEFORE IT IS ORDERED
 * (`pointsBackStatements`, in the cancel's own batch, under a key that names the gift).
 * An ordered or fulfilled gift cannot be cancelled there. A cancelled ORDER does not give
 * points back: the gift returns to «هداياي», still paid for, and can be ordered again.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): before 0229 the hub offers no product, since no gift
 * could remember what was paid for it, and the swap answers 503 as the coupon swap does
 * before 0220.
 */
import type { Env } from '../types';
import { newId } from '../crypto';
import { planGrant } from '../gifts/grant';
import { isLostRace } from '../gifts/fence';
import { checkGiftSelection, loadGiftProduct, loadGiftProducts, type GiftProductContext, type GiftSelectionInput, type GiftSelectionResult } from '../gifts/selection';
import { isSchemaMissing } from '../membershipBenefits';
import { notifyStatement } from '../notifications';
import { safeParse } from '../types';
import { getRewardConfig, type ShopProductConfig } from './config';
import { RewardShopError } from './coupons';
import { rewardText, type Trilingual } from './strings';

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

const shopItemInput = (i: ShopProductConfig): GiftSelectionInput => ({
  productId: i.product_id,
  saleType: i.sale_type,
  optionValueIds: i.option_value_ids,
  colorId: i.color_id,
  transportMethod: i.transport_method,
  qty: i.qty,
});

const onSale = (i: ShopProductConfig): i is ShopProductConfig & { points: number } => i.enabled && i.points !== null;

/** The product of a row as its gift would show it: its name, picture, model and colour. */
export interface ShopItemProduct {
  id: string;
  slug: string;
  name: Trilingual;
  image: string;
  option: Trilingual | null;
  color: Trilingual | null;
  color_hex: string;
  qty: number;
}

export interface ShopItemView {
  id: string;
  points: number;
  affordable: boolean;
  points_short: number;
  /** This customer holds an un-ordered gift of this item: the swap would refuse it. */
  holding: boolean;
  /** Orderable right now, at this quantity. */
  available: boolean;
  product: ShopItemProduct;
}

function productOf(r: Extract<GiftSelectionResult, { ok: true }>, item: ShopProductConfig): ShopItemProduct {
  const s = r.snapshot;
  const tri = (ar: string, en: string, ckb: string): Trilingual => ({ ar, en: en || ar, ckb: ckb || ar });
  return {
    id: item.product_id,
    slug: s.slug,
    name: tri(s.name_ar, s.name_en, s.name_ckb),
    image: s.image,
    option: s.variant_ar || s.variant_en ? tri(s.variant_ar, s.variant_en, s.variant_ckb) : null,
    color: s.color_name_ar || s.color_name_en ? tri(s.color_name_ar, s.color_name_en, s.color_name_ckb) : null,
    color_hex: s.color_hex,
    qty: s.qty,
  };
}

/** Today's verdict, and the same row described without asking for stock, so an empty shelf is still named. */
function judge(item: ShopProductConfig, product: GiftProductContext | undefined) {
  if (!product) return { live: null, described: null };
  const live = checkGiftSelection(product, shopItemInput(item), { requireSellable: true });
  const described = live.ok ? live : checkGiftSelection(product, shopItemInput(item), { requireSellable: false });
  return { live, described };
}

/** Which of these items this customer holds un-ordered: the swap's own guard, read. Throws before 0229. */
async function heldItems(db: D1Database, userId: string, ids: readonly string[]): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT shop_item_id FROM gift_entitlements
        WHERE user_id = ?1 AND state = 'redeemed' AND shop_item_id IN (SELECT value FROM json_each(?2))`
    )
    .bind(userId, JSON.stringify(ids))
    .all<{ shop_item_id: string }>();
  return new Set((results ?? []).map((r) => r.shop_item_id));
}

/**
 * The hub's `shop_items`: what is on sale, for this customer, with their points. No read
 * at all when nothing is on sale. A row whose product the store no longer shows (hidden,
 * deleted, its model gone) is not offered: the customer may not see it. One out of stock
 * still is, `available: false`, so they can see what their points are for.
 */
export async function shopItemsForCustomer(env: { DB: D1Database }, userId: string, items: readonly ShopProductConfig[], balance: number): Promise<ShopItemView[]> {
  const selling = items.filter(onSale);
  if (selling.length === 0) return [];
  let held: Set<string>;
  try {
    held = await heldItems(env.DB, userId, selling.map((i) => i.id));
  } catch (e) {
    // Before 0229 nothing can be bought, so nothing is offered.
    if (isSchemaMissing(e)) return [];
    throw e;
  }
  const products = await loadGiftProducts(env, selling.map((i) => i.product_id));
  const out: ShopItemView[] = [];
  for (const item of selling) {
    const { live, described } = judge(item, products.get(item.product_id));
    if (!described?.ok) continue;
    out.push({
      id: item.id,
      points: item.points,
      affordable: balance >= item.points,
      points_short: Math.max(0, item.points - balance),
      holding: held.has(item.id),
      available: live?.ok === true,
      product: productOf(described, item),
    });
  }
  return out;
}

export interface AdminShopItemView {
  id: string;
  /**
   * The product as a gift of it would show. When the store can no longer describe the
   * selection (hidden, its colour gone), its bare name and picture, so the owner can see
   * which row `reason` is about. Null only when the id names no product.
   */
  product: ShopItemProduct | null;
  /** What the product sells for at the regular price, for the owner's comparison. No cost. */
  value_iqd: number | null;
  available: boolean;
  /** The refusal code when it is not. */
  reason: string | null;
  /** Gifts not cancelled, and the points they took. */
  swapped: number;
  points_taken: number;
}

/** The owner's row whose selection no longer stands: what the product's own row can still say. */
function bareProduct(item: ShopProductConfig, product: GiftProductContext | undefined): ShopItemProduct | null {
  const row = product?.row;
  if (!row) return null;
  const en = text(row.name);
  const ar = text(row.name_ar) || en;
  const images = safeParse<unknown>(text(row.images) || '[]', []);
  return {
    id: item.product_id,
    slug: text(row.slug),
    name: { ar, en: en || ar, ckb: text(row.name_ku) || ar },
    image: Array.isArray(images) && typeof images[0] === 'string' ? images[0] : '',
    option: null,
    color: null,
    color_hex: '',
    qty: item.qty,
  };
}

/** Every row of the owner's list, on sale or not, as the settings screen draws it. Costs nothing when there are none. */
export async function shopItemsForAdmin(env: { DB: D1Database }, items: readonly ShopProductConfig[]): Promise<AdminShopItemView[]> {
  if (items.length === 0) return [];
  const [products, tally] = await Promise.all([
    loadGiftProducts(env, items.map((i) => i.product_id)),
    env.DB.prepare(
      `SELECT shop_item_id, COUNT(*) AS n, COALESCE(SUM(points_spent), 0) AS points FROM gift_entitlements
        WHERE state <> 'cancelled' AND shop_item_id IN (SELECT value FROM json_each(?1)) GROUP BY shop_item_id`
    )
      .bind(JSON.stringify(items.map((i) => i.id)))
      .all<{ shop_item_id: string; n: number; points: number }>()
      .then((r) => r.results ?? [])
      .catch((e: unknown) => {
        if (isSchemaMissing(e)) return [];
        throw e;
      }),
  ]);
  const byItem = new Map(tally.map((t) => [t.shop_item_id, t]));
  return items.map((item) => {
    const product = products.get(item.product_id);
    const { live, described } = judge(item, product);
    const counted = byItem.get(item.id);
    return {
      id: item.id,
      product: described?.ok ? productOf(described, item) : bareProduct(item, product),
      value_iqd: described?.ok ? described.snapshot.value_iqd : null,
      available: live?.ok === true,
      reason: live && !live.ok ? live.code : live ? null : 'GIFT_PRODUCT_NOT_FOUND',
      swapped: Number(counted?.n) || 0,
      points_taken: Number(counted?.points) || 0,
    };
  });
}

/**
 * THE OWNER'S SAVE: each row on sale must be a selection the store can sell, whatever
 * today's stock (the admin gift editor's own rule). The first that is not, with its code
 * and its place in the list, or null.
 */
export async function firstShopItemRefusal(
  env: { DB: D1Database },
  items: readonly ShopProductConfig[]
): Promise<{ code: string; item_id: string; item_index: number; errors: string[] } | null> {
  const selling = items.filter((i) => i.enabled);
  if (selling.length === 0) return null;
  const products = await loadGiftProducts(env, selling.map((i) => i.product_id));
  for (const item of selling) {
    const { described } = judge(item, products.get(item.product_id));
    if (!described) return { code: 'GIFT_PRODUCT_NOT_FOUND', item_id: item.id, item_index: items.indexOf(item), errors: ['PRODUCT_NOT_FOUND'] };
    if (!described.ok) return { code: described.code, item_id: item.id, item_index: items.indexOf(item), errors: described.errors };
  }
  return null;
}

/** Swaps points for one product of the shop. Answers the new gift's id. See the file's header. */
export async function buyShopItem(env: Env, userId: string, itemId: string, nowIso = new Date().toISOString()): Promise<string> {
  const db = env.DB;
  const config = await getRewardConfig(db);
  const item = config.shop.items.find((i) => i.id === itemId);
  if (!item || !onSale(item)) throw new RewardShopError('REWARD_SHOP_UNAVAILABLE', 'This reward is not on sale right now');
  const checked = checkGiftSelection(await loadGiftProduct(env, item.product_id), shopItemInput(item), { requireSellable: true, now: nowIso });
  if (!checked.ok) throw new RewardShopError('REWARD_SHOP_UNAVAILABLE', 'This reward is not on sale right now');

  const price = item.points;
  const giftId = newId('gift');
  const txId = `wtx_rwshop_${giftId}`;
  const plan = await planGrant(db, {
    id: giftId,
    userId,
    level: 1,
    reason: 'reward',
    note: '',
    actorId: userId,
    pinned: { selection: checked.selection, snapshot: { ...checked.snapshot, points_shop: true }, itemId: null },
    now: nowIso,
    shop: { itemId: item.id, points: price, txId },
    auditExtra: { actor: userId, shop_item_id: item.id, points: price, points_tx_id: txId },
  });
  try {
    await db.batch([
      ...plan.statements,
      // ONE redemption per gift, for ever: the row every redeemed gift has.
      db
        .prepare('INSERT INTO gift_redemptions (entitlement_id, user_id, level, options, contents, created_at) VALUES (?1, ?2, 1, ?3, ?4, ?5)')
        .bind(giftId, userId, JSON.stringify({ shop_item_id: item.id }), JSON.stringify(checked.snapshot), nowIso),
      // The withdrawal the coupon swap makes: an amount that turns negative aborts the whole batch when the balance no longer covers the price.
      db
        .prepare(
          `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           SELECT ?1, ?2, 'withdrawal', 'POINT',
                  CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0)
                               FROM wallet_transactions WHERE user_id = ?2 AND currency = 'POINT' AND status = 'approved') >= ?3
                       THEN ?3 ELSE -1 END,
                  'approved', ?4, ?5, 'system', ?6`
        )
        .bind(txId, userId, price, `Points shop product: ${checked.snapshot.name_en}`.slice(0, 200), `reward_shop:${giftId}`, nowIso),
    ]);
  } catch (e) {
    // The fence comes first: a double press is «you hold one», even for someone who could not afford a second.
    if (isLostRace(e)) throw new RewardShopError('REWARD_SHOP_HOLDING', 'You already hold this product — order it before swapping for another');
    if (/CHECK/i.test(e instanceof Error ? e.message : String(e))) throw new RewardShopError('INSUFFICIENT_POINTS', 'You do not have enough points for this reward');
    throw e;
  }
  return giftId;
}

/**
 * The team cancelled a gift the customer paid points for: the points go back, in the
 * cancel's own batch, after its fence, with one notice in three languages. The key names
 * the gift, so they can come back only once however the cancel is pressed. Nothing for
 * any other gift, and nothing before 0229, whose rows read 0.
 */
export function pointsBackStatements(db: D1Database, g: Record<string, unknown>, nowIso: string): D1PreparedStatement[] {
  const points = Math.max(0, Math.trunc(Number(g.points_spent) || 0));
  if (points <= 0) return [];
  const id = text(g.id);
  const userId = text(g.user_id);
  const snapshot = (() => {
    try {
      return JSON.parse(text(g.gift_snapshot) || '{}') as { name_ar?: string; name_en?: string; name_ckb?: string };
    } catch {
      return {};
    }
  })();
  const say = rewardText({
    kind: 'shop_gift_refund',
    name: { ar: snapshot.name_ar ?? '', en: snapshot.name_en ?? '', ckb: snapshot.name_ckb ?? '' },
    points,
  });
  return [
    db
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?1, ?2, 'deposit', 'POINT', ?3, 'approved', 'Points shop refund: gift cancelled', ?4, 'system', ?5)`
      )
      .bind(`wtx_rwshop_back_${id}`, userId, points, `reward_shop_back:${id}`, nowIso),
    notifyStatement(db, {
      userId,
      kind: 'reward',
      title_ar: say.title.ar,
      title_en: say.title.en,
      body_ar: say.body.ar,
      body_en: say.body.en,
      link: '/rewards/shop',
      entity_type: 'gift',
      entity_id: id,
      meta: { title_ckb: say.title.ckb, body_ckb: say.body.ckb, points },
      eventKey: `reward:shop_refund:${id}`,
    }).stmt,
  ];
}
