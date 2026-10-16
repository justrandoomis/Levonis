/**
 * THE PICTURE A CARD LEADS WITH — src/lib/productImage.ts
 * `productPrimaryImage` on the server's own card: its explicit primary, else
 * the first published image, else the first media by order; with the card's
 * light-theme main image (migration 0138) when it differs. Read off the CARD,
 * never the row: the card is what the storefront draws, after the relational
 * image overlay (worker/routes/products.ts `resolveProductCards`).
 *
 * For the places that borrow a product's photograph without its card: the
 * category map's sections (worker/routes/catalog.ts `assignTreePhotos`) and
 * the explorer's graded banner (`GET /api/home/graded`).
 */
export function cardLeadPhoto(card: Record<string, unknown>): { src: string; light?: string } | null {
  const media = Array.isArray(card.media) ? (card.media as Array<{ url?: unknown; primary?: unknown; order?: unknown }>) : [];
  const url = (m: { url?: unknown } | undefined) => (m && typeof m.url === 'string' ? m.url : '');
  let src = url(media.find((m) => m?.primary && url(m)));
  if (!src && Array.isArray(card.images)) src = (card.images as unknown[]).find((u): u is string => typeof u === 'string' && u.length > 0) ?? '';
  if (!src) src = url([...media].filter((m) => url(m)).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))[0]);
  if (!src) return null;
  const light = typeof card.light_image === 'string' ? card.light_image.trim() : '';
  return light && light !== src ? { src, light } : { src };
}
