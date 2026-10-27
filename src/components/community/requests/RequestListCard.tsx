/**
 * A PRINT REQUEST AS A CARD (community UI plan B2; IMG_8487 row 8, IMG_8462
 * (e), IMG_8468, IMG_8483, IMG_8475), in four variants:
 *
 *   row     the home on a phone: the media tile at the start, the title, the
 *           line «governorate • pieces • material», the line «offers |
 *           attachments», and at the end a column of its own holding the
 *           state pill beside the onward chevron, centred on the card
 *           (IMG_8487 row 8). The pill says «مفتوح» for a request receiving
 *           offers too, as the reference does beside «3 عروض»: the count
 *           says the offers. Words beside the tile keep at least 8.5rem; a
 *           card narrower than that and the end column (a phone under 375px)
 *           moves the end column onto a line of its own at the end, the same
 *           way on every card. Nothing is cut: the meta wraps between its
 *           words and the counts wrap whole
 *   aside   the desktop home aside: the words at the start, the 104 by 92
 *           media at the end, the state as a word
 *   list    the requests board (IMG_8483): ONE column of words at the start
 *           (the pill, the title on one line, the icon facts split by
 *           hairline bars, a hairline, «الموعد المطلوب» over its date, a
 *           hairline, «عرض الطلب ‹» and the counts) and the media square at
 *           the end, centred on the card beside all of it
 *   owner   «طلباتي»: the list anatomy plus what only the owner may read: the
 *           first picture, the budget with who sees it, the estimate, the
 *           chosen merchant, chips, and «إعادة الطلب», all in the column
 *
 * WHAT A PUBLIC CARD NEVER CARRIES. The budget (Q2, plan R2): the public type
 * `PublicRequestCard` has no budget field at all, so no public variant can be
 * handed one. A picture (plan R3): a public card draws a neutral glyph tile
 * (a box for filament, a drop for resin, a page for a description with no
 * file). A person (R10, acceptance 34): no name and no avatar.
 * tests/communityKitUi.test.ts pins all three.
 *
 * A JOB OF PARTS SAYS ONE COUNT OF EACH THING (P1-05 review 5, as the live
 * hub card hub/RequestCard.tsx says it): the parts under the tile, in the
 * words of jobCountWords («عدد الأجزاء 2»); the pieces in the meta, all of
 * them (the sets times the pieces of a set: «10 قطع», as IMG_8483 counts);
 * and the sets beside them when there are several («الأطقم: ×2»). Never two
 * different piece counts on one card.
 *
 * ONE LINK. A public card is one link to `/requests/:id`, the whole card its
 * target, with nothing pressable inside it. The owner card has a button
 * («إعادة الطلب»), so there the title is the link and stretches over the card
 * (`after:absolute after:inset-0`), and the button sits above it as a
 * sibling (`relative z-10`): never a button inside a link.
 *
 * Its words come from ./requestWords.ts, the hub own table, not from
 * requestStates.ts (another chunk). Digits are Latin in every language (R13).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Box, CalendarClock, FileText, Layers, MapPin, MessageSquare, Paperclip, Repeat } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { formatDate } from '../../orders/format';
import { iqdUnit } from '../../../lib/money';
import { OnwardChevron, kitButtonClass } from '../kit/buttons';
import { StatePill } from '../kit/display';
import { jobCountWords, localMaterial } from './mirrors';
import { RequestThumb } from './RequestFileThumbs';
import { CARD_WORDS, asCardLang, attachmentsWord, offersWord, piecesWord, requestGlyph, requestStateWord, type CardLang } from './requestWords';

/**
 * WHAT ANY READER MAY SEE OF A REQUEST: the public whitelist (worker
 * `publicRequest`) less what a card does not use. There is NO budget field,
 * on purpose (plan R2); the type is the guarantee.
 */
export interface PublicRequestCard {
  id: string;
  title: string;
  quantity?: number | null;
  material?: string | null;
  governorate?: string | null;
  state?: string | null;
  offer_count?: number | null;
  file_count?: number | null;
  deadline?: string | null;
  created_at?: string | null;
  /** P1-05: a job of parts, absent on an older Worker. */
  summary?: { parts_count: number; pieces_per_set: number } | null;
}

