/**
 * «قيّم طابعتك» — /rewards/rate (rewards spec §3.4): every printer Levonis
 * delivered to this customer, the state of its review and gift and the next
 * step, then how the gift is earned and what each level gives.
 *
 * WHO RENDERS WHAT (src/pages/RewardsArea.tsx)
 * - The frame draws the header (h1 «قيّم طابعتك»), the scroller and its
 *   `space-y-4` column; this returns the screen's blocks.
 * - Session loading: the frame draws the rate skeleton. A guest: the frame
 *   draws the sign-in state (guest.rate.*). A signed-in customer: this.
 * - The frame draws the StaleLine above the screen when `hub.stale`, and
 *   «المزيد في المكافآت» (RelatedDoors, current="rate") after it; neither is
 *   drawn here.
 *
 * By `hub.status`:
 * - 'idle' | 'loading': the rate skeleton (./AreaChrome), at this geometry.
 * - 'error' (no data): ErrorState with its retry.
 * - 'ready', `installed === false`: SetupState.
 * - 'ready', no printers: the EmptyState (a way to choose a printer), then the
 *   how-to, the levels and the two notes.
 * - 'ready': the lead line; THE FOCAL PRINTER — the screen's one raised card,
 *   holding its one primary link — when the first printer by actionability
 *   has a gift to choose, or is still to rate and has a page to review it on;
 *   «طابعاتك», the rest, as flat rows with a secondary link where a step is
 *   left; «تُعرض أحدث 20 طابعة استلمتها» at the server's cap; «كيف تربح
 *   الهدية» with the Instagram handle to copy; «مستويات الهدايا»; the
 *   no-level line and the decision note.
 *
 * DECIDES NOTHING. States, gift levels, stars, `rating.no_level_points` and
 * the 20-printer cap are the server's (worker/routes/rewardsProgram.ts
 * `printersToRate`, `giftLevels`); the screen only orders the printers — what
 * needs the customer first, the server's order (newest delivered) within each
 * state. No clock and no request here: every way out is a link
 * (/product/<slug>#reviews, /gifts, /printer-finder). No gold either: the
 * level discs are ink, the chips neutral, warning or success.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Star } from 'lucide-react';
import { IconButton } from '../ui/Button';
import { StatusChip, type Tone } from '../ui/Badge';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import SafeImage from '../ui/SafeImage';
import { copyText as copyToClipboard } from '../../lib/copyText';
import { formatFigure } from '../../lib/localeNumber';
import type { Language } from '../../translations';
import { formatDate } from '../orders/format';
import { RateSkeleton, SectionHeading, SetupState } from './AreaChrome';
import { pointsForm, type CopyKey } from './copy';
import type { PrinterToRate, RewardsHubData } from './types';
import type { Read } from './useRewardsData';
import { useRewardsT } from './useT';

export interface RateScreenProps {
  /** GET /api/rewards/program (useRewardsHub): `printers`, `rating`. */
  hub: Read<RewardsHubData>;
}

/** The most printers the server lists (worker `printersToRate`: newest delivered first, LIMIT 20). */
export const PRINTERS_SHOWN_MAX = 20;

/** The account to mention in the Instagram story (rate.step2). */
export const INSTAGRAM_HANDLE = '@levonis_iq';

/** How long the copy button shows its tick. */
const COPIED_MS = 2_000;

/** What needs the customer first: a gift to choose, a review to write, a decision to wait for, done. */
const ACTIONABILITY: Readonly<Record<PrinterToRate['state'], number>> = {
  reward_approved: 0,
  to_rate: 1,
  reward_pending: 2,
  rated: 3,
};

/** A state a newer server may add sorts after every known one. */
const UNKNOWN_RANK = 4;

export interface RatePlan {
  /** The screen's one raised card, or null when the first printer has no step to take from here. */
  focal: PrinterToRate | null;
  /** Every other printer, in order: «طابعاتك». */
  rest: PrinterToRate[];
}

