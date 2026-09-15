/**
 * THE BUY PATH FOR A COMPOSITION LINE — docs/BUNDLES_MYSTERY.md §5 (the cart),
 * §6.1 (re-validation at the door) and §6.2 (the order snapshot).
 *
 * Everything here is shared by `POST /api/cart/items`, `PATCH /api/cart/items`,
 * `GET /api/cart`, `POST /api/orders/quote` and `POST /api/orders`, for one
 * reason: the four doors must refuse the same configuration for the same named
 * reason, and a bundle whose colour was deactivated between the cart and the
 * checkout must fail with `BUNDLE_CHOICE_INVALID` at BOTH, not be silently
 * repaired at one of them.
 *
 * FIVE RULES THIS FILE HOLDS.
 *
 * 1. THE CLIENT SENDS AN ID AND A CHOICE, NEVER A PRICE, A COMPONENT LIST, A
 *    COMPOSITION KEY OR A STOCK NUMBER (§5.2). A field of any of those names in
 *    the body is IGNORED — not echoed, not validated, not refused with a hint.
 *    `bundleChoices` is the only composition input, and every entry of it is
 *    checked against the admin's own `bundle_components` rows.
 *
 * 2. A CHOICE IS EITHER PINNED BY THE ADMIN OR MADE BY THE CUSTOMER, NEVER
 *    BOTH AND NEVER NEITHER. A choice submitted for a pinned dimension is
 *    `BUNDLE_CHOICE_NOT_ALLOWED`; a customer-selectable dimension with no
 *    choice is `BUNDLE_CHOICE_INVALID`. Choosing on the buyer's behalf would be
 *    the silent repair the mandate forbids, on the money path.
 *
 * 3. AN OPTIONAL COMPONENT THE BUYER OPTED INTO IS REFUSED, NEVER DROPPED
 *    (§2.2, `BUNDLE_OPTIONAL_UNAVAILABLE`). Dropping it changes what the
 *    customer bought, at the full price, after they pressed Place order.
 *
 * 4. THE LINE IDENTITY IS `compositionKey(choices)` IN `cart_items.option_id`,
 *    computed SERVER-SIDE (§5.1). Two bundles with different colours are two
 *    lines; two with the same are one line at qty 2. `selectionFromCartRow`
 *    returns an EMPTY selection for a composition row so that key never reaches
 *    the price resolver or `saleAvailability`.
 *
 * 5. ONE TRANSPORT METHOD, OFFERED BY EVERY PRE-ORDER COMPONENT (§2.2, §17.12).
 *    It is stored on the bundle's OWN `cart_items.transport_method`, so
 *    `cartShippingType`, the mixed-cart guard and `orderShippingType` keep
 *    working with no change at all.
 */

import { badRequest, HttpError } from './http';
import { safeParse } from './types';
import {
  compositionSelect,
  compositionMaxQty,
  type ComponentChoice,
  type ResolvedBundle,
  type ResolvedComponentView,
} from './bundleRead';
import { MAX_PHYSICAL_LINES, type BundleComponentRow } from './bundleComposition';
import { transportForType, typeForTransport, type ShippingType } from './shippingType';
import { primaryMedia } from './productModel';
import {
  publicMysteryBlock,
  resolveMysteryLines,
  withMysteryAvailability,
  type MysteryContext,
} from './mysteryLine';

export type { ComponentChoice };

const CHUNK = 50;

// ------------------------------------------------------------- submissions

/** One `bundleChoices[]` entry, as the browser may send it — ids only. */
export interface SubmittedChoice {
  componentId: string;
  optionValueIds: string[];
  colorId: string;
  included: boolean;
}

/**
 * The client's `bundleChoices` array, parsed and bounded. Anything that is not
 * a component id and a selection is dropped here rather than reaching a query:
 * this is the only composition input a browser has, so it is read narrowly.
 */
