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
import { mergedInputs, openSeedFields } from '../fromPurchase';
import { INPUT_FIELD_NAMES, ownerRow, type InputFields, type InputScope, type InputWrite, type IqdSnapshot, type ProductPricingData } from '../store';

/**
 * D1 on a product still in «يحتاج تسعيرًا» (addendum A.10: "a needs-pricing
 * product's review feeds its prefill"): the product's PENDING purchase
 * reviews — the cost inputs its confirmed stock purchases imply, one per
 * purchase (DECISIONS row 249: purchases of different models or colours each
 * keep their own), folded oldest first so a later purchase's field wins. They
 * are laid over the prefill the OWNER prices from (never an editor's: an
 * editor never reads or writes a cost), and the owner's first complete V2
 * write marks every folded review `applied` in the same batch: the owner
 * reviewed the resulting prices on that write's own sheet. Null on a database
 * before 0190 or when none waits.
 */
export interface FirstWriteReview {
  /** The newest folded review (the prefill names it). */
  id: string;
  /** Every folded review, oldest first. */
  ids: readonly string[];
  /** The reviews' inputs, oldest review first. */
  inputs: ReadonlyArray<{ scope: InputScope; scope_id: string; set: Partial<InputFields>; source_ref: string; iqd?: IqdSnapshot; seed?: boolean }>;
}

export async function pendingReviewsOf(db: D1Database, productId: string): Promise<FirstWriteReview | null> {
  let rows: Array<{ id: string; inputs_json: string }>;
  try {
    rows =
      (
        await db
          .prepare("SELECT r.id, r.inputs_json FROM pricing_v2_purchase_reviews r WHERE r.product_id = ? AND r.state = 'pending' AND NOT EXISTS (SELECT 1 FROM purchase_orders p WHERE p.id = r.purchase_id AND p.status NOT IN ('ordered','partial','received')) ORDER BY r.created_at, r.id")
          .bind(productId)
          .all<{ id: string; inputs_json: string }>()
      ).results ?? [];
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
  if (!rows.length) return null;
  const scopes: readonly string[] = ['base', 'option', 'color', 'sku'];
  const inputs: Array<FirstWriteReview['inputs'][number]> = [];
  for (const row of rows) {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(row.inputs_json);
    } catch {
      parsed = [];
    }
    inputs.push(
      ...(Array.isArray(parsed) ? parsed : []).filter(
        (i): i is FirstWriteReview['inputs'][number] =>
          !!i && typeof i === 'object' && scopes.includes((i as { scope?: unknown }).scope as string) && typeof (i as { scope_id?: unknown }).scope_id === 'string' && !!(i as { set?: unknown }).set && typeof (i as { set?: unknown }).set === 'object'
      )
    );
  }
  return { id: rows[rows.length - 1]!.id, ids: rows.map((r) => r.id), inputs };
}

/**
 * The reviews' writes over the stored set, one write per scope (a later review's field wins; a scope
 * the product no longer has is dropped). A dinar purchase's conversion travels with its supplier cost.
 * A SEED (row 249: a colour or variant line's figures offered to its empty broader level) lands only where
 * neither the stored set nor an earlier folded review already gives that level a value (`openSeedFields`),
 * so two colours bought at two costs each keep their own and the product takes the first.
 */
export function reviewFoldInputs(stored: ProductPricingData, review: FirstWriteReview | null | undefined, live: (scope: Exclude<InputScope, 'base'>, id: string) => boolean): InputWrite[] {
  if (!review) return [];
  const known = new Set<string>(INPUT_FIELD_NAMES);
  const out = new Map<string, InputWrite>();
  for (const raw of review.inputs) {
    if (raw.scope !== 'base' && !live(raw.scope, raw.scope_id)) continue;
    const i = raw.seed ? openSeedFields(mergedInputs(stored.inputs, [...out.values()]), raw) : raw;
    if (!i) continue;
    const set = Object.fromEntries(Object.entries(i.set).filter(([k]) => known.has(k))) as Partial<InputFields>;
    if (!Object.keys(set).length) continue;
    const key = `${i.scope}\u0000${i.scope === 'base' ? '' : i.scope_id}`;
    const at = out.get(key);
    const supplier = 'supplier_cost_amount' in set;
    const iqd = supplier ? i.iqd : at?.iqd;
    out.set(key, {
      scope: i.scope,
      scope_id: i.scope_id,
      existing: ownerRow(stored.inputs, i.scope, i.scope_id),
      set: { ...(at?.set ?? {}), ...set },
      source_ref: typeof i.source_ref === 'string' && i.source_ref ? i.source_ref : 'purchase',
      ...(iqd ? { iqd } : {}),
    });
  }
  return [...out.values()];
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

/** The fields of a supplier cost: a write naming any of them replaces the fold's (and its dinar conversion). */
const SUPPLIER_FIELDS = ['supplier_cost_amount', 'supplier_cost_delta', 'supplier_cost_currency'] as const;

/**
 * The prefill under the request's own input writes: a scope both name is one
 * write, the request's fields over the fold's (the reader's typing wins). The
 * fold's dinar conversion (`iqd`) stays with its supplier cost unless the
 * request's write touches that cost (its own conversion, when it has one, wins):
 * a weight edit at the same scope never turns the purchase's dinars into USD.
 */
export function withFirstWriteInputs(fold: readonly InputWrite[], own: readonly InputWrite[]): InputWrite[] {
  if (!fold.length) return [...own];
  const key = (w: InputWrite) => `${w.scope}\u0000${w.scope_id ?? ''}`;
  const out = new Map<string, InputWrite>(fold.map((w) => [key(w), { ...w, set: { ...w.set } }]));
  for (const w of own) {
    const at = out.get(key(w));
    if (!at) {
      out.set(key(w), w);
      continue;
    }
    const supplierTouched = SUPPLIER_FIELDS.some((k) => k in w.set);
    const iqd = w.iqd ?? (supplierTouched ? undefined : at.iqd);
    const merged: InputWrite = { ...w, set: { ...at.set, ...w.set } };
    if (iqd) merged.iqd = iqd;
    else delete merged.iqd;
    out.set(key(w), merged);
  }
  return [...out.values()];
}

/**
 * The rows a complete first write retires (inside the V2 batch, after the owner's data, before the prices),
 * and — `review`, only when the owner's write folded them — the pending purchase reviews it applied.
 */
export function firstWriteStatements(db: D1Database, stored: ProductPricingData, review?: { ids: readonly string[]; actor: string; now: string } | null): D1PreparedStatement[] {
  const pid = stored.product_id;
  const dse = stored.rules.some((r) => r.product_id === pid && r.kind === 'direct_sale_extra');
  return [
    ...(dse ? [db.prepare("DELETE FROM pricing_rules WHERE product_id = ? AND kind = 'direct_sale_extra'").bind(pid)] : []),
    ...(stored.direct_purchase ? [db.prepare('DELETE FROM pricing_direct_purchase WHERE product_id = ?').bind(pid)] : []),
    ...(review?.ids ?? []).map((id) =>
      db
        .prepare("UPDATE pricing_v2_purchase_reviews SET state = 'applied', decided_at = ?, decided_by = ? WHERE id = ? AND product_id = ? AND state = 'pending'")
        .bind(review!.now, review!.actor, id, pid)
    ),
  ];
}

/** The review a write's first-write retirement marks applied: the owner's, when one was folded into its prefill. */
export const foldedReviewOf = (read: { review?: FirstWriteReview | null }, viewer: string, actor: string, now: string) =>
  viewer === 'owner' && read.review ? { ids: read.review.ids, actor, now } : null;