/**
 * The printers in the order the screen lists them — gift to choose, to rate,
 * awaiting the gift decision, rated; the server's order within each — and the
 * focal one: the FIRST of them, when it has a gift to choose, or is still to
 * rate and has a page to write the review on. The rest stay in the list.
 */
export function ratePlan(printers: readonly PrinterToRate[]): RatePlan {
  const rank = (p: PrinterToRate) => ACTIONABILITY[p.state] ?? UNKNOWN_RANK;
  const sorted = printers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);
  const first = sorted[0];
  const focal = first && (first.state === 'reward_approved' || (first.state === 'to_rate' && !!first.slug)) ? first : null;
  return { focal, rest: focal ? sorted.slice(1) : sorted };
}

/** A figure the server sent (a level, the stars, the no-level points), or null for none. */
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Where a printer's review is written. */
const reviewPath = (slug: string) => `/product/${encodeURIComponent(slug)}#reviews`;

type T = ReturnType<typeof useRewardsT>['t'];

/** A printer's state as its chip says it (word, dot and tint); null when there is nothing honest to say. */
function printerChip(p: PrinterToRate, t: T, lang: Language): { tone: Tone; text: string } | null {
  switch (p.state) {
    case 'to_rate':
      return { tone: 'neutral', text: t('rate.toRate') };
    case 'reward_pending':
      return { tone: 'warning', text: t('rate.pending') };
    case 'reward_approved': {
      const level = positive(p.reward_level);
      return { tone: 'success', text: level !== null ? t('rate.approved', { level: formatFigure(level, lang) }) : t('now.gift') };
    }
    case 'rated': {
      const stars = positive(p.stars);
      return stars !== null ? { tone: 'neutral', text: t('rate.rated', { stars: formatFigure(stars, lang) }) } : null;
    }
    default:
      return null;
  }
}

/** The policy's words for a level the admin wrote no description for (chapter 8). */
const LEVEL_WORDS: Readonly<Record<number, CopyKey>> = {
  1: 'rate.level1',
  2: 'rate.level2',
  3: 'rate.level3',
  4: 'rate.level4',
  5: 'rate.level5',
};

// ------------------------------------------------------------ the screen

export function RateScreen({ hub }: RateScreenProps) {
  if (hub.status === 'idle' || hub.status === 'loading') return <RateSkeleton />;
  const data = hub.data;
  if (hub.status === 'error' || !data) return <ErrorState error={hub.error} onRetry={() => void hub.reload()} />;
  if (data.installed === false) return <SetupState />;
  return <RateReady data={data} />;
}

function RateReady({ data }: { data: RewardsHubData }) {
  const { t, lang } = useRewardsT();
  const printers = Array.isArray(data.printers) ? data.printers : [];

  if (printers.length === 0) {
    return (
      <>
        <EmptyState
          icon={<Star className="w-6 h-6" aria-hidden="true" />}
          title={t('rate.empty.title')}
          description={t('rate.empty.body')}
          action={
            <Link to="/printer-finder" className="lv-button lv-button-secondary mt-1">
              {t('help.choosePrinter')}
            </Link>
          }
        />
        <HowTo />
        <GiftRules rating={data.rating} />
      </>
    );
  }

  const { focal, rest } = ratePlan(printers);
  return (
    <>
      <p className="px-1 text-[13px] leading-6 text-text-secondary">{t('rate.lead')}</p>
      {focal && <FocalPrinter printer={focal} />}
      {rest.length > 0 && (
        <section aria-labelledby="rate-printers-title" className="space-y-2">
          <SectionHeading id="rate-printers-title">{t('rate.printers')}</SectionHeading>
          <ul className="space-y-2">
            {rest.map((p) => (
              <PrinterRow key={`${p.order_id}:${p.product_id}`} printer={p} />
            ))}
          </ul>
          {printers.length >= PRINTERS_SHOWN_MAX && (
            <p className="px-1 text-[12px] leading-5 text-text-muted">{t('rate.capped', { n: formatFigure(printers.length, lang) })}</p>
          )}
        </section>
      )}
      <HowTo />
      <GiftRules rating={data.rating} />
    </>
  );
}