export function parseBundleChoices(raw: unknown): SubmittedChoice[] {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_PHYSICAL_LINES) : [];
  const out: SubmittedChoice[] = [];
  for (const entry of list) {
    const e = entry as Record<string, unknown>;
    const componentId = typeof e?.componentId === 'string' ? e.componentId.slice(0, 60) : '';
    if (!componentId) continue;
    const ids = Array.isArray(e.optionValueIds) ? e.optionValueIds : [];
    out.push({
      componentId,
      optionValueIds: [
        ...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 60)),
      ].slice(0, 12),
      colorId: typeof e.colorId === 'string' ? e.colorId.slice(0, 60) : '',
      // Absent means included: an optional component is offered as part of the
      // bundle, and only an explicit `false` declines it.
      included: e.included !== false,
    });
  }
  return out;
}

/**
 * THE COMPLETE CHOICE SET FOR ONE LINE, refused rather than guessed.
 *
 * Returns one entry per component — a pinned component's own selection, or the
 * customer's — so the composition key, the stored `cart_bundle_choices` rows
 * and the resolution all see the same closed set. A submission naming a
 * component of another bundle, a dimension the admin pinned, or a required
 * component it tries to decline is refused by name.
 */
export function resolveChoiceSet(
  components: BundleComponentRow[],
  submitted: SubmittedChoice[],
  label: string
): Map<string, ComponentChoice> {
  const byId = new Map(components.map((c) => [c.id, c]));
  const bySubmission = new Map<string, SubmittedChoice>();
  for (const s of submitted) {
    if (!byId.has(s.componentId)) {
      throw badRequest(
        `"${label}": that item is not part of this bundle any more — reopen the bundle and choose again`,
        'BUNDLE_COMPOSITION_CHANGED',
        { component_id: s.componentId }
      );
    }
    bySubmission.set(s.componentId, s);
  }

  const out = new Map<string, ComponentChoice>();
  for (const c of components) {
    const s = bySubmission.get(c.id);
    if (s && !c.customer_picks_option && s.optionValueIds.length) {
      throw badRequest(
        `"${label}": the option for this item is fixed by the bundle and cannot be chosen`,
        'BUNDLE_CHOICE_NOT_ALLOWED',
        { component_id: c.id, dim: 'option_value' }
      );
    }
    if (s && !c.customer_picks_color && s.colorId) {
      throw badRequest(
        `"${label}": the colour for this item is fixed by the bundle and cannot be chosen`,
        'BUNDLE_CHOICE_NOT_ALLOWED',
        { component_id: c.id, dim: 'color' }
      );
    }
    if (s && !c.optional && !s.included) {
      throw badRequest(
        `"${label}": this item is part of the bundle and cannot be removed`,
        'BUNDLE_CHOICE_NOT_ALLOWED',
        { component_id: c.id }
      );
    }
    if (c.customer_picks_option && !(s && s.optionValueIds.length)) {
      throw badRequest(
        `"${label}": choose an option for every item in this bundle`,
        'BUNDLE_CHOICE_INVALID',
        { component_id: c.id, dim: 'option_value' }
      );
    }
    if (c.customer_picks_color && !(s && s.colorId)) {
      throw badRequest(
        `"${label}": choose a colour for every item in this bundle`,
        'BUNDLE_CHOICE_INVALID',
        { component_id: c.id, dim: 'color' }
      );
    }
    out.set(c.id, {
      option_value_ids: c.customer_picks_option ? [...(s?.optionValueIds ?? [])].sort() : [...c.option_value_ids].sort(),
      color_id: (c.customer_picks_color ? s?.colorId || '' : c.color_id) || null,
      included: c.optional ? (s ? s.included : true) : true,
    });
  }
  return out;
}

/** The choice set of a bundle with no customer-selectable dimension at all —
 *  the shape the admin pinned, which is exactly one possible key. */
export const pinnedChoiceSet = (components: BundleComponentRow[]): Map<string, ComponentChoice> =>
  resolveChoiceSet(components, [], '');

