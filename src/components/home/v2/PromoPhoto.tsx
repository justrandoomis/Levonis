import React from 'react';

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
 * A failed load removes the picture; the tile underneath is already a
 * designed surface, so nothing is left broken.
 */
export default function PromoPhoto({
  src,
  crop,
  className,
  width,
  height,
}: {
  src: string;
  crop: boolean;
  /** Positions the zone: e.g. `inset-x-0 bottom-0 top-[30%]` plus a mask. */
  className: string;
  width: number;
  height: number;
}) {
  const [failed, setFailed] = React.useState(false);
  if (!src || failed) return null;
  return (
    <div aria-hidden="true" className={`lv-promo-zone absolute ${className}`}>
      <img
        src={src}
        alt=""
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        data-crop={crop ? '' : undefined}
        onError={() => setFailed(true)}
        className="lv-promo-photo transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
      />
    </div>
  );
}