// ------------------------------------------------------------ the printers

/** The next printer: its gift to choose (/gifts) or its review to write (its page). The screen's one primary. */
function FocalPrinter({ printer: p }: { printer: PrinterToRate }) {
  const { t, tri, lang } = useRewardsT();
  const approved = p.state === 'reward_approved';
  const chip = printerChip(p, t, lang);
  const level = positive(p.reward_level);
  const delivered = formatDate(p.delivered_at, lang);
  const line = approved
    ? level !== null
      ? t('now.gift.body', { level: formatFigure(level, lang) })
      : t('door.rate.gift')
    : delivered
      ? t('rate.delivered', { date: delivered })
      : '';
  return (
    <section aria-labelledby="rate-next-title" className="lv-surface-raised p-4 space-y-3">
      <div className="flex items-start gap-3">
        <SafeImage src={p.image || null} alt="" aspect="square" sizes="64px" className="size-16 shrink-0 rounded-lg" bgClassName="bg-surface" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
            <h2 id="rate-next-title" dir="auto" className="min-w-0 flex-1 basis-32 text-[15px] font-bold leading-6 text-text-primary line-clamp-2">
              {tri(p.name)}
            </h2>
            {chip && <StatusChip tone={chip.tone}>{chip.text}</StatusChip>}
          </div>
          {line && <p className="text-[13px] leading-5 text-text-secondary">{line}</p>}
        </div>
      </div>
      <Link to={approved ? '/gifts' : reviewPath(p.slug)} className="lv-button lv-button-primary w-full">
        {t(approved ? 'rate.chooseGift' : 'rate.write')}
      </Link>
    </section>
  );
}

/**
 * One of «طابعاتك»: flat, its state in a chip, and a secondary link when a
 * step is left (the review to write, the gift under «هداياي»). The link is
 * described by the printer's name, so «اكتب مراجعتك» says which printer.
 * Narrower than the name, chip and link together, the link drops under the
 * chip rather than squeezing the name.
 */
