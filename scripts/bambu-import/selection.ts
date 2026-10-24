/**
 * WHAT THE PRODUCT PAGE SHOWS FOR A SELECTION (Bambu import spec §G.3, §C.4,
 * R6, §1 row 27), computed from the reviewed payload and the stored media: the
 * browser check (browser.ts) compares the live page with it, and the edge
 * evidence records the selections it checked.
 *
 * THE PAGE'S OWN CODE, NOT A COPY. The chooser and gallery rules are the
 * storefront's pure modules — src/lib/productChooser.ts (`importedChooser`,
 * `defaultSelection`, `valueOffered`, `chooseValue`) and src/lib/productGallery.ts
 * (`mediaInStoredOrder`, `galleryForSelection`, `contradictsSelection`) — fed
 * the payload's groups and variants and the gallery as written, the way
 * src/pages/Product.tsx feeds them the page body's relations:
 *
 *   - THE OPENING SELECTION is empty: the customer chooses, including
 *     single-value groups. Defaults still describe the imported catalogue.
 *   - A VALUE NOT OFFERED with the rest of the selection (it forms no variant
 *     with the other groups' choices) says so («غير متاح مع هذا الاختيار»,
 *     dimmed) and STAYS PRESSABLE: pressing it selects it and lets go of the
 *     other groups' values that clash with it, and a group left with exactly
 *     one fitting value takes it (`chooseValue`). Pressing the chosen value
 *     un-presses it — the check never does that.
 *   - THE GALLERY for the WHOLE selection: drop what the selection contradicts
 *     (on an imported product also a value forming no variant with the rest,
 *     never the selected value's own picture), rank the rest with the shared
 *     `productMediaForSelection`, de-duplicate by URL. The hero is one of the
 *     images tied at the best rank (the page's stable order among rows of one
 *     sort position is the database's, which the runner does not see).
 *
 * Pure.
 */
import { productMediaForSelection, productVariantIdForSelection } from '@levonis/pricing/productSelectionMedia';
import type { ImportPayload } from '@levonis/catalog/bambuImport/payload';
import {
  chooseValue,
  formsVariant as pageFormsVariant,
  importedChooser,
  valueOffered as pageValueOffered,
  type ChooserGroup,
} from '../../src/lib/productChooser';
import { contradictsSelection, galleryForSelection, mediaInStoredOrder, type GalleryModel } from '../../src/lib/productGallery';
import type { MediaAnswerRow } from './opsClient';

type Groups = ImportPayload['groups'];
type Variants = ImportPayload['variants'];

/** Do these values sit together in at least one variant? With no variant, any set does (the page's rule). */
export function formsVariant(valueIds: readonly string[], variants: Variants): boolean {
  return pageFormsVariant(valueIds, variants);
}

/** The payload's groups as the page's chooser reads them (Product.tsx keeps only groups with values). */
function chooserGroups(groups: Groups): ChooserGroup[] {
  return groups.filter((g) => g.values.length > 0);
}

/** Does the page draw this product with the import's chooser (a kind, a default or a swatch on a group)? */
export function importedPage(payload: Pick<ImportPayload, 'groups'>): boolean {
  return importedChooser(chooserGroups(payload.groups));
}

/**
 * Is `valueId` (of `groupId`) offered with the other groups' selected values? Always on a page without the
 * import's chooser (it marks nothing).
 */
export function valueOffered(valueId: string, groupId: string, selected: readonly string[], groups: Groups, variants: Variants): boolean {
  if (!importedChooser(chooserGroups(groups))) return true;
  return pageValueOffered(valueId, groupId, selected, chooserGroups(groups), variants);
}

/** Ordinary arrivals leave every option empty, even import defaults and single-value groups. */
export function pageDefaultSelection(_payload: Pick<ImportPayload, 'groups' | 'variants'>): string[] {
  return [];
}

