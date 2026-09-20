/**
 * Pure product-media selection shared by the Storefront and Worker.
 *
 * Callers own transport-specific concerns (hydrating rows, resolving a
 * separate bindings array, and deciding the base gallery order). Once media
 * is normalised to this shape there is exactly one precedence rule:
 *
 * exact variant -> selected colour -> selected option -> product primary.
 */
export interface ProductSelectionMedia {
  url?: string | null;
  primary?: boolean | null;
  option_value_id?: string | null;
  color_id?: string | null;
  variant_id?: string | null;
}

export interface ProductMediaSelection {
  optionValueIds?: readonly string[] | null;
  colorId?: string | null;
  variantId?: string | null;
}

export interface ProductSelectionVariant {
  id: string;
  combo_key: string;
  /** Missing means active; public projections contain active rows only. */
  active?: boolean | number | null;
}

function selectedOptionIds(selection: ProductMediaSelection): string[] {
  return [...new Set(selection.optionValueIds ?? [])].filter(Boolean);
}

/** Canonical, order-independent selection key used to locate exact variants. */
export function productSelectionComboKey(selection: ProductMediaSelection): string {
  const parts = selectedOptionIds(selection)
    .sort()
    .map((id) => `o:${id}`);
  if (selection.colorId) parts.push(`c:${selection.colorId}`);
  return parts.join('|');
}

/** Resolve an active exact variant without trusting a client-supplied key. */
export function productVariantIdForSelection(
  variants: readonly ProductSelectionVariant[],
  selection: ProductMediaSelection
): string | null {
  const key = productSelectionComboKey(selection);
  if (!key) return null;
  return variants.find(
    (variant) => variant.active !== false && variant.active !== 0 && variant.combo_key === key
  )?.id ?? null;
}

function mediaRank(
  media: ProductSelectionMedia,
  selection: ProductMediaSelection,
  optionIds: readonly string[]
): number {
  if (selection.variantId && media.variant_id === selection.variantId) return 0;
  if (selection.colorId && media.color_id === selection.colorId) return 100;

  // A multi-group selection is a SET. The cart stores that set in lexical
  // order while Product keeps the catalogue's authored group order, so using
  // the array index here made the same configuration lead with two different
  // images. Every selected-option binding has one rank; the stable input media
  // order (the authoritative gallery order) breaks the tie.
  if (media.option_value_id && optionIds.includes(media.option_value_id)) return 200;

  if (media.primary) return 300;
  if (!media.variant_id && !media.color_id && !media.option_value_id) return 400;
  return 500;
}

/**
 * Stable, non-mutating ordering for a selected product configuration.
 *
 * With no selection the caller's authoritative base order is retained. This
 * lets the Worker pass its primary-first media and the Storefront pass the
 * already published gallery without either layer reimplementing precedence.
 */
export function productMediaForSelection<T extends ProductSelectionMedia>(
  media: readonly T[],
  selection: ProductMediaSelection
): T[] {
  const optionIds = selectedOptionIds(selection);
  if (!selection.variantId && !selection.colorId && optionIds.length === 0) return [...media];

  return media
    .map((item, index) => ({ item, index, rank: mediaRank(item, selection, optionIds) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

/** The single image corresponding to `productMediaForSelection(...)[0]`. */
export function productImageForSelection<T extends ProductSelectionMedia>(
  media: readonly T[],
  selection: ProductMediaSelection
): T | null {
  return productMediaForSelection(media, selection).find((item) => !!item.url) ?? null;
}
