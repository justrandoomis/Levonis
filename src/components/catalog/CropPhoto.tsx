import React from 'react';

/**
 * A photograph in a ZONE of a dark banner — the home bento's `PromoPhoto`
 * rule (src/components/home/v2/PromoPhoto.tsx, the `.lv-promo-*` CSS in
 * src/index.css): a catalogue photograph is cropped to its product band, a
 * picture the owner uploaded is shown whole. This twin adds what a page's
 * FIRST picture needs and a home tile does not: eager loading with a high
 * fetch priority for the one image that is the page's largest paint (§12),
 * and lazy for every other.
 *
 * A failed load removes the picture; the banner under it is already a
 * designed surface.
 */
export default function CropPhoto({
  src,
  crop,
  className,
  size,
  eager = false,
}: {
  src: string;
  crop: boolean;
  /** Positions the zone and its mask, e.g. `lv-fade-start inset-y-0 end-0 w-[54%]`. */
  className: string;
  /** The intrinsic square the photograph is decoded at. */
  size: number;
  eager?: boolean;
}) {
  const [failed, setFailed] = React.useState(false);
  if (!src || failed) return null;
  return (
    <div aria-hidden="true" className={`lv-promo-zone absolute ${className}`}>
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        {...(eager ? { fetchPriority: 'high' as const } : {})}
        data-crop={crop ? '' : undefined}
        onError={() => setFailed(true)}
        className="lv-promo-photo transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none"
      />
    </div>
  );
}