/** The stored choices as `compositionKey` wants them — sorted by component id
 *  so the key of one set is one string, whatever order the rows arrived in. */
export const keyInput = (choices: Map<string, ComponentChoice>) =>
  [...choices.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([component_id, ch]) => ({
      component_id,
      option_value_ids: ch.option_value_ids,
      color_id: ch.color_id,
      included: ch.included,
    }));

// ------------------------------------------------------------------- loads

/** The composition products behind a set of cart lines, with `bundle_config`
 *  and `offer_windows` joined onto the same row — one read for the whole cart,
 *  never one per line (§14). */
export async function loadCompositionRows(
  db: D1Database,
  productIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const ids = [...new Set(productIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    // A cart that merely CONTAINS a bundle must not die because the optional
    // offers table is not installed. See `compositionSelect`.
    const results = await compositionSelect(
      db,
      (cols, from) => `SELECT ${cols} ${from} WHERE p.id IN (${part.map(() => '?').join(', ')})`,
      part
    );
    for (const r of results) out.set(String(r.id), r);
  }
  return out;
}

/** The buyer's stored choices for a set of cart lines, in one chunked read. */
export async function loadCartChoices(
  db: D1Database,
  cartItemIds: string[]
): Promise<Map<string, Map<string, ComponentChoice>>> {
  const out = new Map<string, Map<string, ComponentChoice>>();
  const ids = [...new Set(cartItemIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT cart_item_id, component_id, option_value_ids, color_id, included
           FROM cart_bundle_choices WHERE cart_item_id IN (${part.map(() => '?').join(', ')})`
      )
      .bind(...part)
      .all<Record<string, unknown>>();
    for (const r of results) {
      const lineId = String(r.cart_item_id);
      const map = out.get(lineId) ?? new Map<string, ComponentChoice>();
      map.set(String(r.component_id), {
        option_value_ids: safeParse<unknown[]>(String(r.option_value_ids ?? '[]'), []).filter(
          (x): x is string => typeof x === 'string' && !!x
        ),
        color_id: String(r.color_id ?? '') || null,
        included: Number(r.included ?? 1) !== 0,
      });
      out.set(lineId, map);
    }
  }
  return out;
}

/**
 * THE CHOICES, WRITTEN IN THE CART UPSERT'S OWN BATCH.
 *
 * The cart line's id is resolved by the statements themselves rather than read
 * beforehand: an upsert either inserts the id we generated or updates a row
 * that already existed with a different one, and a second read cannot tell the
 * two apart without a race. Earlier statements in a D1 batch are visible to
 * later ones, so `SELECT id FROM cart_items WHERE …` inside these statements
 * sees the row this same batch just wrote — with no window in which a line
 * exists without its composition.
 */
export function cartChoiceStatements(
  db: D1Database,
  userId: string,
  productId: string,
  compositionKeyValue: string,
  choices: Map<string, ComponentChoice>
): D1PreparedStatement[] {
  const lineSelect = `SELECT id FROM cart_items
                       WHERE user_id = ? AND product_id = ? AND option_id = ?
                         AND color_id = '' AND shipping_method_id = ''`;
  const ids = [...choices.keys()];
  const stmts: D1PreparedStatement[] = [
    // A component the admin removed since this line was written must not stay
    // behind as a stale row nobody can see and every price ignores.
    //
    // THE KEPT SET RIDES AS ONE JSON PARAMETER, not as one placeholder per
    // component. §3.1 requires every `IN (…)` list this feature adds to be
    // bounded, and `MAX_PHYSICAL_LINES` is 250 — a legal bundle can carry more
    // components than D1 accepts bound parameters in one query, and a `NOT IN`
    // list cannot be chunked the way a positive one can (each chunk would
    // delete the rows named by every other chunk). `json_each` removes the list
    // instead of bounding it, so the statement binds four parameters whatever
    // the bundle's size.
    db
      .prepare(
        `DELETE FROM cart_bundle_choices
          WHERE cart_item_id IN (${lineSelect})
            AND component_id NOT IN (SELECT value FROM json_each(?))`
      )
      .bind(userId, productId, compositionKeyValue, JSON.stringify(ids)),
  ];
  for (const [componentId, ch] of choices) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO cart_bundle_choices (cart_item_id, component_id, option_value_ids, color_id, included)
           SELECT id, ?, ?, ?, ? FROM cart_items
            WHERE user_id = ? AND product_id = ? AND option_id = ? AND color_id = '' AND shipping_method_id = ''
           ON CONFLICT(cart_item_id, component_id) DO UPDATE SET
             option_value_ids = excluded.option_value_ids,
             color_id = excluded.color_id,
             included = excluded.included`
        )
        .bind(
          componentId,
          JSON.stringify([...ch.option_value_ids].sort()),
          ch.color_id ?? '',
          ch.included ? 1 : 0,
          userId,
          productId,
          compositionKeyValue
        )
    );
  }
  return stmts;
}

