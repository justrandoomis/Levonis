/** GALLERY — the merchant's own pictures, a grid or a shelf, each with an optional caption. */
import { mediaSrc } from '../../../../packages/storeLayout/src/refs';
import { BlockHeading, Column, useText } from '../parts';
import type { BlockProps } from '../types';

export default function GalleryBlock({ block }: BlockProps<'gallery'>) {
  const text = useText();
  const images = block.settings.images
    .map((it) => ({ src: mediaSrc(it.image), caption: text(it.caption) }))
    .filter((it) => it.src);
  if (!images.length) return null;
  const tiles = images.map((it, i) => (
    <figure key={i} className="min-w-0">
      <div className="sf-media sf-well sf-r-sm overflow-hidden">
        <img src={it.src} alt={it.caption} className="w-full h-full object-cover" loading="lazy" />
      </div>
      {it.caption && (
        <figcaption className="text-zinc-400 text-[11.5px] mt-1.5 line-clamp-2" dir="auto">
          {it.caption}
        </figcaption>
      )}
    </figure>
  ));
  return (
    <Column>
      <BlockHeading title={text(block.settings.title)} />
      {block.variant === 'carousel' ? (
        <div className="sf-shelf pb-1">{tiles}</div>
      ) : (
        <div className="grid grid-cols-2 @min-[40rem]:grid-cols-3 sf-grid">{tiles}</div>
      )}
    </Column>
  );
}
