import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, WandSparkles } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * «لست متأكدًا أيها يناسبك؟» (§6 item 5, printers only): one quiet row that
 * opens the printer finder. A surface card with the finder's gold wand on a
 * charcoal square — the only gold on the page below the hero, where the
 * shopper who scrolled past every shelf is most likely to need it.
 */
export default function FinderBand() {
  const { loc, dir } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <Link
      to="/printer-finder"
      data-finder-band
      className="group flex items-center gap-3 rounded-[18px] border border-border-subtle bg-surface p-3.5 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:gap-5 lg:p-6"
    >
      <span data-theme="dark" aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-xl bg-charcoal text-gold-muted lg:size-14">
        <WandSparkles className="size-5 lg:size-6" />
      </span>
      <span className="min-w-0 flex-1">
        {/* OWNER: Sorani to be written by hand (both lines). */}
        <span className="block text-[14px] font-extrabold leading-5 text-text-primary lg:text-[18px] lg:leading-7">
          {loc('لست متأكدًا أيها يناسبك؟', 'Not sure which one suits you?')}
        </span>
        <span className="block text-[12px] leading-[17px] text-text-muted lg:text-[14px] lg:leading-6">
          {loc('ستة أسئلة قصيرة، ونرشّح لك أفضل ثلاث طابعات مع السبب.', 'Six short questions, and we suggest the best three printers with the reason.')}
        </span>
      </span>
      <Chevron aria-hidden="true" className="size-5 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5 motion-reduce:transition-none" />
    </Link>
  );
}
