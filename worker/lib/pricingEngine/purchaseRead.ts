/**
 * A PURCHASE AS THE PRICING READS IT (USD design §3.1, §6.3): an unsaved draft
 * parsed by the purchase POST's own parser (worker/lib/procurementDraft.ts),
 * or a SAVED purchase's committed lines and charges. Reads purchase rows only;
 * never writes one (USD design §7.1 G2).
 */
import { procurementSelectionKey } from '@levonis/contracts/procurementCost';
import { productSelections, type Selection } from '../inventorySelection';
import { engineColumnInstalled } from '../engineInstalled';
import type { ParsedDraft } from '../procurementDraft';
import type { PurchaseForPricing, PurchaseLineForPricing } from './fromPurchase';

type PricingStatus = PurchaseForPricing['status'];
const STATUSES: readonly PricingStatus[] = ['draft', 'ordered', 'partial', 'received', 'cancelled'];

/**
 * An UNSAVED draft as the pricing preview reads it: the status it will be
 * saved with (the confirm saves 'ordered'), its lines in the order typed, and
 * each charge's role and shares as the save would store them.
 */
export function draftForPricing(parsed: ParsedDraft, b: Record<string, unknown>, purchaseId: string | null): PurchaseForPricing {
  return {
    purchase_id: purchaseId,
    status: b.status === 'draft' ? 'draft' : 'ordered',
    cost_state: b.cost_state === 'final' ? 'final' : 'estimated',
    currency: parsed.currency,
    exchange_rate: parsed.rate,
    profile: parsed.profile ? { id: parsed.profile.id, shipping_basis: parsed.profile.shipping_basis } : null,
    lines: parsed.lines.map((l, index) => ({
      index,
      line_id: null,
      key: l.key,
      product_id: l.sel.product_id,
      scope: (['base', 'option', 'color', 'variant'] as const).find((s) => s === l.sel.scope) ?? 'base',
      scope_id: l.sel.scope_id,
      option_id: l.sel.option_id ?? null,
      label: l.sel.label,
      qty: l.qty,
      cost_mode: l.costMode,
      source_amount: l.costMode === 'total' ? (l.sourceTotal ?? l.source * l.qty) : l.source,
      weight_g: l.weight,
      volume_mm3: l.volume,
      store_price_iqd: Number.isSafeInteger(l.sel.selling_price_iqd) ? l.sel.selling_price_iqd : null,
    })),
    charges: parsed.charges.map((c, j) => ({
      title: c.title,
      pricing_role: c.pricing_role,
      shares: parsed.lines.flatMap((l, i) => (!c.applies_to || c.applies_to.includes(l.key) ? [{ index: i, amount_iqd: parsed.shares[j]![i]! }] : [])),
    })),
  };
}

/**
 * A SAVED purchase as the pricing apply reads it: its committed lines (in their
 * stored order) and charges with the shares the save stored. Reads only; null
 * when there is no such purchase. A charge row from before 0181 (or a manual
 * document) has no pricing role and never feeds.
 */
