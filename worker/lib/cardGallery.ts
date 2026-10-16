/**
 * A CARD CARRIES ITS PICTURE, NOT THE PRODUCT'S GALLERY.
 *
 * THE DEFECT (speed audit 2026-10-16, findings 7 and 21). `CARD_FIELDS`
 * (worker/routes/products.ts) copied `media` and `images` whole, so every card
 * of every list answer — `/api/products`, the listing, the catalog shelves,
 * `/api/home`, live search, the printer finder — shipped the product's entire
 * gallery: every picture with seventeen keys (three alt texts, the storage
 * key, byte size, content type, the option / colour / variant it is bound
 * to, …) plus the same URLs again in `images`. A card draws ONE picture. On
 * the live catalogue that was 148 KB of the 165 KB `/api/products?limit=50`
 * answer (26 KB → about 5 KB on the wire), one Bambu filament alone carrying
 * 31 gallery entries, and it grows with every imported product.
 *
 * WHICH PICTURE. The one every card reader already chooses, chosen here by the
 * same rule, so no card, tile, banner or old cached bundle can change its
 * picture:
 *   - `productPrimaryImage` (src/lib/productImage.ts; ProductCard, the
 *     listing rows, live search, the home rails, the finder): the media entry
 *     marked primary, else the first published `images` URL, else the
 *     lowest-order entry — `cardLeadUrl` below is that function, step for step;
 *   - `photoOf` (src/lib/catalog/explorerModel.ts; the category banners):
 *     the primary entry, else the first entry, else `images` — the same file,
 *     because the projection publishes the gallery primary-first and `images`
 *     in the gallery's order (worker/lib/productModel.ts `projectPublic`);
 *   - `images[0]` (src/pages/Profile.tsx, the project composer): the same file;
 *   - the public API's `cardImage` (worker/lib/publicApi/common.ts): the
 *     first entry — primaries first — whose file `/files` serves to anyone.
 *     When the lead picture is NOT such a file, the first entry that is rides
 *     along as a second entry, so the API's `image` (url, width, height and
 *     the three alt texts) is the one it published before, in every case.
 *
 * WHAT THE ENTRY KEEPS. `CARD_MEDIA_KEYS`: what those readers read (url,
 * primary, order; width, height and the alt texts for the public API) and the
 * entry's id, which the client type names. Nothing a card never reads — not
 * the storage key, the byte size, the content type, the role, the
 * option / colour / variant binding, or `source_url` (always '' in public
 * answers already).
 *
 * The product PAGE is untouched: it reads its own detail answer, which still
 * carries the whole gallery.
 */
import { publicMediaUrl } from './publicApi/urls';

/** The keys a card's picture entry keeps, in this order. */
export const CARD_MEDIA_KEYS = ['id', 'url', 'primary', 'order', 'width', 'height', 'alt_ar', 'alt_en', 'alt_ckb'] as const;

type Entry = Record<string, unknown>;

const isEntry = (m: unknown): m is Entry => !!m && typeof m === 'object' && !Array.isArray(m);
const urlOf = (m: Entry): string => (typeof m.url === 'string' ? m.url : '');
const orderOf = (m: Entry): number => (typeof m.order === 'number' && Number.isFinite(m.order) ? m.order : 0);
/** The public API's own predicate (`urls.media`): a file `/files` serves to an anonymous visitor. */
const isPublicFile = (url: string): boolean => publicMediaUrl('', url) !== null;

/**
 * The picture a card shows — src/lib/productImage.ts `productPrimaryImage`,
 * the same three steps in the same order (tests/cardGallery.test.ts holds the
 * two equal).
 */
export function cardLeadUrl(media: readonly unknown[], images: readonly unknown[]): string {
  const entries = media.filter(isEntry);
  const explicit = entries.find((m) => m.primary && urlOf(m));
  if (explicit) return urlOf(explicit);
  const published = images.find((u): u is string => typeof u === 'string' && u.length > 0);
  if (published) return published;
  const first = entries.filter((m) => !!urlOf(m)).sort((a, b) => orderOf(a) - orderOf(b))[0];
  return first ? urlOf(first) : '';
}

function pickEntry(m: Entry): Entry {
  const out: Entry = {};
  for (const k of CARD_MEDIA_KEYS) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

/**
 * A product's published gallery (`media`, `images`) → the card's: the lead
 * picture's entry and URL only (plus, rarely, the public API's picture — see
 * the header). An empty gallery stays empty.
 */
export function cardGallery(media: unknown, images: unknown): { media: Entry[]; images: string[] } {
  const entries = Array.isArray(media) ? media.filter(isEntry) : [];
  const urls = Array.isArray(images) ? images : [];
  const lead = cardLeadUrl(entries, urls);
  if (!lead) return { media: [], images: [] };
  const leadEntry = entries.find((m) => m.primary && urlOf(m) === lead) ?? entries.find((m) => urlOf(m) === lead);
  const kept: Entry[] = leadEntry ? [leadEntry] : [];
  if (!isPublicFile(lead)) {
    const forApi = [...entries.filter((m) => m.primary), ...entries].find((m) => isPublicFile(urlOf(m)));
    if (forApi && forApi !== leadEntry) kept.push(forApi);
  }
  const keptUrls = kept.map(urlOf).filter((u) => u && u !== lead);
  return { media: kept.map(pickEntry), images: [lead, ...keptUrls] };
}
