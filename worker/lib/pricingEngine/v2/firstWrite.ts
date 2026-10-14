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
import { INPUT_FIELD_NAMES, ownerRow, type InputFields, type InputWrite, type ProductPricingData } from '../store';

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

/** The rows a complete first write retires (inside the V2 batch, after the owner's data, before the prices). */
export function firstWriteStatements(db: D1Database, stored: ProductPricingData): D1PreparedStatement[] {
  const pid = stored.product_id;
  const dse = stored.rules.some((r) => r.product_id === pid && r.kind === 'direct_sale_extra');
  return [
    ...(dse ? [db.prepare("DELETE FROM pricing_rules WHERE product_id = ? AND kind = 'direct_sale_extra'").bind(pid)] : []),
    ...(stored.direct_purchase ? [db.prepare('DELETE FROM pricing_direct_purchase WHERE product_id = ?').bind(pid)] : []),
  ];
}
