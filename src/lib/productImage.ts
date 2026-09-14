/**
 * Frontend reader for the server's canonical primary-image contract.
 *
 * The Worker already publishes `images` primary-first. Reading the explicit
 * media marker as well makes cached/legacy payloads safe during deployment and
 * prevents a card from regressing to array order while an old response is in
 * memory. This helper chooses; it never invents or rewrites product data.
 */
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
}

export interface ProductGalleryBinding {
  url: string;
  option_value_id?: string | null;
  color_id?: string | null;
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
    colorId?: string | null;
    optionImage?: string | null;
    colorImage?: string | null;
  }
): ProductGalleryMedia[] {
  const { optionId, colorId, optionImage, colorImage } = selection;
  if (!optionId && !colorId) return [...base];
  if (!bindings.length && !optionImage && !colorImage) return [...base];

  const linkOf = new Map(bindings.map((image) => [image.url, image]));
  const extras: ProductGalleryMedia[] = [];
  if (colorImage && !base.some((image) => image.url === colorImage)) extras.push({ url: colorImage });
  if (optionImage && !base.some((image) => image.url === optionImage)) extras.push({ url: optionImage });

  const score = (image: ProductGalleryMedia): number => {
    const binding = linkOf.get(image.url);
    if (colorId && (binding?.color_id === colorId || image.url === colorImage)) return 0;
    if (optionId && (binding?.option_value_id === optionId || image.url === optionImage)) return 1;
    if (binding?.color_id || binding?.option_value_id) return 3;
    return 2;
  };

  return [...extras, ...base]
    .map((image, index) => ({ image, index, score: score(image) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ image }) => image);
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
