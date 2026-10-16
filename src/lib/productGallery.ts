/**
 * THE GALLERY FOR A SELECTION (the Bambu import spec §G.3, §C.4; the brief's
 * R6: «for an explicit selection, show that selection's images and the general
 * ones, and never an image bound to another value of a chosen group»).
 *
 * Pure: the product page hands it every media row in stored order (one entry
 * per `product_images` row — a picture bound to five printers is five rows of
 * one URL), the bindings the page body's relations carry, the option model
 * (groups and `variants[].combo_key`) and the current selection.
 *
 *   1. DROP CONTRADICTING IMAGES. While a selection exists, leave out every
 *      image bound to a value of a group in which another value is selected;
 *      bound to a variant whose `combo_key` contains such a value; bound to a
 *      colour other than the selected one; and every REPRESENTATIVE image
 *      whose source variant (`via_variant_id`) clashes so — its picture shows
 *      that variant, not merely the value it is bound to. On an IMPORTED
 *      product only (`completeVariants`: the import's variants are every real
 *      combination), also an image bound to a value that forms no variant with
 *      the rest of the selection (an impossible combination) — never the
 *      selected value's own. An existing product's variant rows can be
 *      partial (a pre-order-only model has none; the form creates rows only
 *      for direct sale), so there that rule would drop the chosen model's own
 *      picture and the page would lead with another picture than the cart
 *      line (worker/lib/productSelectionImage.ts). Unbound images always
 *      stay. If nothing would remain, the full list is used.
 *   2. RANK with `productMediaForSelection` (exact variant → colour → option →
 *      primary → general) over the FULL remaining list, so the second binding
 *      of a shared picture can lead.
 *   3. DE-DUPLICATE BY URL AFTERWARDS, keeping the first occurrence. (The page
 *      used to de-duplicate first, which dropped the second binding of a shared
 *      image: the PEI plate's H2C picture was bound to the A2L row and never
 *      led for an H2C.)
 *
 * AN UNBOUND GALLERY IS UNCHANGED: with no binding anywhere (every product
 * before the import), step 1 drops nothing, step 2 keeps the stored order and
 * step 3 is the old de-duplication — tests/productGallerySelection.test.ts
 * proves it against the old function. With no selection the stored order
 * stands for every product.
 *
 * The same rule as the import's own golden tests
 * (packages/catalog/src/bambuImport/media.ts `contradicts`), stated over the
 * page body's shapes instead of the import's model.
 */
import { productMediaForSelection } from '../../packages/pricing/src/productSelectionMedia';

export interface GalleryBinding {
  id?: string;
  url: string;
  option_value_id?: string | null;
  color_id?: string | null;
  variant_id?: string | null;
  /** 0194: a representative row's source variant (the relations images carry it only where there is one). */
  via_variant_id?: string | null;
}

export interface GalleryMedia extends GalleryBinding {
  primary?: boolean;
  order?: number;
}

export interface GalleryModel {
  groups: ReadonlyArray<{ id: string; values: ReadonlyArray<{ id: string }> }>;
  /** Active variants (the public relations carry active rows only). */
  variants: ReadonlyArray<{ id: string; combo_key: string; active?: boolean | number | null }>;
  /**
   * The variants are EVERY real combination (an imported product: src/lib/productChooser.ts
   * `importedChooser`), so a value forming none with the selection is an impossible choice.
   * Absent or false for every other product: its variant rows may be partial.
   */
  completeVariants?: boolean;
}

export interface GallerySelection {
  /** One value per group, in any order. */
  optionValueIds?: readonly string[] | null;
  /** The single-option fallback of the legacy choosers. */
  optionId?: string | null;
  colorId?: string | null;
  /** The exact variant the full selection resolves to, when it does. */
  variantId?: string | null;
}

/** Media in stored order, primary first — EVERY row kept (no de-duplication: that is step 3). */
export function mediaInStoredOrder<T extends { url: string; primary?: boolean | null; order?: number | null }>(media: readonly T[]): T[] {
  return media
    .filter((m) => m && typeof m.url === 'string' && m.url !== '')
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (!!b.item.primary !== !!a.item.primary) return b.item.primary ? 1 : -1;
      return (a.item.order ?? 0) - (b.item.order ?? 0) || a.index - b.index;
    })
    .map(({ item }) => item);
}

