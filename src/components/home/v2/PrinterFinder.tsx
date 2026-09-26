import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../../LanguageContext';
import { useCommunityAccess } from '../../../pages/community/access';

/**
 * «محتار أي طابعة تناسبك؟» — the divider between browsing and buying.
 *
 * THREE REAL DOORS, no new feature behind any of them:
 *  - «قارن الطابعات»   → /compare, the comparison page (verdict, chart, table);
 *  - «ساعدني أختار»    → the support assistant's «ساعدني باختيار طابعة» flow,
 *                        opened directly (`/support?ask=choose_printer`, see
 *                        src/pages/Support.tsx). It is the shop's existing
 *                        printer advisor: it lists the printers actually in
 *                        stock with their spec sheets and offers to compare
 *                        two — the questions-then-shortlist the copy promises;
 *  - «اسأل مجتمع Levo» → /community, hidden while the server says the
 *                        community is shut (the same gate as the bottom bar).
 *
 * A band with a hairline plate texture, the one beat between the bento and
 * the product rail whose job is to stop the scroll for a moment. It follows
 * the theme (`data-feature`, src/index.css FEATURE SURFACES): charcoal with
 * olive hairlines and the muted-gold primary on the dark theme; a cream card
 * with ink type, a charcoal primary and an outlined secondary on the light.
 */
export default function PrinterFinder() {
  const { loc } = useLanguage();
  const { access } = useCommunityAccess();
  const communityShut = access?.may_enter === false;

  const secondary =
    'inline-flex min-h-11 min-w-0 flex-auto items-center justify-center rounded-xl border border-white/15 px-2.5 text-center text-[11.5px] font-semibold leading-4 text-ivory transition-colors hover:border-white/30 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted lg:flex-none lg:px-6 lg:text-[14px]';

  return (
    <section
      data-home-section="printer_finder"
      data-feature=""
      aria-labelledby="home-finder-title"
      className="lv-finder-texture relative overflow-hidden rounded-2xl bg-charcoal px-3 py-4 ring-1 ring-inset ring-white/[0.05] lg:flex lg:items-center lg:justify-between lg:gap-10 lg:rounded-[20px] lg:px-10 lg:py-8"
    >
      <div className="text-center lg:text-start">
        {/* OWNER: Sorani to be written by hand (this section's three strings and three labels). */}
        <h2 id="home-finder-title" className="text-[16px] font-bold leading-6 text-ivory lg:text-[24px] lg:leading-9">
          {loc('محتار أي طابعة تناسبك؟', 'Not sure which printer suits you?')}
        </h2>
        <p className="mt-0.5 text-[12px] leading-5 text-text-secondary lg:mt-1 lg:text-[15px] lg:leading-6">
          {loc(
            'أجب على بعض الأسئلة البسيطة وسنرشح لك أفضل الخيارات.',
            'Answer a few simple questions and we will suggest the best options.'
          )}
        </p>
      </div>
      <div className="mt-3 flex items-stretch gap-1.5 lg:mt-0 lg:shrink-0 lg:gap-3">
        <Link to="/compare" className={secondary}>
          {loc('قارن الطابعات', 'Compare printers')}
        </Link>
        <Link
          to="/support?ask=choose_printer"
          className="inline-flex min-h-11 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-xl bg-gold-muted px-2.5 text-center text-[11.5px] font-bold leading-4 text-gold-ink transition-[filter] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ivory lg:flex-none lg:px-7 lg:text-[14px]"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="hidden h-4 w-4 shrink-0 lg:block">
            <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l1.8 1.8M10.8 10.8l1.8 1.8M3.4 12.6l1.8-1.8M10.8 5.2l1.8-1.8" />
          </svg>
          {loc('ساعدني أختار', 'Help me choose')}
        </Link>
        {communityShut ? null : (
          <Link to="/community" className={secondary}>
            {loc('اسأل مجتمع Levo', 'Ask the Levo community')}
          </Link>
        )}
      </div>
    </section>
  );
}
