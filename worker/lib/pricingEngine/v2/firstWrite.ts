/**
 * PRICING V2 — A PRODUCT'S FIRST V2 WRITE (the clean start: the owner's answer
 * Q6, DECISIONS row 222; implementation spec addendum A.7).
 *
 * Every product that exists before the release has no V2 method: it is
 * «يحتاج تسعيرًا» and is opened, priced in section ٣ and published like a new
 * one. Its first V2 evaluation is PREFILLED from what is not old dinar
 * pricing — the 0181 cost inputs already stored (they are read as they are),
 * the product's minimum profit, the central rates and freight, and the 0186
 * stock-purchase overlay of a direct-only product FOLDED into the ordinary
 * inputs (D1: a confirmed purchase is the product's current cost). Never an
 * old dinar price, a member price, a compare-at price, a Direct Sale Extra, a
 * route surcharge or a legacy cost cell.
 *
 * The complete first write also retires, in the same batch, the rows V2 never
 * reads and nothing may read again for this product: its Direct Sale Extra
 * rules and its purchase overlay (the deploy's archive, migration 0190, keeps
 * them). `pricing_sku_costs` is emptied by every V2 write already.
 *
 * PRIVATE: the inputs are the owner's; nothing here is logged.
 */
import { directPurchaseStore } from '../directPurchase';
import { INPUT_FIELD_NAMES, ownerRow, type InputFields, type InputScope, type InputWrite, type ProductPricingData } from '../store';

/**
 * D1 on a product still in «يحتاج تسعيرًا» (addendum A.10: "a needs-pricing
 * product's review feeds its prefill"): the product's newest PENDING purchase
 * review — the cost inputs a confirmed stock purchase implies. It is laid over
 * the prefill the OWNER prices from (never an editor's: an editor never reads
 * or writes a cost), and the owner's first complete V2 write marks it
 * `applied` in the same batch: the owner reviewed the resulting prices on
 * that write's own sheet. Null on a database before 0190 or when none waits.
 */
export interface FirstWriteReview {
  id: string;
  inputs: ReadonlyArray<{ scope: InputScope; scope_id: string; set: Partial<InputFields>; source_ref: string }>;
}

export async function pendingReviewOf(db: D1Database, productId: string): Promise<FirstWriteReview | null> {
  let row: { id: string; inputs_json: string } | null;
  try {
    row = await db
      .prepare("SELECT id, inputs_json FROM pricing_v2_purchase_reviews WHERE product_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1")
      .bind(productId)
      .first<{ id: string; inputs_json: string }>();
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
  if (!row) return null;
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(row.inputs_json);
  } catch {
    parsed = [];
  }
  const scopes: readonly string[] = ['base', 'option', 'color', 'sku'];
  const inputs = (Array.isArray(parsed) ? parsed : []).filter(
    (i): i is FirstWriteReview['inputs'][number] =>
      !!i && typeof i === 'object' && scopes.includes((i as { scope?: unknown }).scope as string) && typeof (i as { scope_id?: unknown }).scope_id === 'string' && !!(i as { set?: unknown }).set && typeof (i as { set?: unknown }).set === 'object'
  );
  return { id: row.id, inputs };
}

/** The review's writes over the stored set (a scope the product no longer has is dropped). */
export function reviewFoldInputs(stored: ProductPricingData, review: FirstWriteReview | null | undefined, live: (scope: Exclude<InputScope, 'base'>, id: string) => boolean): InputWrite[] {
  if (!review) return [];
  const known = new Set<string>(INPUT_FIELD_NAMES);
  return review.inputs
    .filter((i) => i.scope === 'base' || live(i.scope, i.scope_id))
    .map((i) => ({
      scope: i.scope,
      scope_id: i.scope_id,
      existing: ownerRow(stored.inputs, i.scope, i.scope_id),
      set: Object.fromEntries(Object.entries(i.set).filter(([k]) => known.has(k))) as Partial<InputFields>,
      source_ref: typeof i.source_ref === 'string' && i.source_ref ? i.source_ref : 'purchase',
    }))
    .filter((w) => Object.keys(w.set).length > 0);
}

/** A direct-only product's purchase overlay folded into the ordinary inputs: one write per scope it changes. */
export function firstWriteInputs(stored: ProductPricingData): InputWrite[] {
  if (!stored.direct_purchase || !stored.direct_purchase.inputs.length) return [];
  const merged = directPurchaseStore(stored);
  const writes: InputWrite[] = [];
  for (const m of merged.inputs) {
    if (m.origin !== 'MANUAL_OVERRIDE') continue;
    const existing = ownerRow(stored.inputs, m.scope, m.scope_id);
    const set: Partial<InputFields> = {};
    for (const k of INPUT_FIELD_NAMES) {
      const next = (m as unknown as Record<string, unknown>)[k] ?? null;
      if (((existing as unknown as Record<string, unknown> | null)?.[k] ?? null) !== next) (set as Record<string, unknown>)[k] = next;
    }
    if (Object.keys(set).length) writes.push({ scope: m.scope, scope_id: m.scope_id, existing, set, source_ref: 'purchase' });
  }
  return writes;
}

/**
 * The prefill under the request's own input writes: a scope both name is one
 * write, the request's fields over the fold's (the reader's typing wins).
 */
export function withFirstWriteInputs(fold: readonly InputWrite[], own: readonly InputWrite[]): InputWrite[] {
  if (!fold.length) return [...own];
  const key = (w: InputWrite) => `${w.scope}\u0000${w.scope_id ?? ''}`;
  const out = new Map<string, InputWrite>(fold.map((w) => [key(w), { ...w, set: { ...w.set } }]));
  for (const w of own) {
    const at = out.get(key(w));
    out.set(key(w), at ? { ...w, set: { ...at.set, ...w.set } } : w);
  }
  return [...out.values()];
}

/**
 * The rows a complete first write retires (inside the V2 batch, after the owner's data, before the prices),
 * and — `review`, only when the owner's write folded it — the pending purchase review it applied.
 */
export function firstWriteStatements(db: D1Database, stored: ProductPricingData, review?: { id: string; actor: string; now: string } | null): D1PreparedStatement[] {
  const pid = stored.product_id;
  const dse = stored.rules.some((r) => r.product_id === pid && r.kind === 'direct_sale_extra');
  return [
    ...(dse ? [db.prepare("DELETE FROM pricing_rules WHERE product_id = ? AND kind = 'direct_sale_extra'").bind(pid)] : []),
    ...(stored.direct_purchase ? [db.prepare('DELETE FROM pricing_direct_purchase WHERE product_id = ?').bind(pid)] : []),
    ...(review
      ? [
          db
            .prepare("UPDATE pricing_v2_purchase_reviews SET state = 'applied', decided_at = ?, decided_by = ? WHERE id = ? AND product_id = ? AND state = 'pending'")
            .bind(review.now, review.actor, review.id, pid),
        ]
      : []),
  ];
}

/** The review a write's first-write retirement marks applied: the owner's, when one was folded into its prefill. */
export const foldedReviewOf = (read: { review?: FirstWriteReview | null }, viewer: string, actor: string, now: string) =>
  viewer === 'owner' && read.review ? { id: read.review.id, actor, now } : null;