/** What the owner alone reads of their request (GET /api/marketplace/print/my-requests). */
export interface OwnerRequestCard extends PublicRequestCard {
  /** The first picture, through its authorised route (plan B3); null without one. */
  cover_url?: string | null;
  budget_iqd?: number | null;
  /** Q2: the owner turned «اعرض ميزانيتي للتجار» on; absent on an older Worker (then nothing is said). */
  budget_visible?: boolean | null;
  estimate_low_iqd?: number | null;
  estimate_high_iqd?: number | null;
  accepted_merchant?: string | null;
}

interface CommonProps {
  /** The heading level of the title in the page outline. */
  level?: 2 | 3;
  className?: string;
}

export type RequestListCardProps =
  | (CommonProps & { variant: 'row' | 'aside' | 'list'; request: PublicRequestCard })
  | (CommonProps & {
      variant: 'owner';
      request: OwnerRequestCard;
      /** Short facts the owner list already says (the review, a partial order). */
      chips?: string[];
      /** «إعادة الطلب»: the caller asks first, then copies. */
      onRepeat?: () => void;
    });

const LINK_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

/** «45,000 د.ع»: Latin digits in every language (plan R13), the number kept left to right. */
function Iqd({ value, lang }: { value: number; lang: string }) {
  return (
    <bdi className="whitespace-nowrap tabular-nums">
      <bdi dir="ltr">{Math.round(value).toLocaleString('en-US')}</bdi> {iqdUnit(lang as 'ar' | 'en' | 'ckb')}
    </bdi>
  );
}

export const requestCardPath = (id: string) => `/requests/${encodeURIComponent(id)}`;

/** The pieces a card counts: the sets times the pieces of a set (a parts job), else the quantity. */
function piecesOf(r: PublicRequestCard): number {
  const sets = Math.max(1, Number(r.quantity ?? 1) || 1);
  const perSet = Math.max(1, Number(r.summary?.pieces_per_set ?? 1) || 1);
  return sets * perSet;
}

/** A job of parts (P1-05), as the live hub card decides it: several parts, or more than one piece a set. */
function partsJob(r: PublicRequestCard): { parts_count: number; pieces_per_set: number } | null {
  const sum = r.summary;
  return sum && (sum.parts_count > 1 || sum.pieces_per_set > 1) ? sum : null;
}

/**
 * The resin glyph (the lucide droplet), drawn here: the droplet icon module is
 * already used by one lazy screen, and a second user would move it into the
 * shared icon chunk every store page downloads (vite.config.ts `iconChunk`).
 */
function DropGlyph({ className = '', strokeWidth = 2 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
    </svg>
  );
}

/**
 * The neutral media tile of a public card (plan R3): the process glyph on a
 * well and, for a job of several parts, the parts under it in the words of
 * the live card (jobCountWords). The pieces are the meta line, counted once.
 * The glyph is decoration; the parts are read aloud with the rest of the card.
 */
function GlyphTile({ r, width, height, L }: { r: PublicRequestCard; width: number; height: number; L: CardLang }) {
  const glyph = requestGlyph(r);
  const Glyph = glyph === 'resin' ? DropGlyph : glyph === 'text' ? FileText : Box;
  const job = partsJob(r);
  const parts = job && job.parts_count > 1 ? jobCountWords(job, L)[0] : '';
  const big = Math.min(width, height) >= 88;
  return (
    <span
      data-request-glyph={glyph}
      className="cm-line flex shrink-0 flex-col items-center justify-center gap-1 rounded-md bg-surface-selected text-text-secondary"
      style={{ inlineSize: width, blockSize: height }}
    >
      {/* Hidden from the reader: lucide marks its icons so, and DropGlyph says so itself. */}
      <Glyph className={big ? 'h-8 w-8' : 'h-6 w-6'} strokeWidth={1.5} />
      {parts && (
        <span data-request-parts={job!.parts_count} className="px-1 text-center text-[12px] font-semibold leading-tight tabular-nums">
          {parts}
        </span>
      )}
    </span>
  );
}

