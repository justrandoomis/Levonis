/**
 * THE WORKSHOP'S FACTS — the hero's facts row and the words the stats block's
 * two workshop figures share (Phase 5d, docs/COMMUNITY_ECOSYSTEM.md §9.5).
 *
 * ITS OWN SMALL LAZY CHUNK (review 2026-09-30): it lived in ./extra.tsx, the
 * non-classic blocks' chunk, so every classic workshop store (most print
 * workshops carry facts) fetched those 9 KB of blocks it never draws during
 * its first render. ./Hero.tsx loads this module alone; ./Stats.tsx imports
 * the words from here too, so the two can never say one fact two ways.
 */
import { useLanguage } from '../../../LanguageContext';
import { useStoreTheme } from '../StoreTheme';
import type { StoreWorkshop } from './Hero';

/**
 * THE WORKSHOP'S WORDS — Arabic, English and hand-written Sorani, every key in
 * all three (D6). They live here, in this small lazy chunk, and not in
 * ../strings.ts ON PURPOSE: that table ships with every store visit (the
 * storefront closure, tests/bundleBudget.test.ts), and these words are needed
 * only by a store whose read carries workshop facts — the hero's facts row
 * (`WorkshopFacts` below) and the stats block's two figures (./Stats.tsx).
 */
export const WORKSHOP_WORDS = {
  ar: {
    label: 'عن الورشة',
    custom: 'يستقبل طلبات مخصصة',
    resin: 'ريزن',
    upTo: (size: string) => `حتى ${size} مم`,
    usually: (n: number) =>
      n === 1 ? 'عادةً خلال يوم' : n === 2 ? 'عادةً خلال يومين' : n % 100 >= 3 && n % 100 <= 10 ? `عادةً خلال ${n} أيام` : `عادةً خلال ${n} يومًا`,
    turnaroundStat: 'أيام للتنفيذ عادةً',
    buildStat: 'أكبر حجم طباعة (مم)',
  },
  en: {
    label: 'About the workshop',
    custom: 'Takes custom requests',
    resin: 'Resin',
    upTo: (size: string) => `Up to ${size} mm`,
    usually: (n: number) => (n === 1 ? 'Usually within a day' : `Usually within ${n} days`),
    turnaroundStat: 'Usual turnaround (days)',
    buildStat: 'Largest print (mm)',
  },
  ckb: {
    label: 'دەربارەی وۆرکشۆپەکە',
    custom: 'داواکاری تایبەت وەردەگرێت',
    resin: 'ڕەزین',
    upTo: (size: string) => `تا ${size} میلیمەتر`,
    usually: (n: number) => `بە زۆری لە ماوەی ${n} ڕۆژدا`,
    turnaroundStat: 'ڕۆژی جێبەجێکردن بە زۆری',
    buildStat: 'گەورەترین قەبارەی چاپ (میلیمەتر)',
  },
} as const;

export type WorkshopWords = (typeof WORKSHOP_WORDS)['ar'];

export function workshopWords(lang: string): WorkshopWords {
  return (lang === 'en' ? WORKSHOP_WORDS.en : lang === 'ckb' ? WORKSHOP_WORDS.ckb : WORKSHOP_WORDS.ar) as WorkshopWords;
}

/** «256 × 256 × 300» — a figure, left to right in every language. */
export function buildFigure(build: NonNullable<StoreWorkshop['build']>, sep = ' × '): string {
  return build.join(sep);
}

/**
 * THE WORKSHOP'S FACTS ROW (Phase 5d, §9.5), for ./Hero.tsx to load lazily
 * under every hero variant: «يستقبل طلبات مخصصة» in the store's accent, then
 * the technologies, the largest build and the usual turnaround as quiet
 * chips. ONE line of a fixed height (the frame Hero.tsx holds while this
 * chunk is on its way is the same 28 px), scrolling sideways — edge to edge —
 * on a narrow phone rather than wrapping into a second line nobody reserved.
 */
export function WorkshopFacts({ workshop }: { workshop: StoreWorkshop }) {
  const { lang } = useLanguage();
  const { accent } = useStoreTheme();
  const w = workshopWords(lang);
  const chip = 'shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] leading-none';
  const quiet = `${chip} border border-white/10 text-zinc-300`;
  return (
    // Edge to edge on a phone (`-mx-4 px-4`, the column's own gutter): a chip cut by the screen's edge says «there is more».
    <ul aria-label={w.label} className="-mx-4 flex h-7 items-center gap-1.5 overflow-x-auto px-4 hide-scrollbar" data-store-workshop>
      {workshop.custom && (
        <li className={`${chip} font-medium ${accent.chip}`} data-store-workshop-fact="custom">
          {w.custom}
        </li>
      )}
      {workshop.technologies.map((t) => (
        <li key={t} className={quiet} data-store-workshop-fact={t}>
          {t === 'fdm' ? 'FDM' : w.resin}
        </li>
      ))}
      {workshop.build && (
        <li className={quiet} data-store-workshop-fact="build">
          {/* The figure is a left-to-right island (LRI … PDI): «256 × 256 × 300» must not run backwards in Arabic. */}
          {w.upTo(`\u2066${buildFigure(workshop.build)}\u2069`)}
        </li>
      )}
      {workshop.turnaround !== null && (
        <li className={quiet} data-store-workshop-fact="turnaround">
          {w.usually(workshop.turnaround)}
        </li>
      )}
    </ul>
  );
}
