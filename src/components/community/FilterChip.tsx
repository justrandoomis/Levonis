/**
 * A FILTER CHIP (build plan §5, «Filter chips (catalog facets, community
 * tags)») — the community's kind, tag and section chips drawn the way the
 * catalogue's facets are (components/listing/QuickFilterChips.tsx): a pill
 * drawn 32px inside a 44px target, flush clay at rest (the rim alone), and
 * PRESSED when it is on — the well fill and the press shadow, plus a leading
 * check as the one secondary cue. Selection is a press, never an ink fill
 * (docs/DECISIONS.md row 207); the gold ring is keyboard focus only.
 *
 * The class strings are the catalogue's own, letter for letter, so a
 * community chip adds nothing to the stylesheet. The caller keeps whatever
 * state attribute it already says (`aria-pressed` on a filter) — this only
 * draws.
 *
 * `shape="rect"` is the community kit chip (community UI plan B1, IMG_8468):
 * 40px drawn in the 44px target, 12px corners, raised clay, an optional
 * leading icon and trailing chevron, and when it is on the sand selection of
 * src/styles/community.css (D-3, owner override) inside the community scope.
 * Without `shape` (and without `icon` or `trailing`) the chip renders exactly
 * as before.
 */
import React from 'react';
import { Check } from 'lucide-react';

export interface FilterChipProps extends Omit<React.ComponentPropsWithRef<'button'>, 'children'> {
  /** Drawn pressed, with the check. */
  on: boolean;
  /** The leading check when on — off for a chip that carries its own «×» (a chosen tag). */
  check?: boolean;
  /** A leading glyph (an icon, or a status dot) before the label; the check replaces it when on. */
  icon?: React.ReactNode;
  /** A trailing glyph after the label: the chevron of a chip that opens a list. */
  trailing?: React.ReactNode;
  /** `pill` (default): the catalogue facet. `rect`: the community kit chip. */
  shape?: 'pill' | 'rect';
  children: React.ReactNode;
}

export default function FilterChip({ on, check = true, icon, trailing, shape = 'pill', children, className = '', type = 'button', ...rest }: FilterChipProps) {
  const lead = on && check ? <Check aria-hidden="true" className="size-3.5" strokeWidth={2.6} /> : (icon ?? null);
  if (shape === 'rect') {
    return (
      <button {...rest} type={type} className={`group inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none ${className}`}>
        <span data-selected={on || undefined} className="cm-raised cm-chip cm-sel inline-flex h-10 items-center gap-2 whitespace-nowrap px-3.5 text-[14px] font-semibold group-focus-visible:ring-2 group-focus-visible:ring-focus">
          {lead}
          {children}
          {trailing}
        </span>
      </button>
    );
  }
  return (
    <button {...rest} type={type} className={`group inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none ${className}`}>
      <span
        className={`inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full px-3.5 text-[12.5px] font-bold transition-colors group-focus-visible:ring-2 group-focus-visible:ring-focus ${
          on
            ? 'border border-transparent bg-[var(--clay-well-bg)] text-text-primary shadow-press'
            : 'border border-border-subtle bg-surface-raised text-text-secondary shadow-xs group-hover:text-text-primary'
        }`}
      >
        {lead}
        {children}
        {trailing}
      </span>
    </button>
  );
}
