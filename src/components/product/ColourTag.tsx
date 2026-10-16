/**
 * A COLOUR, AS A SWATCH AND A NAME (docs/ux/COLOUR-QUANTITIES.md §5.1).
 *
 * The checkout used to say a line's colour as the last word of a 12px grey
 * label, so 56 pieces of the wrong colour could reach the last screen before
 * payment unseen. This tag is the colour on the product page's price caption,
 * the confirmation sheet, every cart line and every checkout line:
 *
 *   · the swatch is the colour's own picture when one is bound, else its hex
 *     in a circle, else a neutral circle — and it is `aria-hidden`: colour is
 *     never the only cue. The ring is the field line (`--clay-field`, proven
 *     at 3:1 on every ground in both themes by tests/claySystem.test.ts): the
 *     subtle border measured 1.1:1 around a black swatch on the dark theme,
 *     where a Black line's picture slot looked empty;
 *   · the name is in `<bdi>` (an English name inside an Arabic sentence keeps
 *     its own order) and truncates INSIDE the isolate, never cutting the count
 *     beside it;
 *   · `a11yPrefix` («اللون:») is read before the name by a screen reader only.
 *
 * Small and dependency-free, so it rides with the pages that draw it.
 */
import VariantImg from '../ui/VariantImg';

export interface ColourTagProps {
  name: string;
  hex?: string | null;
  image?: string | null;
  size?: 'sm' | 'md';
  /** Read before the name, visually hidden («اللون:»). */
  a11yPrefix?: string;
  /** «× 56» after the name, in the sentence's direction. */
  qty?: number | null;
  className?: string;
  /** Classes for the name (weight, size, colour); defaults suit body text. */
  nameClassName?: string;
}

const SAFE_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function ColourSwatch({
  hex,
  image,
  size = 'md',
  className = '',
  px,
}: Pick<ColourTagProps, 'hex' | 'image' | 'size' | 'className'> & { /** A larger circle (a cart line's 40 px image slot). */ px?: number }) {
  const box = px ? '' : size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const dim = px ? { width: px, height: px } : undefined;
  const paint = typeof hex === 'string' && SAFE_HEX.test(hex.trim()) ? hex.trim() : '';
  if (image) {
    return (
      <span aria-hidden="true" style={dim} className={`${box} block shrink-0 overflow-hidden rounded-full ring-1 ring-[var(--clay-field)] ${className}`}>
        <VariantImg src={image} sizes={`${px ?? 16}px`} alt="" className="h-full w-full object-cover" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-colour-swatch
      className={`${box} block shrink-0 rounded-full ring-1 ring-[var(--clay-field)] ${paint ? '' : 'bg-surface-raised'} ${className}`}
      style={paint ? { ...dim, backgroundColor: paint } : dim}
    />
  );
}

export function ColourTag({ name, hex, image, size = 'md', a11yPrefix, qty, className = '', nameClassName }: ColourTagProps) {
  const text = size === 'sm' ? 'text-[11px] font-semibold' : 'text-[13px] font-semibold';
  return (
    <span data-colour-tag className={`inline-flex min-w-0 max-w-full items-center gap-1.5 ${className}`}>
      <ColourSwatch hex={hex} image={image} size={size} />
      {a11yPrefix ? <span className="sr-only">{a11yPrefix} </span> : null}
      <bdi className={`min-w-0 truncate ${nameClassName ?? `${text} text-text-primary`}`}>{name}</bdi>
      {typeof qty === 'number' ? (
        <span className={`shrink-0 tabular-nums ${size === 'sm' ? 'text-[11px]' : 'text-[13px]'} font-bold text-text-primary`}>× {qty}</span>
      ) : null}
    </span>
  );
}

export default ColourTag;