// ------------------------------------------------------------------- doors

export const includedComponents = (b: ResolvedBundle): ResolvedComponentView[] =>
  b.components.filter((c) => c.included);

/**
 * ONE TRANSPORT METHOD EVERY PRE-ORDER COMPONENT OFFERS, or null.
 *
 * The platform holds one shipping type per cart and freezes one onto
 * `orders.shipping_type`, so a bundle whose pre-order components share no
 * method has no honest delivery date. It is refused (§2.5) — never split into
 * two orders and never forced onto the slowest journey.
 */
export function sharedTransports(b: ResolvedBundle): { preorder: boolean; methods: string[] } {
  const preorder = includedComponents(b).filter((c) => c.preorder_only);
  if (preorder.length === 0) return { preorder: false, methods: [] };
  let shared: string[] | null = null;
  for (const c of preorder) shared = shared === null ? [...c.transports] : shared.filter((m) => c.transports.includes(m));
  return { preorder: true, methods: shared ?? [] };
}

/**
 * The transport method this line must carry, validated against what every
 * pre-order component actually offers. A direct bundle carries `''`, which is
 * what "direct" has always meant on a cart row.
 */
export function resolveLineTransport(b: ResolvedBundle, requested: string, label: string): string {
  const { preorder, methods } = sharedTransports(b);
  if (!preorder) {
    if (requested) {
      throw badRequest(
        `"${label}": this bundle ships directly and takes no pre-order transport`,
        'BUNDLE_CHOICE_NOT_ALLOWED',
        { transport_method: requested }
      );
    }
    return '';
  }
  if (methods.length === 0) {
    throw badRequest(
      `"${label}": the items in this bundle do not share a single shipping method`,
      'BUNDLE_SHIPPING_MIXED'
    );
  }
  if (!requested) {
    throw badRequest(
      `"${label}": choose a shipping method for this pre-order bundle`,
      'VALIDATION',
      { transport_methods: methods }
    );
  }
  if (!methods.includes(requested)) {
    throw badRequest(
      `"${label}": every item in this bundle must offer the chosen shipping method`,
      'BUNDLE_SHIPPING_MIXED',
      { transport_method: requested, transport_methods: methods }
    );
  }
  return requested;
}

/**
 * THE DOOR — every §6.1 re-validation, in ONE function, so add-to-cart, the
 * quote and `POST /api/orders` refuse the same configuration for the same
 * named reason. `label` is the customer's own word for the line.
 *
 * The order is deliberate: what the offer IS comes before what it costs, and
 * both come before stock, so a locked bundle says `MEMBERSHIP_REQUIRED` rather
 * than "out of stock" and a customer is never told the wrong thing first.
 */
