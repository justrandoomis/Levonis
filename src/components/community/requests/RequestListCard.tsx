/**
 * A PRINT REQUEST AS A CARD (community UI plan B2; IMG_8487 row 8, IMG_8462
 * (e), IMG_8468, IMG_8483, IMG_8475), in four variants:
 *
 *   row     the home on a phone: the media tile at the start, the title, one
 *           line «governorate • pieces • material», one line «offers |
 *           attachments», the state pill and the onward chevron at the end
 *   aside   the desktop home aside: the words at the start, the 104 by 92
 *           media at the end, the state as a word
 *   list    the requests board: the media square at the end, the pill, the
 *           title, the icon meta row, «الموعد المطلوب» across the card, and
 *           «عرض الطلب ‹» beside the counts
 *   owner   «طلباتي»: the list anatomy plus what only the owner may read: the
 *           first picture, the budget with who sees it, the estimate, the
 *           chosen merchant, chips, and «إعادة الطلب»
 *
 * WHAT A PUBLIC CARD NEVER CARRIES. The budget (Q2, plan R2): the public type
 * `PublicRequestCard` has no budget field at all, so no public variant can be
 * handed one. A picture (plan R3): a public card draws a neutral glyph tile
 * (a box for filament, a drop for resin, a page for a description with no
 * file, and the pieces of a parts job under it). A person (R10, acceptance
 * 34): no name and no avatar. tests/communityKitUi.test.ts pins all three.
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
import { localMaterial } from './mirrors';
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

/** The neutral media tile of a public card (plan R3): the process glyph on a well, the pieces of a parts job under it. */
function GlyphTile({ r, width, height, L }: { r: PublicRequestCard; width: number; height: number; L: CardLang }) {
  const glyph = requestGlyph(r);
  const Glyph = glyph === 'resin' ? DropGlyph : glyph === 'text' ? FileText : Box;
  const perSet = Number(r.summary?.pieces_per_set ?? 1);
  const big = Math.min(width, height) >= 88;
  return (
    <span
      aria-hidden="true"
      data-request-glyph={glyph}
      className="cm-line flex shrink-0 flex-col items-center justify-center gap-1 rounded-md bg-surface-selected text-text-secondary"
      style={{ inlineSize: width, blockSize: height }}
    >
      <Glyph className={big ? 'h-8 w-8' : 'h-6 w-6'} strokeWidth={1.5} />
      {perSet > 1 && <span className="text-[12px] font-semibold tabular-nums">{piecesWord(perSet, L)}</span>}
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
  const state = requestStateWord(r.state, L, { owner: variant === 'owner', offers });
  const deadline = formatDate(r.deadline, lang);

  // «بغداد • 4 قطع • PETG»: the governorate, the pieces and the material, the reader own words.
  const meta = [place, pieces, material].filter(Boolean);
  const metaLine = (
    <span className="block truncate text-[13px] text-text-secondary">
      {meta.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span aria-hidden="true"> • </span>}
          <bdi>{part}</bdi>
        </React.Fragment>
      ))}
    </span>
  );
  // «3 عروض | مرفقان»: the offers (or «بانتظار العروض») and the attachments.
  const counts = (
    <span className="flex min-w-0 items-center gap-2 whitespace-nowrap text-[13px] text-text-secondary">
      <span className="inline-flex shrink-0 items-center gap-1" data-request-offers={offers}>
        <MessageSquare aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        {offersWord(offers, L)}
      </span>
      {files > 0 && (
        <>
          <span aria-hidden="true" className="text-text-muted">
            |
          </span>
          <span className="inline-flex min-w-0 items-center gap-1">
            <Paperclip aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{attachmentsWord(files, L)}</span>
          </span>
        </>
      )}
    </span>
  );
  const title = (
    <H dir="auto" className="line-clamp-2 break-words text-start text-[17px] font-bold leading-snug text-text-primary">
      {r.title}
    </H>
  );

  if (variant === 'row') {
    return (
      <Link to={to} data-request-card="row" data-community-request={r.id} className={`cm-card flex min-h-[88px] items-center gap-3 rounded-xl p-3 shadow-sm active:shadow-press ${LINK_FOCUS} ${className}`}>
        <Media r={r} width={64} height={64} L={L} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <H dir="auto" className="truncate text-start text-[15px] font-bold text-text-primary">
            {r.title}
          </H>
          {metaLine}
          {/* On a phone the pill shares the counts line, at its end (plan R7: a
              row that packs three things wraps rather than starving the words). */}
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            {counts}
            <StatePill tone={state.tone} className="ms-auto shrink-0">
              {state.word}
            </StatePill>
          </div>
        </div>
        <OnwardChevron className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
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

  // The list and the owner anatomy (IMG_8468, IMG_8483): words at the start, the media square at the end.
  const icon = 'h-4 w-4 shrink-0 text-text-muted';
  const facts = (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-secondary">
      {material && (
        <span className="inline-flex items-center gap-1">
          <Layers aria-hidden="true" className={icon} strokeWidth={1.75} />
          <bdi>{material}</bdi>
        </span>
      )}
      <span className="inline-flex items-center gap-1 tabular-nums">
        <Box aria-hidden="true" className={icon} strokeWidth={1.75} />
        {pieces}
      </span>
      {place && (
        <span className="inline-flex items-center gap-1">
          <MapPin aria-hidden="true" className={icon} strokeWidth={1.75} />
          {place}
        </span>
      )}
    </span>
  );
  // The plan anatomy without the budget cell: «الموعد المطلوب» takes the full width.
  const needed = (
    <div className="flex items-center gap-2 border-t border-border-subtle pt-2.5 text-[13px]">
      <CalendarClock aria-hidden="true" className={icon} strokeWidth={1.75} />
      <span className="text-text-secondary">{w.neededBy}</span>
      <span className="ms-auto font-semibold text-text-primary tabular-nums">{deadline || w.flexibleTiming}</span>
    </div>
  );

  if (variant === 'list') {
    return (
      <Link to={to} data-request-card="list" data-community-request={r.id} className={`cm-card flex flex-col gap-2.5 rounded-xl p-3 shadow-sm active:shadow-press sm:p-4 ${LINK_FOCUS} ${className}`}>
        <div className="flex gap-3">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
            <StatePill tone={state.tone}>{state.word}</StatePill>
            {title}
            {facts}
          </div>
          <Media r={r} width={112} height={112} L={L} />
        </div>
        {needed}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2.5">
          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-gold">
            {w.viewRequest}
            <OnwardChevron />
          </span>
          {counts}
        </div>
      </Link>
    );
  }

  // The owner card: the title is the link, stretched over the card, and the one button sits above it.
  const own = r as OwnerRequestCard;
  const { chips = [], onRepeat } = props as Extract<RequestListCardProps, { variant: 'owner' }>;
  const low = own.estimate_low_iqd ?? null;
  const high = own.estimate_high_iqd ?? null;
  return (
    <article data-request-card="owner" data-community-request={r.id} className={`cm-card relative flex flex-col gap-2.5 rounded-xl p-3 shadow-sm sm:p-4 ${className}`}>
      <div className="flex gap-3">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
          <StatePill tone={state.tone}>{state.word}</StatePill>
          <H dir="auto" className="line-clamp-2 break-words text-start text-[17px] font-bold leading-snug text-text-primary">
            <Link to={to} className={`rounded-sm after:absolute after:inset-0 after:rounded-xl after:content-[''] ${LINK_FOCUS}`}>
              {r.title}
            </Link>
          </H>
          {facts}
        </div>
        <Media r={r} width={112} height={112} L={L} cover={own.cover_url} />
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
        <div className="flex flex-col gap-0.5 border-t border-border-subtle pt-2.5 text-[13px]" data-request-budget>
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
        <span className="flex items-center gap-2 text-[13px]">
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2.5">
        {counts}
        {onRepeat && (
          <button type="button" onClick={onRepeat} className={`${kitButtonClass('secondary', 'compact')} relative z-10`}>
            <Repeat aria-hidden="true" className="h-4 w-4" />
            {w.repeat}
          </button>
        )}
      </div>
    </article>
  );
}
