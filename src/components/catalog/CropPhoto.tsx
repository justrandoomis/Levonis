import React from 'react';
import { useTheme } from '../../lib/theme';
import { themedImage } from '../../lib/productImage';

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
 * (`data-ground="dark"`, src/index.css FEATURE SURFACES). Only the file for
 * the theme on screen is requested.
 *
 * A failed load removes the picture; the banner under it is already a
 * designed surface.
 */
export default function CropPhoto({
  src,
  lightSrc = '',
  crop,
  className,
  size,
  eager = false,
}: {
  src: string;
  lightSrc?: string;
  crop: boolean;
  /** Positions the zone and its mask, e.g. `lv-fade-start inset-y-0 end-0 w-[54%]`. */
  className: string;
  /** The intrinsic square the photograph is decoded at. */
  size: number;
  eager?: boolean;
}) {
  const { theme } = useTheme();
  const shown = themedImage(src, lightSrc, theme);
  const [failed, setFailed] = React.useState('');
  if (!shown || failed === shown) return null;
  // Only a catalogue photograph is known to be a dark studio shot; an owner's
  // own picture keeps the edge fade it was designed with.
  const ground = crop && theme === 'light' && shown !== lightSrc ? 'dark' : undefined;
  return (
    <div aria-hidden="true" data-ground={ground} className={`lv-promo-zone absolute ${className}`}>
      <img
        src={shown}
        alt=""
        width={size}
        height={size}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        {...(eager ? { fetchPriority: 'high' as const } : {})}
        data-crop={crop ? '' : undefined}
        onError={() => setFailed(shown)}
        className="lv-promo-photo transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
      />
    </div>
  );
}