export function refuseComposition(
  b: ResolvedBundle,
  qty: number,
  label: string,
  opts: { transportMethod?: string } = {}
): void {
  // A MYSTERY offer legitimately has no components — its contents are drawn,
  // not composed — so "no components" is a fault only for a bundle. The
  // mystery line's own door is `refuseMystery` in worker/lib/mysteryLine.ts,
  // and the pool's verdict has already replaced this row's availability.
  if (b.components.length === 0 && b.doc.composition !== 'mystery') {
    throw badRequest(`"${label}" is not available right now`, 'OFFER_INACTIVE');
  }
  if (b.doc.status !== 'active') {
    throw badRequest(`"${label}" is no longer available — please remove it from your cart`, 'OFFER_INACTIVE');
  }
  if (!b.offer.ok) {
    const reason = b.offer.reason ?? 'OFFER_INACTIVE';
    if (reason === 'MEMBERSHIP_REQUIRED') {
      throw new HttpError(403, `"${label}" is available to members only`, 'MEMBERSHIP_REQUIRED', {
        required_tiers: b.offer.required_tiers,
      });
    }
    // NO MACHINE CODE INSIDE A CUSTOMER SENTENCE (§15.3). The code travels in
    // the `code` field, where `refusalText` decodes it into the viewer's own
    // language; printing it inside the prose put `(OFFER_WINDOW_EXPIRED)` in
    // parentheses after an Arabic product name on the last screen before
    // payment, with no bidi isolation and nothing translatable.
    throw badRequest(`"${label}" is not available right now`, reason);
  }
  // A price that fell below its floor stops the sale rather than dragging the
  // bundle to nothing (§4.3), and a subject carrying two price sources does
  // not sell rather than being priced by whichever branch ran first (§4.6).
  const priceError = b.pricing.errors.find((e) => e === 'OFFER_INACTIVE' || e === 'OFFER_PRICE_CONFLICT');
  if (priceError) {
    throw badRequest(`"${label}" is not available right now`, 'OFFER_INACTIVE');
  }
  for (const c of b.components) {
    if (c.choice_errors.length) {
      throw badRequest(
        `"${label}": one of your choices is no longer offered — reopen the bundle and choose again`,
        c.choice_errors[0],
        { component_id: c.component_id }
      );
    }
  }
  if (b.availability.shipping_type === 'mixed') {
    throw badRequest(
      `"${label}": the items in this bundle no longer share one shipping method`,
      'BUNDLE_SHIPPING_MIXED'
    );
  }
  if (opts.transportMethod !== undefined) {
    const { preorder, methods } = sharedTransports(b);
    if (preorder && !methods.includes(opts.transportMethod)) {
      throw badRequest(
        `"${label}": every item in this bundle must offer the chosen shipping method`,
        'BUNDLE_SHIPPING_MIXED',
        { transport_method: opts.transportMethod, transport_methods: methods }
      );
    }
    if (!preorder && opts.transportMethod) {
      throw badRequest(
        `"${label}": this bundle ships directly and takes no pre-order transport`,
        'BUNDLE_SHIPPING_MIXED',
        { transport_method: opts.transportMethod }
      );
    }
  }
  // An optional component the buyer OPTED INTO and that cannot be satisfied is
  // refused with its own code, naming it — never dropped, and never charged
  // for (§2.2). Checked before the generic sold-out so the customer is told
  // which switch to un-tick.
  const optionalBlocked = b.availability.blocking.find((x) => {
    const c = b.components.find((k) => k.component_id === x.component_id);
    return !!c && c.optional && c.included;
  });
  if (optionalBlocked) {
    const c = b.components.find((k) => k.component_id === optionalBlocked.component_id);
    throw badRequest(
      `"${label}": the optional item "${c?.doc.name_en ?? optionalBlocked.product_id}" you added is not available — remove it and try again`,
      'BUNDLE_OPTIONAL_UNAVAILABLE',
      { component_id: optionalBlocked.component_id, product_id: optionalBlocked.product_id }
    );
  }
  const state = b.availability.state;
  if (state === 'ended') throw badRequest(`"${label}" is no longer available`, 'OFFER_WINDOW_EXPIRED');
  if (state === 'upcoming') throw badRequest(`"${label}" has not started yet`, 'OFFER_WINDOW_NOT_STARTED');
  if (state === 'unconfigured') throw badRequest(`"${label}" is not available right now`, 'OFFER_INACTIVE');
  if (state === 'sold_out' || b.availability.max_bundles === 0) {
    // A FULL IMPORT QUOTA IS NOT AN EMPTY SHELF, and the bundle door must not
    // say it is. When every counter that blocked this bundle is a pre-order
    // capacity, the customer is told the quota is full — a different fact, a
    // different wait, and the one sentence they must not read as "sold out".
    // A mixed bundle (one component off the shelf, one off a quota) keeps
    // OUT_OF_STOCK, because the shelf really is empty and that is the blunter
    // truth of the two.
    const blocking = b.availability.blocking.map((x) => ({ product_id: x.product_id, reason: x.reason }));
    const quotaOnly = blocking.length > 0 && blocking.every((x) => x.reason === 'PREORDER_CAPACITY_EXHAUSTED');
    throw badRequest(
      quotaOnly ? `The pre-order quota for "${label}" is full` : `"${label}" is out of stock`,
      quotaOnly ? 'PREORDER_CAPACITY_EXHAUSTED' : 'OUT_OF_STOCK',
      { blocking }
    );
  }
  // The per-order cap is REFUSED with its number, never silently clamped —
  // `worker/routes/cart.ts` already refuses a quantity rather than rewriting
  // the one number the customer is touching.
  if (qty > b.config.max_qty_per_order) {
    throw badRequest(
      `At most ${b.config.max_qty_per_order} of "${label}" per order`,
      'BUNDLE_QTY_LIMIT',
      { max_qty_per_order: b.config.max_qty_per_order }
    );
  }
  if (b.availability.max_bundles !== null && qty > b.availability.max_bundles) {
    throw badRequest(`Only ${b.availability.max_bundles} of "${label}" left`, 'QTY_UNAVAILABLE', {
      available: b.availability.max_bundles,
    });
  }
}