/** The media of a card: the owner first picture, else the glyph tile. */
function Media({ r, width, height, L, cover }: { r: PublicRequestCard; width: number; height: number; L: CardLang; cover?: string | null }) {
  if (cover && width === height) return <RequestThumb url={cover} size={width} className="cm-line" />;
  return <GlyphTile r={r} width={width} height={height} L={L} />;
}

export default function RequestListCard(props: RequestListCardProps) {
  const { request: r, variant, level = 3, className = '' } = props;
  const { lang } = useLanguage();
  const L = asCardLang(lang);
  const w = CARD_WORDS[L];
  const H = level === 2 ? 'h2' : 'h3';
  const to = requestCardPath(r.id);
  const offers = Number(r.offer_count ?? 0);
  const files = Number(r.file_count ?? 0);
  const place = r.governorate ? GOVERNORATE_LABELS[r.governorate]?.[L] ?? '' : '';
  const material = localMaterial(r.material, L);
  const pieces = piecesWord(piecesOf(r), L);
  // The sets of a job of parts ordered more than once, in the words of the live card: «الأطقم: ×2».
  const setCount = Math.max(1, Number(r.quantity ?? 1) || 1);
  const sets = partsJob(r) && setCount > 1 ? (
    <span data-request-sets={setCount} className="whitespace-nowrap">
      {w.sets}: <bdi dir="ltr">×{setCount}</bdi>
    </span>
  ) : null;
  // The row counts the offers on a line of its own, so its pill says «مفتوح» for a request receiving them (IMG_8487).
  const state = requestStateWord(r.state, L, { owner: variant === 'owner', offers, brief: variant === 'row' });
  const deadline = formatDate(r.deadline, lang);

  // «بغداد • 4 قطع • PETG»: the governorate, the pieces (and the sets of a parts job) and the
  // material, the reader own words. It wraps between its words rather than cutting the
  // material off; each bullet stays at the end of the line it closes, glued to it by a
  // no-break space. That space stays outside the hidden bullet, so the name of the card
  // link keeps its words apart («بغداد 4 قطع PETG», never «بغداد4 قطعPETG», B2R3-A11Y-1):
  // a plain space after the bullet is not enough, as Chromium leaves it out of the name
  // before a part that opens with a digit in a right-to-left line.
  const meta: React.ReactNode[] = [place, pieces, sets, material].filter(Boolean);
  const metaLine = (
    <span className="block break-words text-[13px] leading-snug text-text-secondary">
      {meta.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <>
              {'\u00a0'}
              <span aria-hidden="true">{'• '}</span>
            </>
          )}
          <bdi>{part}</bdi>
        </React.Fragment>
      ))}
    </span>
  );
  // «3 عروض | مرفقان»: the offers (or «بانتظار العروض») and the attachments, each word whole,
  // never cut. A card too narrow for both on one line puts the attachments on the next; the bar
  // between them hangs in the gap outside the attachments, so at the start of a line it falls
  // outside the box and is clipped, leaving no bar with nothing before it.
  const counts = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5 overflow-hidden text-[13px] leading-snug text-text-secondary">
      <span className="inline-flex items-center gap-1 whitespace-nowrap" data-request-offers={offers}>
        <MessageSquare aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        {offersWord(offers, L)}
      </span>
      {files > 0 && (
        <span className="relative inline-flex items-center gap-1 whitespace-nowrap" data-request-files={files}>
          <span aria-hidden="true" className="absolute end-full me-1.5 text-text-muted">
            |
          </span>
          <Paperclip aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          {attachmentsWord(files, L)}
        </span>
      )}
    </span>
  );
  if (variant === 'row') {
    return (
      <Link to={to} data-request-card="row" data-community-request={r.id} className={`cm-card flex min-h-[88px] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-3 shadow-sm active:shadow-press ${LINK_FOCUS} ${className}`}>
        <Media r={r} width={64} height={64} L={L} />
        {/* The words keep 8.5rem beside the tile. A card too narrow for that and
            the end column (a phone under 375px) puts the end column on a line
            of its own, at the end: the width decides, the same on every card. */}
        <div className="flex min-w-0 grow basis-[8.5rem] flex-col gap-0.5">
          <H dir="auto" className="truncate text-start text-[15px] font-bold leading-snug text-text-primary">
            {r.title}
          </H>
          {metaLine}
          {counts}
        </div>
        {/* The end column (IMG_8487 row 8): the state pill beside the chevron, centred on the card. */}
        <span className="ms-auto flex shrink-0 items-center gap-1.5" data-request-end>
          <StatePill tone={state.tone}>{state.word}</StatePill>
          <OnwardChevron className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
        </span>
      </Link>
    );
  }

  if (variant === 'aside') {
    return (
      <Link to={to} data-request-card="aside" data-community-request={r.id} className={`flex items-center gap-3 rounded-lg p-2 hover:bg-surface-selected ${LINK_FOCUS} ${className}`}>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <H dir="auto" className="line-clamp-2 break-words text-start text-[15px] font-bold leading-snug text-text-primary">
            {r.title}
          </H>
          {metaLine}
          <span className="text-[13px] font-semibold text-gold">{state.word}</span>
        </div>
        <Media r={r} width={104} height={92} L={L} />
      </Link>
    );
  }

  // The list and the owner anatomy (IMG_8468, IMG_8483; B2R2-FID-1): every word in ONE column at
  // the start, and the media square at the end, centred on the card beside all of it. Nothing runs
  // under the media: the deadline row and the footer close the column, as the reference draws them.
  const icon = 'h-4 w-4 shrink-0 text-text-muted';
  // «PETG | 4 قطع | بغداد»: each fact behind its icon, a hairline bar between two (IMG_8483). The bar
  // hangs in the gap before its fact, so a fact that wraps to the start of a line leaves its bar
  // outside the clipped box: never a bar with nothing before it, as the counts do it. The sets of a
  // parts job are a fact of their own beside the pieces, so the row wraps in two lines, not three.
  const factParts: React.ReactNode[] = [
    material && (
      <>
        <Layers aria-hidden="true" className={icon} strokeWidth={1.75} />
        <bdi>{material}</bdi>
      </>
    ),
    <>
      <Box aria-hidden="true" className={icon} strokeWidth={1.75} />
      <span className="tabular-nums">{pieces}</span>
    </>,
    sets,
    place && (
      <>
        <MapPin aria-hidden="true" className={icon} strokeWidth={1.75} />
        {place}
      </>
    ),
  ].filter(Boolean);
  const facts = (
    <span data-request-facts className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 overflow-hidden text-[13px] leading-snug text-text-secondary">
      {factParts.map((part, i) => (
        <span key={i} className="relative inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden="true" data-fact-bar className="absolute end-full me-1.5 h-3.5 w-px bg-border-subtle" />}
          {part}
        </span>
      ))}
    </span>
  );
  // The plan anatomy without the budget cell: «الموعد المطلوب» is the one cell of its row, its label
  // over its value as IMG_8483 stacks them, so a long date («5 تشرين الثاني 2026») fits the column.
  const needed = (
    <div data-request-needed className="flex items-start gap-1.5 border-t border-border-subtle pt-1.5">
      <CalendarClock aria-hidden="true" className={`${icon} mt-px`} strokeWidth={1.75} />
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] leading-4 text-text-secondary">{w.neededBy}</span>
        <span className="text-[15px] font-semibold leading-5 text-text-primary tabular-nums">{deadline || w.flexibleTiming}</span>
      </span>
    </div>
  );
  // «عرض الطلب ‹» at the start and the counts at the end; a column too narrow for both wraps the counts whole.
  const footer = (end: React.ReactNode) => (
    <div data-request-footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border-subtle pt-1.5">
      {end}
    </div>
  );

  if (variant === 'list') {
    return (
      <Link to={to} data-request-card="list" data-community-request={r.id} className={`cm-card flex items-center gap-3 rounded-xl p-2.5 shadow-sm active:shadow-press sm:p-3 ${LINK_FOCUS} ${className}`}>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5" data-request-main>
          <div className="flex flex-col items-start gap-0.5">
            <StatePill tone={state.tone}>{state.word}</StatePill>
            {/* One line, as the reference holds it: the whole title is still read aloud. */}
            <H dir="auto" className="w-full truncate text-start text-[17px] font-bold leading-snug text-text-primary">
              {r.title}
            </H>
            {facts}
          </div>
          {needed}
          {footer(
            <>
              <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-gold">
                {w.viewRequest}
                <OnwardChevron />
              </span>
              {counts}
            </>
          )}
        </div>
        <Media r={r} width={112} height={112} L={L} />
      </Link>
    );
  }

  // The owner card, the same anatomy: the title is the link, stretched over the card, and the one
  // button sits above it. What only the owner reads joins the column, between the facts and the deadline.
  const own = r as OwnerRequestCard;
  const { chips = [], onRepeat } = props as Extract<RequestListCardProps, { variant: 'owner' }>;
  const low = own.estimate_low_iqd ?? null;
  const high = own.estimate_high_iqd ?? null;
  return (
    <article data-request-card="owner" data-community-request={r.id} className={`cm-card relative flex items-center gap-3 rounded-xl p-2.5 shadow-sm sm:p-3 ${className}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5" data-request-main>
        <div className="flex flex-col items-start gap-0.5">
          <StatePill tone={state.tone}>{state.word}</StatePill>
          <H dir="auto" className="w-full truncate text-start text-[17px] font-bold leading-snug text-text-primary">
            <Link to={to} className={`rounded-sm after:absolute after:inset-0 after:rounded-xl after:content-[''] ${LINK_FOCUS}`}>
              {r.title}
            </Link>
          </H>
          {facts}
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <StatePill key={c} tone="waiting">
                {c}
              </StatePill>
            ))}
          </div>
        )}
        {own.budget_iqd !== null && own.budget_iqd !== undefined && (
          <div className="flex flex-col gap-0.5 border-t border-border-subtle pt-1.5 text-[13px]" data-request-budget>
            <span className="flex items-center gap-2">
              <span className="text-text-secondary">{w.budget}</span>
              <span className="ms-auto font-bold text-text-primary">
                <Iqd value={own.budget_iqd} lang={lang} />
              </span>
            </span>
            {own.budget_visible !== null && own.budget_visible !== undefined && (
              <span className="text-[12px] text-text-muted" data-request-budget-visible={own.budget_visible ? 'merchants' : 'hidden'}>
                {own.budget_visible ? w.budgetShown : w.budgetHidden}
              </span>
            )}
          </div>
        )}
        {(low !== null || high !== null) && (
          <span className="flex flex-wrap items-center gap-x-2 text-[13px]">
            <span className="text-text-secondary">{w.estimate}</span>
            <span className="ms-auto font-semibold text-text-primary">
              {low !== null && <Iqd value={low} lang={lang} />}
              {low !== null && high !== null && high !== low && (
                <>
                  {' – '}
                  <Iqd value={high} lang={lang} />
                </>
              )}
              {low === null && high !== null && <Iqd value={high} lang={lang} />}
            </span>
          </span>
        )}
        {own.accepted_merchant && (
          <span className="flex items-center gap-2 text-[13px]">
            <span className="text-text-secondary">{w.acceptedBy}</span>
            <bdi className="ms-auto truncate font-semibold text-text-primary">{own.accepted_merchant}</bdi>
          </span>
        )}
        {needed}
        {footer(
          <>
            {counts}
            {onRepeat && (
              <button type="button" onClick={onRepeat} className={`${kitButtonClass('secondary', 'compact')} relative z-10`}>
                <Repeat aria-hidden="true" className="h-4 w-4" />
                {w.repeat}
              </button>
            )}
          </>
        )}
      </div>
      <Media r={r} width={112} height={112} L={L} cover={own.cover_url} />
    </article>
  );
}
