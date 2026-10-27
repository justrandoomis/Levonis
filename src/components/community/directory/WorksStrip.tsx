/**
 * THREE WORKS ON A DIRECTORY CARD (community UI plan C5; IMG_8469, IMG_8476):
 * a store showcase picture or a maker public project cover, drawn as flat
 * tiles under the card head. Decorative: the whole strip is `aria-hidden`, a
 * tap falls through to the one link of the card, and the pictures are the
 * ones the store page and the project pages already publish (plan B3). Fewer
 * than three draw at the same size; none draws nothing, never a stand-in.
 *
 * The tile ratio is an inline style (9:8 for a store, 4:3 for a maker), so
 * the strip adds no rule to any stylesheet.
 */
import SafeImage from '../../ui/SafeImage';

export interface StripWork {
  id: string;
  imageUrl: string | null;
}

export default function WorksStrip({ works, ratio }: { works: StripWork[] | undefined; ratio: '9 / 8' | '4 / 3' }) {
  const shown = (works ?? []).filter((w) => !!w.imageUrl).slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <div aria-hidden="true" data-directory-works={shown.length} className="grid grid-cols-3 gap-1.5">
      {shown.map((w) => (
        <span key={w.id} className="block overflow-hidden rounded-lg" style={{ aspectRatio: ratio }}>
          <SafeImage src={w.imageUrl} alt="" sizes="(min-width: 768px) 180px, 31vw" className="h-full w-full" bgClassName="bg-surface-selected" />
        </span>
      ))}
    </div>
  );
}
