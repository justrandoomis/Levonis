/**
 * WHERE A SEARCH RESULT OPENS, WITH WHAT IT MATCHED ALREADY CHOSEN (smart
 * search 1.7, the assistant plan §6 «Result cards»).
 *
 * The listing names, per product, the selection its codes and sizes matched
 * (`matched`: «10101» is one colour of PLA Basic, «0.4» one nozzle size). The
 * card link carries it as `?v=`, the canonical combination key every SKU is
 * stored under (`o:<value>|…|c:<colour>`, packages/pricing/src/skuChannel.ts
 * `skuComboKey`), so the product page opens on that colour or option. The
 * page reads it as untrusted input (src/components/product/priceRequestState.ts
 * `linkedSelection`): only ids the product owns are chosen, and the price
 * comes from the quote for that selection, never from the link.
 *
 * The parameter stays in the address: a copied or shared link opens on the
 * same variant. A bundle opens at /bundles and has no selection to carry.
 *
 * Pure, and imported only by ./searchKit.tsx, so it rides in that lazy chunk.
 */

/** The query parameter the product page decodes. */
export const VARIANT_PARAM = 'v';

export interface LinkSelection {
  option_value_ids: readonly string[];
  color_id: string | null;
}

/** The canonical key of a selection: sorted option values, then the colour. '' for nothing. */
export function selectionParam(sel: LinkSelection): string {
  const parts = [...sel.option_value_ids].filter(Boolean).sort().map((id) => `o:${id}`);
  if (sel.color_id) parts.push(`c:${sel.color_id}`);
  return parts.join('|');
}

/** A product link with the matched selection, or the link unchanged when there is none to carry. */
export function linkWithSelection(href: string, sel: LinkSelection | null | undefined): string {
  if (!sel || !href.startsWith('/product/')) return href;
  const v = selectionParam(sel);
  return v ? `${href}?${VARIANT_PARAM}=${encodeURIComponent(v)}` : href;
}
