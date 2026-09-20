/**
 * Frontend reader for the server's canonical primary-image contract.
 *
 * The Worker already publishes `images` primary-first. Reading the explicit
 * media marker as well makes cached/legacy payloads safe during deployment and
 * prevents a card from regressing to array order while an old response is in
 * memory. This helper chooses; it never invents or rewrites product data.
 */
import { productMediaForSelection } from '../../packages/pricing/src/productSelectionMedia';

export { productSelectionComboKey, productVariantIdForSelection } from '../../packages/pricing/src/productSelectionMedia';

export interface PrimaryImageProduct {
  images?: readonly string[] | null;
  media?: readonly {
    url?: string | null;
    primary?: boolean | null;
    order?: number | null;
  }[] | null;
}

export interface ProductGalleryMedia {
  id?: string;
  url: string;
  alt_ar?: string;
  alt_en?: string;
  alt_ckb?: string;
  order?: number;
  primary?: boolean;
  option_value_id?: string | null;
  color_id?: string | null;
  variant_id?: string | null;
}

export interface ProductGalleryBinding {
  id?: string;
  url: string;
  option_value_id?: string | null;
  color_id?: string | null;
  variant_id?: string | null;
}

export interface ProductImageVariant {
  id: string;
  combo_key: string;
  active?: boolean | number | null;
}

/**
 * Reorders the gallery only after the customer explicitly chooses a variant.
 *
 * Before a choice, the server-published order is authoritative and therefore
 * keeps the admin-selected primary image first. A bound primary image must not
 * sink behind an unbound gallery image merely because no variant is selected.
 */
export function productGalleryForSelection<T extends ProductGalleryMedia>(
  base: readonly T[],
  bindings: readonly ProductGalleryBinding[],
  selection: {
    optionId?: string | null;
    optionValueIds?: readonly string[] | null;
    colorId?: string | null;
    variantId?: string | null;
  }
): ProductGalleryMedia[] {
  const { colorId, variantId } = selection;
  const optionValueIds = selection.optionValueIds?.length
    ? [...new Set(selection.optionValueIds.filter(Boolean))]
    : selection.optionId
      ? [selection.optionId]
      : [];
  if (!variantId && !colorId && optionValueIds.length === 0) return [...base];

  const byId = new Map(bindings.filter((image) => image.id).map((image) => [image.id!, image]));
  const byUrl = new Map(bindings.map((image) => [image.url, image]));
  const candidates = base.map((image) => {
    const binding = (image.id ? byId.get(image.id) : undefined) ?? byUrl.get(image.url) ?? image;
    return {
      image,
      url: image.url,
      primary: image.primary,
      variant_id: binding.variant_id,
      color_id: binding.color_id,
      option_value_id: binding.option_value_id,
    };
  });

  return productMediaForSelection(candidates, {
    optionValueIds,
    colorId,
    variantId,
  }).map(({ image }) => image);
}

export function productPrimaryImage(product: PrimaryImageProduct): string {
  const media = Array.isArray(product.media) ? product.media : [];
  const explicit = media.find((item) => item?.primary && item.url)?.url;
  if (explicit) return explicit;

  const published = Array.isArray(product.images)
    ? product.images.find((url): url is string => typeof url === 'string' && url.length > 0)
    : undefined;
  if (published) return published;

  return [...media]
    .filter((item) => !!item?.url)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.url ?? '';
}
