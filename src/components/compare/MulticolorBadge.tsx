import React from 'react';
import { Palette } from 'lucide-react';
import type { MulticolorBadgeInfo } from '../../lib/compare';

/**
 * «تعدد الألوان» — THE BADGE, WRITTEN FROM THE SERVER'S CODES.
 *
 * worker/lib/multicolor.ts decides WHAT a configuration does with colour
 * (`multicolorBadge`): colours without filament swaps and their waste for a
 * tool changer / dual or multi nozzle, the AMS ceiling and its purge for a
 * single nozzle, and what this exact option prints as sold. This file only
 * writes the words, so a Snapmaker U1 reads «4 ألوان · بلا هدر يُذكر» and an
 * X2D Combo «لونان بهدر قليل · حتى 25 مع AMS» — never both as «ألوان متعددة».
 *
 * NOTHING IS INVENTED. A count the sheet does not carry is not printed, and a
 * badge with nothing to say renders nothing.
 *
 * OWNER: Sorani to be written by hand (Sorani readers see the Arabic).
 */
type Lang = 'ar' | 'en' | 'ckb';

const arColours = (n: number): string => (n === 1 ? 'لون واحد' : n === 2 ? 'لونان' : n <= 10 ? `${n} ألوان` : `${n} لونًا`);
const enColours = (n: number): string => (n === 1 ? '1 colour' : `${n} colours`);

export interface BadgeCopy {
  /** The headline: how many colours, cleanly. */
  main: string;
  /** The qualifier: waste, the AMS ceiling, colours as sold. */
  sub: string | null;
  tone: 'clean' | 'purge' | 'plain';
}

/**
 * The SHORT form, for a 60 px column: a count and two words, never a sentence
 * broken letter by letter. The long form is the same facts with the ceiling
 * and «as sold» added.
 */
export function multicolorBadgeShort(b: MulticolorBadgeInfo | null | undefined, lang: Lang): BadgeCopy | null {
  if (!b) return null;
  const en = lang === 'en';
  switch (b.kind) {
    case 'native':
      if (b.colors === null) return null;
      return {
        main: en ? enColours(b.colors) : arColours(b.colors),
        sub: b.waste === 'near_zero' ? (en ? 'no waste' : 'بلا هدر') : b.waste === 'low' ? (en ? 'little waste' : 'هدر قليل') : null,
        tone: b.waste === 'near_zero' || b.waste === 'low' ? 'clean' : 'plain',
      };
    case 'ams':
      if (b.colors === null) return null;
      return { main: en ? `${b.colors} with AMS` : `${b.colors} مع AMS`, sub: en ? 'with purge' : 'مع هدر', tone: 'purge' };
    case 'single':
      return { main: en ? '1 colour' : 'لون واحد', sub: null, tone: 'plain' };
    default:
      return null;
  }
}

export function multicolorBadgeCopy(b: MulticolorBadgeInfo | null | undefined, lang: Lang): BadgeCopy | null {
  if (!b) return null;
  const en = lang === 'en';
  const count = (n: number) => (en ? enColours(n) : arColours(n));
  const asSold = b.out_of_box !== null && b.out_of_box > 0 ? (en ? `${b.out_of_box} as sold` : `${b.out_of_box} كما تُباع`) : null;
  const upTo = (n: number) => (en ? `up to ${n} with AMS` : `حتى ${n} مع AMS`);
  switch (b.kind) {
    case 'native': {
      if (b.colors === null) return null;
      const waste =
        b.waste === 'near_zero' ? (en ? 'near-zero waste' : 'بلا هدر يُذكر') : b.waste === 'low' ? (en ? 'little waste' : 'بهدر قليل') : null;
      const tail = b.with_ams !== null && b.with_ams > b.colors ? upTo(b.with_ams) : null;
      return {
        main: waste ? `${count(b.colors)} · ${waste}` : count(b.colors),
        sub: tail,
        tone: b.waste === 'near_zero' || b.waste === 'low' ? 'clean' : 'plain',
      };
    }
    case 'ams': {
      if (b.colors === null) return null;
      const main = en ? `Up to ${b.colors} colours with AMS` : `حتى ${b.colors > 10 ? `${b.colors} لونًا` : arColours(b.colors)} مع AMS`;
      const purge = en ? 'purge on each swap' : 'هدر عند كل تبديل';
      return { main, sub: asSold ? `${asSold} · ${purge}` : purge, tone: 'purge' };
    }
    case 'single':
      return { main: count(1), sub: null, tone: 'plain' };
    default:
      return b.colors !== null && b.colors > 1 ? { main: en ? `Up to ${b.colors} colours` : `حتى ${arColours(b.colors)}`, sub: null, tone: 'plain' } : null;
  }
}

export default function MulticolorBadge({
  badge,
  lang,
  size = 'md',
  className = '',
}: {
  badge: MulticolorBadgeInfo | null | undefined;
  lang: Lang;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  const copy = size === 'xs' ? multicolorBadgeShort(badge, lang) : multicolorBadgeCopy(badge, lang);
  if (!copy) return null;
  const tone =
    copy.tone === 'clean'
      ? 'border-[color-mix(in_oklab,var(--color-success)_38%,transparent)] bg-[color-mix(in_oklab,var(--color-success)_10%,transparent)] text-text-primary'
      : copy.tone === 'purge'
        ? 'border-border-subtle bg-surface-selected text-text-primary'
        : 'border-border-subtle bg-transparent text-text-secondary';
  const icon =
    copy.tone === 'clean' ? 'text-success' : copy.tone === 'purge' ? 'text-warning' : 'text-text-muted';
  return (
    <span
      data-multicolor={badge?.kind}
      className={`inline-flex max-w-full items-start rounded-[10px] border ${tone} ${
        size === 'xs'
          ? 'gap-1 px-1 py-0.5 text-[10.5px] leading-[13px]'
          : size === 'sm'
            ? 'gap-1.5 px-1.5 py-1 text-[11px] leading-[14px]'
            : 'gap-1.5 px-2 py-1.5 text-[12px] leading-[16px]'
      } ${className}`}
    >
      <Palette aria-hidden="true" className={`mt-px shrink-0 ${icon} ${size === 'md' ? 'size-3.5' : 'size-3'}`} strokeWidth={2.2} />
      <span className="min-w-0">
        {/* Words break between words only: a count split letter by letter
            across three lines is not a badge. */}
        <span className="block font-bold [overflow-wrap:normal] [word-break:keep-all]">{copy.main}</span>
        {copy.sub ? <span className="block text-text-muted [overflow-wrap:normal]">{copy.sub}</span> : null}
      </span>
    </span>
  );
}