/** Keeps the first occurrence of every URL. */
export function dedupeByUrl<T extends { url: string }>(media: readonly T[]): T[] {
  const seen = new Set<string>();
  return media.filter((m) => (seen.has(m.url) ? false : (seen.add(m.url), true)));
}

const selectedValues = (selection: GallerySelection): string[] => {
  const ids = selection.optionValueIds?.length ? selection.optionValueIds : selection.optionId ? [selection.optionId] : [];
  return [...new Set(ids.filter(Boolean))];
};

const hasSelection = (selection: GallerySelection): boolean =>
  !!selection.variantId || !!selection.colorId || selectedValues(selection).length > 0;

/** A compiled selection, for testing many images against it. */
interface Compiled {
  groupOf: Map<string, string>;
  chosen: Map<string, string>;
  colorId: string;
  variants: Map<string, string[]>;
  combos: string[][];
  completeVariants: boolean;
}

function compile(model: GalleryModel, selection: GallerySelection): Compiled {
  const groupOf = new Map<string, string>();
  for (const g of model.groups) for (const v of g.values) groupOf.set(v.id, g.id);
  const chosen = new Map<string, string>();
  for (const id of selectedValues(selection)) {
    const g = groupOf.get(id);
    if (g) chosen.set(g, id);
  }
  const active = model.variants.filter((v) => v.active !== false && v.active !== 0);
  const variants = new Map(active.map((v) => [v.id, v.combo_key.split('|').filter(Boolean)]));
  return { groupOf, chosen, colorId: selection.colorId ?? '', variants, combos: [...variants.values()], completeVariants: model.completeVariants === true };
}

/** A combo part (`o:<value>` / `c:<colour>`) that the selection rules out. */
function partClashes(part: string, c: Compiled): boolean {
  if (part.startsWith('o:')) {
    const id = part.slice(2);
    const g = c.groupOf.get(id);
    return !!g && c.chosen.has(g) && c.chosen.get(g) !== id;
  }
  if (part.startsWith('c:')) return !!c.colorId && part.slice(2) !== c.colorId;
  return false;
}

function variantClashes(variantId: string, c: Compiled): boolean {
  const parts = c.variants.get(variantId);
  return !!parts && parts.some((p) => partClashes(p, c));
}

/** §G.3 step 1: does this binding contradict the selection? Unbound never does. */
export function contradictsSelection(binding: GalleryBinding, model: GalleryModel, selection: GallerySelection): boolean {
  if (!hasSelection(selection)) return false;
  return contradicts(binding, compile(model, selection));
}

function contradicts(b: GalleryBinding, c: Compiled): boolean {
  if (b.color_id && c.colorId && b.color_id !== c.colorId) return true;
  if (b.variant_id) return variantClashes(b.variant_id, c);
  if (b.via_variant_id && variantClashes(b.via_variant_id, c)) return true;
  if (b.option_value_id) {
    if (partClashes(`o:${b.option_value_id}`, c)) return true;
    // A value that forms no variant with the rest of the selection is an impossible choice: its picture
    // must not lead or linger. Only where the variants are every real combination (an imported product),
    // and never the selected value's own picture.
    if (c.completeVariants && c.combos.length && c.groupOf.has(b.option_value_id)) {
      const own = c.groupOf.get(b.option_value_id);
      if (own && c.chosen.get(own) === b.option_value_id) return false;
      const others = [...c.chosen.entries()].filter(([g]) => g !== own).map(([, id]) => `o:${id}`);
      const mine = `o:${b.option_value_id}`;
      if (!c.combos.some((parts) => parts.includes(mine) && others.every((o) => parts.includes(o)))) return true;
    }
  }
  return false;
}

/**
 * The gallery a selection shows (§G.3). `media` is every row in stored order
 * (`mediaInStoredOrder`); `bindings` are the relations images (by id, else the
 * row's own fields); the answer is de-duplicated by URL.
 */