/**
 * The selection once `valueId` of `groupId` is pressed — what the page's one handler does with it: on an imported
 * product `chooseValue` (the value is taken, clashing values of other groups let go, a group left with exactly one
 * fitting value takes it; the chosen value un-presses); otherwise the group's value toggles and the rest stay.
 */
export function pressValue(selected: readonly string[], groups: Groups, variants: Variants, groupId: string, valueId: string): string[] {
  const live = chooserGroups(groups);
  if (importedChooser(live)) return chooseValue(valueId, groupId, selected, live, variants);
  const was = selected.includes(valueId);
  return live.flatMap((g) => {
    if (g.id === groupId) return was ? [] : [valueId];
    const kept = g.values.find((v) => selected.includes(v.id))?.id;
    return kept ? [kept] : [];
  });
}

export interface ExpectedGallery {
  /** The gallery's URLs (`/files/…`), de-duplicated, in the order the page shows them. */
  order: string[];
  /** Every URL that may lead: the images tied at the best rank (the page's stable order picks one of them). */
  hero: Set<string>;
  /** URLs of images the selection contradicts that no other kept image carries: never on the page. */
  forbidden: Set<string>;
}

/** The rank `productMediaForSelection` gives a row (packages/pricing/src/productSelectionMedia.ts mediaRank). */
function rankOf(m: { variant_id?: string | null; option_value_id?: string | null; primary?: boolean }, selection: readonly string[], variantId: string | null): number {
  if (variantId && m.variant_id === variantId) return 0;
  if (m.option_value_id && selection.includes(m.option_value_id)) return 200;
  if (m.primary) return 300;
  if (!m.variant_id && !m.option_value_id) return 400;
  return 500;
}

/**
 * The gallery the page shows for `selection` (§G.3, R6). `images` are the rows as WRITTEN (gallery.ts: after the
 * Worker's content-duplicate collapse), never the payload's pre-collapse list.
 */
export function expectedGallery(
  payload: { groups: Groups; variants: Variants; images: readonly ImportPayload['images'][number][] },
  media: ReadonlyMap<string, MediaAnswerRow>,
  selection: readonly string[]
): ExpectedGallery {
  const urlOf = (id: string) => {
    const m = media.get(id);
    return m && m.status === 'stored' && m.r2_key ? `/files/${m.r2_key}` : '';
  };
  // The page body's media rows in stored order (Product.tsx storedMedia → mediaInStoredOrder), one per image row,
  // each carrying its own binding (the relations images: the same rows by id).
  const rows = mediaInStoredOrder(
    payload.images
      .map((i) => ({
        id: i.id,
        url: urlOf(i.source_media_id),
        primary: i.is_primary,
        order: i.sort_order,
        option_value_id: i.option_value_id,
        variant_id: i.variant_id,
        via_variant_id: i.via_variant_id,
        color_id: null,
      }))
      .filter((r) => r.url)
  );
  const groups = chooserGroups(payload.groups);
  const model: GalleryModel = { groups, variants: payload.variants, completeVariants: importedChooser(groups) };
  const variantId = productVariantIdForSelection(payload.variants, { optionValueIds: selection });
  const sel = { optionValueIds: selection, variantId };
  const order = galleryForSelection(rows, rows, model, sel).map((m) => m.url);
  if (selection.length === 0) return { order, hero: new Set(order.slice(0, 1)), forbidden: new Set() };
  const kept = rows.filter((r) => !contradictsSelection(r, model, sel));
  const pool = kept.length ? kept : rows;
  const ranked = productMediaForSelection(pool, sel);
  const best = ranked.length ? rankOf(ranked[0], selection, variantId) : 0;
  const hero = new Set(ranked.filter((r) => rankOf(r, selection, variantId) === best).map((r) => r.url));
  const keptUrls = new Set(pool.map((r) => r.url));
  const forbidden = new Set(pool === rows ? [] : rows.filter((r) => !keptUrls.has(r.url)).map((r) => r.url));
  return { order, hero, forbidden };
}
