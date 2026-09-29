/**
 * A PRINT REQUEST ON THE BOARD, as a card that opens it.
 *
 * It says what the job IS — how many, in what, for how much, where, by when —
 * and how many offers it has, because that is what decides whether a workshop
 * taps it. The card used to say «بانتظار العروض» over every request, including
 * one that already had three, and led nowhere: the request's own page
 * (`/requests?request=<id>`, where offers are made and compared) was never
 * linked from here.
 *
 * No person is named on the card, as on the board: the job is the point, and
 * the display name is one tap away on the request's page.
 *
 * `compact` is the home's three-row preview: the title on one line, the
 * chips, and the footer — a hairline row (`lv-section`), not a box. (The
 * chips wrap: a sideways-scrolling row inside the card's link made Chrome
 * scroll the whole page in RTL.)
 */
import { Link } from 'react-router-dom';
import { CalendarClock, MapPin, Paperclip } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMoney } from '../../../CurrencyContext';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { offersLabel, shortDate, timeAgo } from './copy';
import { fill, useHubStrings } from './strings';
import type { CommunityRequest } from './api';

const CHIP = 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border-subtle/60 bg-surface px-2 py-0.5';

export default function RequestCard({ request: r, compact = false }: { request: CommunityRequest; compact?: boolean }) {
  const { lang, loc } = useLanguage();
  const s = useHubStrings();
  const { money } = useMoney();
  const place = r.governorate ? GOVERNORATE_LABELS[r.governorate]?.[lang] ?? '' : '';
  const offers = r.offer_count ?? 0;
  const deadline = shortDate(r.deadline, lang);

  const chips = (
    <>
      {r.budget_iqd != null && r.budget_iqd > 0 && (
        <span className={`${CHIP} font-semibold text-gold`}>
          {loc('الميزانية', 'Budget', 'بودجە')}: <bdi className="tabular-nums">{money(r.budget_iqd)}</bdi>
        </span>
      )}
      {(r.quantity ?? 1) > 1 && (
        <span className={`${CHIP} tabular-nums`}>
          <bdi dir="ltr">×{r.quantity}</bdi>
        </span>
      )}
      {r.material && (
        <span className={CHIP}>
          <bdi>{r.material}</bdi>
        </span>
      )}
      {place && (
        <span className={CHIP}>
          <MapPin className="h-3 w-3" aria-hidden="true" />
          {place}
        </span>
      )}
      {deadline && (
        <span className={CHIP}>
          <CalendarClock className="h-3 w-3" aria-hidden="true" />
          {/* «حتى», not «قبل»: the card already says «قبل 6 ساعات» for when it
              was posted, and one word for both would read as the past. */}
          {fill(s.byDeadline, { d: deadline })}
        </span>
      )}
      {(r.file_count ?? 0) > 0 && (
        <span className={`${CHIP} tabular-nums`}>
          <Paperclip className="h-3 w-3" aria-hidden="true" />
          {r.file_count}
          <span className="sr-only">{s.filesAttached}</span>
        </span>
      )}
    </>
  );

  const footer = (
    <div className="mt-auto flex items-center justify-between gap-3 pt-1 text-[11.5px]">
      <span className={offers > 0 ? 'font-semibold text-text-secondary' : 'font-semibold text-sage'} data-community-request-offers={offers}>
        {offersLabel(offers, lang)}
      </span>
      <span className="text-text-muted">{timeAgo(r.created_at, lang)}</span>
    </div>
  );

  if (compact) {
    return (
      <Link
        to={`/requests?request=${encodeURIComponent(r.id)}`}
        data-community-request={r.id}
        className="lv-section flex min-w-0 flex-col gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <h3 dir="auto" className="line-clamp-1 break-words text-start text-[14.5px] font-semibold leading-snug text-text-primary">{r.title}</h3>
        <div className="flex flex-wrap gap-1.5 text-[11.5px] text-text-secondary">{chips}</div>
        {footer}
      </Link>
    );
  }

  return (
    <Link
      to={`/requests?request=${encodeURIComponent(r.id)}`}
      data-community-request={r.id}
      className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border-subtle/60 bg-surface p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {/* The customer's own words, in whichever script they wrote them —
          `dir="auto"` lays an English title out left-to-right inside the
          Arabic page instead of moving its full stop to the front. */}
      <h3 dir="auto" className="break-words text-start text-[14.5px] font-semibold leading-snug text-text-primary">{r.title}</h3>
      {r.description && (
        <p dir="auto" className="line-clamp-2 break-words text-start text-[12.5px] leading-relaxed text-text-secondary">{r.description}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-text-secondary">{chips}</div>
      {footer}
    </Link>
  );
}
