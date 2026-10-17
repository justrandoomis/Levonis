import React from 'react';
import { useTheme } from '../../lib/theme';
import { PHONE_MEDIA, themedFiles } from '../../lib/catalog/sectionPictures';
import { variantSrcSet } from '../../../packages/contracts/src/imageSizing';
import { IMAGE_SIZES, cropDrawnWidth } from '../../../packages/contracts/src/imageSizes';

/**
 * A photograph in a ZONE of a dark banner — the home bento's `PromoPhoto`
 * rule (src/components/home/v2/PromoPhoto.tsx, the `.lv-promo-*` CSS in
 * src/index.css): a catalogue photograph is cropped to its product band, a
 * picture the owner uploaded is shown whole. This twin adds what a page's
 * FIRST picture needs and a home tile does not: eager loading with a high
 * fetch priority for the one image that is the page's largest paint (§12),
 * and lazy for every other.
 *
 * `lightSrc` — the product's light-theme main image (migration 0138), shown
 * on the light theme; with none, the dark photograph is framed there
 * (`data-ground="dark"`, src/index.css FEATURE SURFACES).
 *
 * `mobileSrc` / `lightMobileSrc` — a section's phone pictures (0149), drawn
 * below 640 px through `<source media>` (src/lib/catalog/sectionPictures.ts
 * PHONE_MEDIA). The theme is chosen here and the screen by the browser, so
 * only ONE file is ever requested: the one for the theme and the screen on
 * view.
 *
 * `frame={false}` — the caller draws its own dark ground under the
 * photograph in both themes (the category row banners), so the light-theme
 * window would only be a card inside a card.
 *
 * SMALL COPIES (owner 2026-10-13). Both the `<source>` and the `<img>` carry
 * the `srcset` of the server's copies (packages/contracts/src/imageSizing.ts)
 * and `sizes` — the `cropBanner` preset unless the caller knows better — so a
 * 205 px phone banner downloads the 640 px copy, not a 1254–1600 px original
 * (measured: `/categories` on a phone went from 512 KB of pictures to ~180,
 * then ~160 once the phone clause followed the drawn box).
 * A GIF or any other source keeps its own file.
 *
 * A failed load removes the picture; the banner under it is already a
 * designed surface.
 *
 * `fit` — for a zone whose size the screen's width does not decide (the
 * compact category hero's follows its title, which may wrap): the zone is
 * measured in a layout effect — the same task as the commit, before paint —
 * and the `<picture>` goes in only then, with `fit(drawn width)` as its
 * `sizes`. One request, for the copy the drawn box needs. A later growth (a
 * font arriving, a rotation) asks again, wider; never narrower, which would
 * fetch a smaller copy of a picture already on screen.
 */
export default function CropPhoto({
  src,
  lightSrc = '',
  mobileSrc = '',
  lightMobileSrc = '',
  crop,
  className,
  size,
  eager = false,
  frame = true,
  sizes = IMAGE_SIZES.cropBanner,
  fit,
}: {
  src: string;
  lightSrc?: string;
  /** The dark theme's picture on a phone (< 640 px), when it differs. */
  mobileSrc?: string;
  /** The light theme's picture on a phone, when it differs. */
  lightMobileSrc?: string;
  crop: boolean;
  /** Positions the zone and its mask, e.g. `lv-fade-start inset-y-0 end-0 w-[54%]`. */
  className: string;
  /** The intrinsic square the photograph is decoded at. */
  size: number;
  eager?: boolean;
  /** Frame a dark catalogue photograph on the light theme (default), or not. */
  frame?: boolean;
  /** How wide the photograph is drawn (`sizes` grammar). */
  sizes?: string;
  /** `sizes` from the drawn width measured in the zone (crop rule); replaces `sizes`. Must be a stable function. */
  fit?: (drawn: number) => string;
}) {
  const { theme } = useTheme();
  const { large: shown, phone } = themedFiles({ src, lightSrc, mobileSrc, lightMobileSrc }, theme);
  // Keyed on BOTH files: a failure belongs to the pair on view, and a theme
  // switch (a different pair) gets a fresh attempt.
  const pair = `${shown}|${phone}`;
  const [failed, setFailed] = React.useState('');
  const present = !!shown && failed !== pair;
  const zone = React.useRef<HTMLDivElement>(null);
  // The widest this photograph has been drawn here (CSS px); null until measured.
  const [drawn, setDrawn] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const el = zone.current;
    if (!fit || !present || !el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      // A plain cover crop of a square draws it as wide as the zone's longer side.
      const next = crop ? cropDrawnWidth(box) : Math.max(box.width, box.height);
      setDrawn((prev) => (prev !== null && Math.ceil(prev) >= Math.ceil(next) ? prev : next));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, present, crop]);
  if (!present) return null;
  const fitted = fit ? (drawn === null ? null : fit(drawn)) : sizes;
  // Only a catalogue photograph is known to be a dark studio shot; an owner's
  // own picture keeps the edge fade it was designed with.
  const ground = frame && crop && theme === 'light' && shown !== lightSrc ? 'dark' : undefined;
  const largeSet = variantSrcSet(shown);
  const phoneSet = variantSrcSet(phone);
  return (
    <div ref={zone} aria-hidden="true" data-ground={ground} className={`lv-promo-zone absolute ${className}`}>
      {fitted === null ? null : (
        <picture>
          {phone !== shown ? <source media={PHONE_MEDIA} srcSet={phoneSet ?? phone} sizes={phoneSet ? fitted : undefined} /> : null}
          <img
            src={shown}
            srcSet={largeSet}
            sizes={largeSet ? fitted : undefined}
            alt=""
            width={size}
            height={size}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            {...(eager ? { fetchPriority: 'high' as const } : {})}
            data-crop={crop ? '' : undefined}
            onError={() => setFailed(pair)}
            className="lv-promo-photo transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
          />
        </picture>
      )}
    </div>
  );
}