function PrinterRow({ printer: p }: { printer: PrinterToRate }) {
  const { t, tri, lang } = useRewardsT();
  const nameId = useId();
  const chip = printerChip(p, t, lang);
  const action =
    p.state === 'to_rate' && p.slug
      ? { to: reviewPath(p.slug), label: t('rate.write') }
      : p.state === 'reward_approved'
        ? { to: '/gifts', label: t('rate.gifts') }
        : null;
  const note = p.state === 'reward_pending' ? t('rate.pendingNote') : p.state === 'to_rate' && !p.slug ? t('rate.noPage') : '';
  return (
    <li className="lv-surface p-3 flex items-center gap-3">
      <SafeImage src={p.image || null} alt="" aspect="square" sizes="48px" className="size-12 shrink-0 rounded-md" bgClassName="bg-surface" />
      <div className="min-w-0 flex-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-32 flex flex-col items-start gap-1.5">
          <p id={nameId} dir="auto" className="max-w-full text-[14px] font-bold leading-5 text-text-primary line-clamp-2">
            {tri(p.name)}
          </p>
          {chip && <StatusChip tone={chip.tone}>{chip.text}</StatusChip>}
          {note && <p className="text-[12px] leading-5 text-text-muted">{note}</p>}
        </div>
        {action && (
          <Link to={action.to} aria-describedby={nameId} className="lv-button lv-button-secondary lv-button-sm shrink-0">
            {action.label}
          </Link>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------ how the gift is earned

const STEPS: readonly CopyKey[] = ['rate.step1', 'rate.step2', 'rate.step3'];

function HowTo() {
  const { t, lang } = useRewardsT();
  return (
    <section aria-labelledby="rate-how-title" className="space-y-2">
      <SectionHeading id="rate-how-title">{t('rate.how')}</SectionHeading>
      <ol className="lv-surface p-4 space-y-3">
        {STEPS.map((key, i) => (
          <li key={key} className="flex items-start gap-3">
            <span className="size-8 shrink-0 rounded-full lv-well grid place-items-center text-[13px] font-bold tabular-nums text-text-primary">
              {formatFigure(i + 1, lang)}
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-[13.5px] leading-6 text-text-secondary">{t(key)}</p>
              {key === 'rate.step2' && <HandleCopy />}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The handle to mention, set left to right, with a 44 px copy button. The
 * copy goes through src/lib/copyText.ts, which also works in the in-app
 * browsers (Instagram's among them) where the clipboard API is missing. The
 * result is said in a polite live region: the tick and «نُسخ اسم الحساب» for
 * two seconds, or the honest failure — never a tick — which stays until the
 * next try, the handle still on screen to type.
 */
function HandleCopy() {
  const { t } = useRewardsT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const copy = async () => {
    const ok = await copyToClipboard(INSTAGRAM_HANDLE);
    if (!live.current) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setState(ok ? 'copied' : 'failed');
    if (!ok) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setState('idle');
    }, COPIED_MS);
  };

  const said = state === 'copied' ? t('rate.handleCopied') : state === 'failed' ? t('rate.copyFailed') : '';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code dir="ltr" className="lv-well rounded-md px-3 py-2 text-[14px] font-bold text-text-primary select-all">
        {INSTAGRAM_HANDLE}
      </code>
      <IconButton
        variant="secondary"
        label={t('rate.copyHandle')}
        icon={state === 'copied' ? <Check className="w-4 h-4 text-success" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
        onClick={() => {
          void copy();
        }}
      />
      <span role="status" aria-live="polite" className={`text-[12px] text-text-muted ${state === 'idle' ? 'sr-only' : ''}`}>
        {said}
      </span>
    </div>
  );
}

// ------------------------------------------------------------ the levels and the rules

/**
 * «مستويات الهدايا» (the active levels, in the server's order, discs in ink),
 * then the two notes: what a valid review below the levels earns at least
 * (`rating.no_level_points`, hidden when the server sends none) and that the
 * gift is the team's decision, in kind (policy 8.2, 8.10).
 */
function GiftRules({ rating }: { rating: RewardsHubData['rating'] | undefined }) {
  const { t, count, tri, lang } = useRewardsT();
  const levels = (Array.isArray(rating?.gift_levels) ? rating.gift_levels : []).filter((g) => g && g.active);
  const noLevel = positive(rating?.no_level_points);
  return (
    <>
      {levels.length > 0 && (
        <section aria-labelledby="rate-levels-title" className="space-y-2">
          <SectionHeading id="rate-levels-title">{t('rate.levels')}</SectionHeading>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {levels.map((g) => {
              const words = LEVEL_WORDS[g.level];
              return (
                <li key={g.level} className="lv-well rounded-lg px-3 py-2.5 flex items-center gap-2 text-[13px]">
                  <span className="size-7 shrink-0 rounded-full bg-surface-raised grid place-items-center text-[12px] font-bold tabular-nums text-text-primary">
                    {formatFigure(g.level, lang)}
                  </span>
                  <span dir="auto" className="min-w-0 text-text-primary">
                    {tri(g.description) || (words ? t(words) : t('rate.level', { n: formatFigure(g.level, lang) }))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <div className="space-y-1.5 px-1">
        {noLevel !== null && (
          <p className="text-[12px] leading-5 text-text-muted">{t('rate.noLevel', { points: count(pointsForm('rate.noLevel'), noLevel) })}</p>
        )}
        <p className="text-[12px] leading-5 text-text-muted">{t('rate.decision')}</p>
      </div>
    </>
  );
}