export async function committedPurchaseForPricing(db: D1Database, id: string): Promise<PurchaseForPricing | null> {
  const p = await db
    .prepare('SELECT id, status, cost_state, currency, exchange_rate, cost_profile_id, shipping_basis FROM purchase_orders WHERE id = ?')
    .bind(id)
    .first<{ id: string; status: string; cost_state: string; currency: string; exchange_rate: number; cost_profile_id: string | null; shipping_basis: string | null }>();
  if (!p) return null;
  const withRole = await engineColumnInstalled(db, 'purchase_charges', 'pricing_role');
  const [lines, charges] = await db.batch([
    db
      .prepare(
        `SELECT l.id AS line_id, l.label, l.source_unit_amount, l.source_total_amount, l.purchase_cost_mode, l.weight_g, l.volume_mm3,
                i.product_id, i.scope, i.scope_id, i.qty_ordered
           FROM purchase_lines l JOIN incoming_inventory i ON i.id = l.incoming_id WHERE l.purchase_id = ? ORDER BY l.id`
      )
      .bind(id),
    db.prepare(`SELECT title, allocation_json${withRole ? ', pricing_role' : ''} FROM purchase_charges WHERE purchase_id = ? ORDER BY COALESCE(position, 2147483647), id`).bind(id),
  ]);
  type LineRow = { line_id: string; label: string; source_unit_amount: number; source_total_amount: number | null; purchase_cost_mode: string | null; weight_g: number; volume_mm3: number; product_id: string | null; scope: string; scope_id: string; qty_ordered: number };
  type ChargeRow = { title: string; allocation_json: string | null; pricing_role?: string | null };
  const lineRows = ((lines as D1Result<LineRow>).results ?? []) as LineRow[];
  const chargeRows = ((charges as D1Result<ChargeRow>).results ?? []) as ChargeRow[];
  const selections = new Map<string, Selection[]>();
  const selectionOf = async (productId: string, scope: string, scopeId: string): Promise<Selection | null> => {
    if (!selections.has(productId)) {
      try {
        selections.set(productId, await productSelections(db, productId));
      } catch {
        selections.set(productId, []);
      }
    }
    return selections.get(productId)!.find((s) => s.scope === scope && s.scope_id === (scope === 'base' ? '' : scopeId)) ?? null;
  };
  const out: PurchaseLineForPricing[] = [];
  for (const [index, l] of lineRows.entries()) {
    if (!l.product_id) continue;
    const sel = await selectionOf(l.product_id, l.scope, l.scope_id);
    const mode = l.purchase_cost_mode === 'total' ? 'total' : 'unit';
    out.push({
      index,
      line_id: l.line_id,
      key: procurementSelectionKey({ product_id: l.product_id, scope: l.scope, scope_id: l.scope_id }),
      product_id: l.product_id,
      scope: (['base', 'option', 'color', 'variant'] as const).find((s) => s === l.scope) ?? 'base',
      scope_id: l.scope_id ?? '',
      option_id: sel?.option_id ?? (l.scope === 'option' ? l.scope_id : null),
      label: l.label,
      qty: Number(l.qty_ordered),
      cost_mode: mode,
      source_amount: mode === 'total' ? Number(l.source_total_amount ?? Number(l.source_unit_amount) * Number(l.qty_ordered)) : Number(l.source_unit_amount),
      weight_g: Number(l.weight_g ?? 0),
      volume_mm3: Number(l.volume_mm3 ?? 0),
      store_price_iqd: sel && Number.isSafeInteger(sel.selling_price_iqd) ? sel.selling_price_iqd : null,
    });
  }
  const indexOfLine = new Map(lineRows.map((l, i) => [l.line_id, i]));
  const profileId = p.cost_profile_id === 'germany_land' || p.cost_profile_id === 'china_air' || p.cost_profile_id === 'china_sea' ? p.cost_profile_id : null;
  return {
    purchase_id: p.id,
    status: STATUSES.find((s) => s === p.status) ?? 'draft',
    cost_state: p.cost_state === 'final' ? 'final' : 'estimated',
    currency: p.currency,
    exchange_rate: Number(p.exchange_rate),
    profile: profileId ? { id: profileId, shipping_basis: p.shipping_basis === 'volume' ? 'volume' : 'weight' } : null,
    lines: out,
    charges: chargeRows.map((c) => {
      let shares: Array<{ line_id: string; amount_iqd: number }> = [];
      try {
        const parsed = JSON.parse(c.allocation_json ?? '[]');
        if (Array.isArray(parsed)) shares = parsed.filter((s) => s && typeof s.line_id === 'string' && Number.isSafeInteger(s.amount_iqd));
      } catch {
        shares = [];
      }
      return {
        title: c.title,
        pricing_role: profileId && (c.pricing_role === 'additional' || c.pricing_role === 'excluded') ? c.pricing_role : null,
        shares: shares.flatMap((s) => (indexOfLine.has(s.line_id) ? [{ index: indexOfLine.get(s.line_id)!, amount_iqd: s.amount_iqd }] : [])),
      };
    }),
  };
}
