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