/**
 * The physical `order_items` rows one line of this bundle produces. §3.1 caps
 * the total per order at `MAX_PHYSICAL_LINES` and refuses above it with
 * `COMPOSITION_TOO_LARGE` — a door refusal, not a clamp — because
 * `max_qty_per_order` reaches 99 and one order could otherwise ask D1 for
 * thousands of statements and meet an opaque parameter-limit error instead.
 */
export const physicalLines = (b: ResolvedBundle, qty: number): number =>
  includedComponents(b).length * Math.max(1, qty) + 1;

/** The `+ 1` is the parent's own `order_items` row, so the count at
 *  add-to-cart and the count at the door are the same number for the same
 *  cart — a ceiling two doors disagree about is a ceiling that refuses an
 *  order the cart already accepted. */
export function refusePhysicalLines(total: number): void {
  if (total > MAX_PHYSICAL_LINES) {
    throw badRequest(
      `This order has too many individual items (${total}); the limit is ${MAX_PHYSICAL_LINES}. Please split it into two orders.`,
      'COMPOSITION_TOO_LARGE',
      { limit: MAX_PHYSICAL_LINES, physical_lines: total }
    );
  }
}

// ---------------------------------------------------------------- payloads

/** «PLA Basic · Black» for one component — the option and colour NAMES. */
export function componentVariantLabel(c: ResolvedComponentView): string {
  const parts: string[] = [];
  for (const id of c.selection.option_value_ids) {
    const o = c.doc.options.find((x) => x.id === id);
    if (o) parts.push(o.name_en || o.name_ar || id);
  }
  if (c.selection.color_id) {
    const col = c.doc.colors.find((x) => x.id === c.selection.color_id);
    if (col) parts.push(col.name_en || col.name_ar || c.selection.color_id);
  }
  return parts.join(' · ');
}

