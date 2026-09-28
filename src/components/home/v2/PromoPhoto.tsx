import React from 'react';
import { useTheme } from '../../../lib/theme';
import { PHONE_MEDIA, themedFiles } from '../../../lib/catalog/sectionPictures';

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
 * A PHONE SIZE OF EACH (0149). `mobileSrc` / `lightMobileSrc` are a section's
 * card pictures for a phone, drawn below 640 px through `<source media>`
 * (src/lib/catalog/sectionPictures.ts PHONE_MEDIA) — still one file
 * downloaded, the one for the theme and the screen on view.
 *
 * FULL-BLEED (`bleed`, owner 2026-09-26: «اجعل الصورة تملأ البطاقة»). The
 * bento tiles, the editorial banners and the hero's frame now draw the
 * photograph over the WHOLE surface with the words on it, over a dark scrim
 * the caller draws. There the photograph is never framed as a window, whatever
 * the theme — the window exists for a photograph sharing a cream tile with
 * ink type, and a bled tile has no cream left to protect.
 *
 * A failed load removes the picture; the tile underneath is already a
 * designed surface, so nothing is left broken.
 */
export default function PromoPhoto({
  src,
  lightSrc = '',
  mobileSrc = '',
  lightMobileSrc = '',
  crop,
  className,
  width,
  height,
  bleed = false,
  eager = false,
}: {
  src: string;
  lightSrc?: string;
  /** The dark theme's picture on a phone (< 640 px), when it differs. */
  mobileSrc?: string;
  /** The light theme's picture on a phone, when it differs. */
  lightMobileSrc?: string;
  crop: boolean;
  /** Positions the zone: e.g. `inset-x-0 bottom-0 top-[30%]` plus a mask. */
  className: string;
  width: number;
  height: number;
  /** The photograph fills its surface; never framed as a window. */
  bleed?: boolean;
  /** On the first screen (the hero): load now rather than lazily. */
  eager?: boolean;
}) {
  const { theme } = useTheme();
  const { large: shown, phone } = themedFiles({ src, lightSrc, mobileSrc, lightMobileSrc }, theme);
  const pair = `${shown}|${phone}`;
  const [failed, setFailed] = React.useState('');
  if (!shown || failed === pair) return null;
  // Only a catalogue photograph is known to be a dark studio shot; an owner's
  // own picture keeps the edge fade it was designed with.
  const ground = !bleed && crop && theme === 'light' && shown !== lightSrc ? 'dark' : undefined;
  return (
    <div aria-hidden="true" data-ground={ground} className={`lv-promo-zone absolute ${className}`}>
      <picture>
        {phone !== shown ? <source media={PHONE_MEDIA} srcSet={phone} /> : null}
        <img
          src={shown}
          alt=""
          width={width}
          height={height}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          data-crop={crop ? '' : undefined}
          onError={() => setFailed(pair)}
          className="lv-promo-photo transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
        />
      </picture>
    </div>
  );
}