export function galleryForSelection<T extends GalleryMedia>(
  media: readonly T[],
  bindings: readonly GalleryBinding[],
  model: GalleryModel,
  selection: GallerySelection
): T[] {
  if (!hasSelection(selection)) return dedupeByUrl(media);
  const byId = new Map(bindings.filter((b) => b.id).map((b) => [b.id!, b]));
  const urlCount = new Map<string, number>();
  for (const b of bindings) urlCount.set(b.url, (urlCount.get(b.url) ?? 0) + 1);
  const byUrl = new Map(bindings.filter((b) => urlCount.get(b.url) === 1).map((b) => [b.url, b]));
  const bound = (m: T): GalleryBinding => {
    const byIdHit = m.id ? byId.get(m.id) : undefined;
    if (byIdHit) return byIdHit;
    if (m.option_value_id || m.color_id || m.variant_id || m.via_variant_id) return m;
    return byUrl.get(m.url) ?? m;
  };
  const c = compile(model, selection);
  const rows = media.map((item) => ({ item, b: bound(item) }));
  const kept = rows.filter((r) => !contradicts(r.b, c));
  const pool = kept.length ? kept : rows;
  const ranked = productMediaForSelection(
    pool.map((r) => ({
      r,
      url: r.item.url,
      primary: r.item.primary,
      option_value_id: r.b.option_value_id ?? null,
      color_id: r.b.color_id ?? null,
      variant_id: r.b.variant_id ?? null,
    })),
    { optionValueIds: selectedValues(selection), colorId: selection.colorId ?? null, variantId: selection.variantId ?? null }
  ).map(({ r }) => r.item);
  return dedupeByUrl(ranked);
}

/** A picture's stored size, as the media JSON carries it (`product_images.width/height`). */
export interface StoredSize {
  width?: number | null;
  height?: number | null;
}

const positive = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

/**
 * THE SIZE THE LIGHT THEME'S MAIN IMAGE IS DRAWN FROM (migration 0138; speed
 * audit 2026-10-16).
 *
 * In the light theme the primary's slot shows `light_image`, another file. It
 * used to be swapped in with NO size, so the lead picture lost both halves of
 * its small copy: `sizes` fell back to the gallery FRAME's width
 * (PRODUCT_GALLERY_SIZES, `calc(100vw - 58px)` on a phone) instead of the
 * square actually drawn, and the srcset ran on to `?w=1280` and `?w=1600`
 * instead of stopping at the stored width. Measured live: a 360 px phone at
 * DPR 3 fetched the 1080 copy where the 800 covers the drawn picture; a 430 px
 * one, an iPad and a desktop fetched the ORIGINAL (77–141 KB against a
 * 34–52 KB copy), about 0.6 s of phone LCP on Slow-4G. The dark theme, which
 * keeps the primary's size, was right all along.
 *
 * In order of trust:
 *   1. the light file's OWN stored size, when the product answer carries it
 *      (`light_image_width` / `light_image_height`);
 *   2. otherwise the primary's stored size — the light image is the
 *      primary's twin for the other ground (MainImagesPair.tsx), and every
 *      live pair is the same 1254 × 1254 picture — UNLESS the page has seen
 *      the light file itself and its shape is not the primary's
 *      (`observedAspect`): then no size at all, exactly the old behaviour,
 *      which over-asks but is never blurred.
 */
export function lightMainImageSize(
  primary: StoredSize | null | undefined,
  own?: StoredSize | null,
  observedAspect?: number | null
): { width: number | null; height: number | null } {
  const ownW = positive(own?.width);
  const ownH = positive(own?.height);
  if (ownW && ownH) return { width: ownW, height: ownH };
  const w = positive(primary?.width);
  const h = positive(primary?.height);
  if (!w || !h) return { width: null, height: null };
  const seen = positive(observedAspect);
  if (seen && Math.abs(seen / (w / h) - 1) > LIGHT_ASPECT_TOLERANCE) return { width: null, height: null };
  return { width: w, height: h };
}

/** How far the light file's measured shape may stray from the primary's (2 %: a re-encode's rounding, never a different picture). */
export const LIGHT_ASPECT_TOLERANCE = 0.02;

/** The gallery for the light theme: the primary's slot shows `light`, at `size` (lightMainImageSize). */
export function withLightMainImage<T extends { url: string; width?: number | null; height?: number | null }>(
  ordered: readonly T[],
  primaryUrl: string | undefined,
  light: string,
  size: { width: number | null; height: number | null }
): T[] {
  if (!light || !primaryUrl) return [...ordered];
  return ordered.map((m) => (m.url === primaryUrl ? { ...m, url: light, width: size.width, height: size.height } : m));
}
