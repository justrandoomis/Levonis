import React from 'react';
import { useTheme } from '../../../lib/theme';
import { themedImage } from '../../../lib/productImage';

/**
 * A photograph placed in a ZONE of a tile (absolutely positioned by the
 * caller), cropped to its middle band when it is one of the shop's catalogue
 * photographs (src/lib/homeLayout.ts `isProductPhoto`) and shown whole when it
 * is a picture the owner uploaded.
 *
 * The crop is CSS (`.lv-promo-photo[data-crop]` in src/index.css): the zone is
 * a size container, and the square photograph is scaled until its middle band
 * covers the zone, then centred on that band — so the same rule serves a tall
 * zone, a wide one and a small one without measuring anything in script.
 *
 * TWO THEMES, ONE FILE DOWNLOADED. `lightSrc` is the product's light-theme main
 * image (migration 0138). The theme is on <html> before the first paint, so the
 * first render already asks for the right file; a theme switch swaps `src`.
 * On the light theme a DARK photograph (no light image) is marked
 * `data-ground="dark"` and src/index.css frames it instead of fading it into
 * the cream (FEATURE SURFACES).
 *
 * A failed load removes the picture; the tile underneath is already a
 * designed surface, so nothing is left broken.
 */
export default function PromoPhoto({
  src,
  lightSrc = '',
  crop,
  className,
  width,
  height,
}: {
  src: string;
  lightSrc?: string;
  crop: boolean;
  /** Positions the zone: e.g. `inset-x-0 bottom-0 top-[30%]` plus a mask. */
  className: string;
  width: number;
  height: number;
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
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        data-crop={crop ? '' : undefined}
        onError={() => setFailed(shown)}
        className="lv-promo-photo transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
      />
    </div>
  );
}
