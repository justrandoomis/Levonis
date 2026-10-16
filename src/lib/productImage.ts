/**
 * Frontend reader for the server's canonical primary-image contract.
 *
 * The Worker already publishes `images` primary-first. Reading the explicit
 * media marker as well makes cached/legacy payloads safe during deployment and
 * prevents a card from regressing to array order while an old response is in
 * memory. This helper chooses; it never invents or rewrites product data.
 */
export { productSelectionComboKey, productVariantIdForSelection } from '../../packages/pricing/src/productSelectionMedia';

export interface PrimaryImageProduct {
  images?: readonly string[] | null;
  /** «الصورة الرئيسية للوضع الفاتح» (0138) — absent when the product has none. */
  light_image?: string | null;
  media?: readonly {
    url?: string | null;
    primary?: boolean | null;
    order?: number | null;
  }[] | null;
}

export interface ProductImageVariant {
  id: string;
  combo_key: string;
  active?: boolean | number | null;
}

/*
 * The product page's gallery for a selection is src/lib/productGallery.ts
 * `galleryForSelection` (the Bambu import spec §G.3): the older
 * de-duplicate-then-rank helper that lived here had no caller left, and a test
 * mirroring it kept the page-versus-cart parity guard green on a function the
 * page no longer ran (tests/productSelectionImage.test.ts now mirrors the page).
 */

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

/**
 * THE MAIN IMAGE FOR THE THEME ON SCREEN (migration 0138).
 *
 * The owner: «يكون هنالك صورتين حسب المظهر». The gallery primary is the main
 * image and is what the dark theme shows; a product may also carry a
 * light-theme main image, which the light theme shows instead. With none, both
 * themes show the primary — every product looked like that before 0138.
 *
 * Pass the theme from `useTheme()` (src/lib/theme.ts): the attribute on <html>
 * is set before the first paint, so the first render already asks for the
 * right file and only that file is downloaded; a theme switch re-renders and
 * swaps the `src` at once.
 */
export function productMainImage(product: PrimaryImageProduct, theme: 'light' | 'dark'): string {
  if (theme === 'light') {
    const light = typeof product.light_image === 'string' ? product.light_image.trim() : '';
    if (light) return light;
  }
  return productPrimaryImage(product);
}

/** The same choice for a picture that is not a product (a tile, a banner). */
export function themedImage(dark: string, light: string | null | undefined, theme: 'light' | 'dark'): string {
  return theme === 'light' && light ? light : dark;
}