/**
 * The parent order line's `option_snapshot` — DATA ONLY (§6.2).
 *
 * "PLA Basic Black ×2 · Nozzle 0.4". No prose, no count, no English word: a
 * snapshot is immutable and is rendered on the order page, the invoice, the
 * printed receipt and the return case for Arabic and Sorani customers for
 * ever, so freezing "3 items" into it would freeze an English sentence into
 * every future rendering. The count is rendered client-side from the component
 * list the payload already carries.
 */
export function compositionOptionSnapshot(b: ResolvedBundle): string {
  return includedComponents(b)
    .map((c) => {
      const variant = componentVariantLabel(c);
      const name = [c.doc.name_en || c.doc.name_ar || c.member_product_id, variant].filter(Boolean).join(' ');
      return c.qty_per_bundle > 1 ? `${name} ×${c.qty_per_bundle}` : name;
    })
    .join(' · ')
    .slice(0, 500);
}

/**
 * The components' own effective pre-order commissions and direct surcharges,
 * per ONE bundle (§2.2).
 *
 * Zero-pricing the component lines would drop this real money and the store
 * would eat the air-versus-sea difference on every choice, so it is summed
 * onto the PARENT's `unit_subtotal_iqd` while `merchandise` stays exactly
 * `bundle_price_iqd` — the points basis, the coupon minimum and the accrual
 * are therefore unaffected.
 */
export function componentFeesIqd(b: ResolvedBundle): number {
  return includedComponents(b).reduce(
    (sum, c) => sum + Math.max(0, c.unit.unit_subtotal_iqd - c.unit.applied_iqd) * c.qty_per_bundle,
    0
  );
}

/** The per-component fee facts the parent's `transport_snapshot` records, so an
 *  invoice or a refund can explain the parent's number years later. */
export function componentFeeBreakdown(b: ResolvedBundle) {
  return includedComponents(b).map((c) => ({
    component_id: c.component_id,
    product_id: c.member_product_id,
    qty: c.qty_per_bundle,
    commission_iqd: c.unit.transport && c.unit.transport.waived !== true ? Number(c.unit.transport.commission_iqd) || 0 : 0,
    direct_surcharge_iqd: c.unit.direct && c.unit.direct.waived !== true ? Number(c.unit.direct.surcharge_iqd) || 0 : 0,
  }));
}

/** The shipping type the line's own transport method implies. */
export const lineShippingType = (transportMethod: string): ShippingType => typeForTransport(transportMethod);

export const transportOfType = (t: ShippingType): string => transportForType(t);

/**
 * THE CART'S COMPOSITION BLOCK (§5.2) — one main line with its contents.
 *
 * The components appear ONLY here. They are never top-level `items[]` entries,
 * so the cart's own totals and the coupon merchandise sum cannot double-count
 * them. Each component's figure is its STANDALONE value, labelled as such; the
 * discount is stated once, on the bundle.
 */
