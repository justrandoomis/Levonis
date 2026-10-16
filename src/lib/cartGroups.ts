/**
 * SEVERAL COLOURS OF ONE PRODUCT ARE ONE GROUP (docs/ux/COLOUR-QUANTITIES.md §5.2, §6).
 *
 * «50 black, 5 white, 1 beige» is three cart lines, and the cart and the
 * checkout drew them as three unrelated products, each with the same photo
 * and name, the colour a grey word at the end of a label. Grouped, the
 * product is said once and every colour is a line under it — which is how the
 * customer thought of the order.
 *
 * Pure, so the cart and the checkout group by the same rule:
 *
 *   · two or more ORDINARY lines of one product form a group — never a gift,
 *     a bundle or a mystery line (each is its own thing), and never a store
 *     line (those live in their own cart);
 *   · a group sits where its FIRST line sits in the server's order, so an add
 *     never reshuffles the other groups;
 *   · inside a group the lines follow the product's own colour order, then the
 *     options label.
 */

export interface GroupableLine {
  id: string;
  productId: string;
  kind?: string;
  /** Present on a store line. */
  seller_type?: string;
  color_id?: string;
  colors?: Array<{ id: string }> | null;
  options_label?: string;
  variantLabel?: string;
}

export type CartEntry<L extends GroupableLine> =
  | { kind: 'line'; item: L }
  | { kind: 'group'; productId: string; items: L[] };

const groupable = (line: GroupableLine) =>
  !!line.productId && !line.kind && (line.seller_type ?? 'levonis') !== 'merchant';

export function groupCartLines<L extends GroupableLine>(items: readonly L[]): CartEntry<L>[] {
  const counts = new Map<string, number>();
  for (const it of items) if (groupable(it)) counts.set(it.productId, (counts.get(it.productId) ?? 0) + 1);
  const out: CartEntry<L>[] = [];
  const placed = new Map<string, { kind: 'group'; productId: string; items: L[] }>();
  for (const it of items) {
    if (!groupable(it) || (counts.get(it.productId) ?? 0) < 2) {
      out.push({ kind: 'line', item: it });
      continue;
    }
    const existing = placed.get(it.productId);
    if (existing) {
      existing.items.push(it);
      continue;
    }
    const group = { kind: 'group' as const, productId: it.productId, items: [it] };
    placed.set(it.productId, group);
    out.push(group);
  }
  for (const group of placed.values()) {
    const order = new Map((group.items[0].colors ?? []).map((c, i) => [c.id, i] as const));
    const rank = (l: L) => (l.color_id && order.has(l.color_id) ? order.get(l.color_id)! : Number.MAX_SAFE_INTEGER);
    // A stable sort: lines of one colour (several options) keep their options label order.
    group.items.sort((a, b) => rank(a) - rank(b) || String(a.options_label ?? a.variantLabel ?? '').localeCompare(String(b.options_label ?? b.variantLabel ?? '')));
  }
  return out;
}
