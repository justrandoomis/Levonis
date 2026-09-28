import React from 'react';
import { useTheme } from '../../lib/theme';
import { PHONE_MEDIA, themedFiles } from '../../lib/catalog/sectionPictures';

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
 * A failed load removes the picture; the banner under it is already a
 * designed surface.
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
}) {
  const { theme } = useTheme();
  const { large: shown, phone } = themedFiles({ src, lightSrc, mobileSrc, lightMobileSrc }, theme);
  // Keyed on BOTH files: a failure belongs to the pair on view, and a theme
  // switch (a different pair) gets a fresh attempt.
  const pair = `${shown}|${phone}`;
  const [failed, setFailed] = React.useState('');
  if (!shown || failed === pair) return null;
  // Only a catalogue photograph is known to be a dark studio shot; an owner's
  // own picture keeps the edge fade it was designed with.
  const ground = frame && crop && theme === 'light' && shown !== lightSrc ? 'dark' : undefined;
  return (
    <div aria-hidden="true" data-ground={ground} className={`lv-promo-zone absolute ${className}`}>
      <picture>
        {phone !== shown ? <source media={PHONE_MEDIA} srcSet={phone} /> : null}
        <img
          src={shown}
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
    </div>
  );
}