export function cartCompositionBlock(b: ResolvedBundle, mystery?: MysteryContext, lang = 'ar') {
  return {
    kind: b.doc.composition,
    /** §5.2: a mystery line carries `{ spool_qty, mode, family, reveal_stage }`
     *  and NOTHING else — no pool, no candidate, no weight, no product. */
    ...(b.doc.composition === 'mystery' && mystery
      ? { mystery: { ...publicMysteryBlock(mystery, lang), mode: mystery.mode } }
      : {}),
    component_total_iqd: b.pricing.component_total_iqd,
    bundle_price_iqd: b.pricing.applied_iqd,
    discount_iqd: b.pricing.discount_iqd,
    saving_percent: b.pricing.saving_percent,
    applied_tier: b.pricing.applied_tier,
    price_source: b.pricing.source,
    max_bundles: b.availability.max_bundles,
    max_qty: compositionMaxQty(b),
    max_qty_per_order: b.config.max_qty_per_order,
    availability_state: b.availability.state,
    shipping_type: b.availability.shipping_type,
    modes: b.availability.modes,
    // A mystery line carries no components at all, ever (§8.2 row 12).
    components:
      b.doc.composition === 'mystery'
        ? []
        : b.components.map((c) => ({
            component_id: c.component_id,
            product_id: c.member_product_id,
            product: { slug: c.doc.slug, name: c.doc.name_en, name_ar: c.doc.name_ar, image: primaryMedia(c.doc.media)?.url ?? '' },
            variant: componentVariantLabel(c),
            qty_per_bundle: c.qty_per_bundle,
            optional: c.optional,
            included: c.included,
            editable: c.editable,
            /** The component's STANDALONE value — never a discounted share. */
            value_iqd: c.unit.applied_iqd,
            availability: { state: c.state },
            choices: c.choices.map((ch) => ({ dim: ch.dim, id: ch.id, name: ch.name })),
          })),
  };
}

// ------------------------------------------------------------ mystery glue

/**
 * The family the buyer narrowed to, read back off the cart row.
 *
 * It rides in `cart_items.option_value_ids`, which is structurally free on a
 * composition row for the same reason `option_id` carries the composition key
 * (§5.1): `selectionFromCartRow` returns an EMPTY selection for a composition
 * row, so nothing downstream — not `resolveUnitPrice`, not `saleAvailability`,
 * not price protection — ever reads it. It is outside the
 * `UNIQUE (user_id, product_id, community_product_id, option_id, color_id,
 * shipping_method_id)` tuple, so `idx_cart_levonis_line` is untouched, and the
 * family is ALSO folded into the composition key, so two lines narrowed to two
 * families are two rows rather than one merged one.
 */
export const mysteryFamilyOf = (row: Record<string, unknown>): string =>
  safeParse<string[]>(String(row.option_value_ids ?? '[]'), []).filter((x) => typeof x === 'string')[0] ?? '';

/** The line-identity key of a mystery line (§5.1): the family when the admin
 *  opened family narrowing, a constant otherwise. The buyer explicitly does
 *  not choose the product, and each spool is drawn independently at checkout,
 *  so merging costs nothing and prevents a cart of forty identical rows. */
export const mysteryKeyInput = (familyId: string) => [
  { component_id: familyId, option_value_ids: [], color_id: '', included: true },
];

/**
 * Every mystery line of a cart, resolved in ONE pass, with each line's
 * availability replaced by its pool's verdict.
 *
 * The contexts are computed once and applied to every pricing basis, because
 * the pool does not care how the customer pays and re-running the candidate
 * query per basis would double the round trips for no different answer.
 */
export async function resolveCartMystery(
  db: D1Database,
  rows: Record<string, unknown>[],
  bundles: Map<string, ResolvedBundle>,
  nowMs = Date.now()
): Promise<Map<string, MysteryContext>> {
  const requests = [];
  for (const r of rows) {
    const key = String(r.cart_item_id ?? r.id);
    const b = bundles.get(key);
    if (!b || b.doc.composition !== 'mystery') continue;
    requests.push({
      key,
      bundle: b,
      familyId: mysteryFamilyOf(r),
      transportMethod: String(r.transport_method ?? ''),
    });
  }
  const ctxs = await resolveMysteryLines(db, requests, nowMs);
  applyMysteryToBundles(ctxs, bundles);
  return ctxs;
}

/** Puts the pool's verdict onto each resolved line, in place. Safe because
 *  `resolveCompositionLines` hands back a freshly built map every call. */
export function applyMysteryToBundles(
  ctxs: Map<string, MysteryContext>,
  bundles: Map<string, ResolvedBundle>
): void {
  for (const [key, ctx] of ctxs) {
    const b = bundles.get(key);
    if (b) bundles.set(key, withMysteryAvailability(b, ctx));
  }
}
