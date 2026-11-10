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
 * - 'ready', no printers: the EmptyState (a way to choose a printer), then
 *   «عندك كود هدية؟», the how-to, the levels and the two notes.
 * - 'ready': the lead line; THE FOCAL PRINTER — the screen's one raised card,
 *   holding its one primary — when the first printer by actionability has a
 *   gift to choose, a code awaited (its box is the primary), or is still to rate
 *   and has a page to review it on; «عندك كود هدية؟» as a quiet row otherwise;
 *   «طابعاتك», the rest, as flat rows with a secondary link where a step is
 *   left; «تُعرض أحدث 20 طابعة استلمتها» at the server's cap; «كيف تربح
 *   الهدية» with the Instagram handle to copy; «مستويات الهدايا» with the score
 *   each opens at; the no-level line and the decision note.
 *
 * THE CODE (DECISIONS row 301). The box posts the code and opens the analysis
 * (./GiftReveal.tsx, a lazy chunk); a gift a code already opened re-opens from
 * its printer without the code, on the result, with «شاهد التحليل» to play it.
 *
 * DECIDES NOTHING. States, gift levels, stars, `rating.no_level_points` and
 * the 20-printer cap are the server's (worker/routes/rewardsProgram.ts
 * `printersToRate`, `giftLevels`); the screen only orders the printers — what
 * needs the customer first, the server's order (newest delivered) within each
 * state. No clock and no request here: every way out is a link
 * (/product/<slug>#reviews, /gifts, /printer-finder). No gold either: the
 * level discs are ink, the chips neutral, warning or success.
 */
import React, { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Star, Ticket } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import ChunkBoundary from '../ChunkBoundary';
import { Button, IconButton } from '../ui/Button';
import { StatusChip, type Tone } from '../ui/Badge';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import SafeImage from '../ui/SafeImage';
import { copyText as copyToClipboard } from '../../lib/copyText';
import { formatFigure } from '../../lib/localeNumber';
import { prefetchable } from '../../lib/routeReveal';
import type { Language } from '../../translations';
import { formatDate } from '../orders/format';
import { RateSkeleton, SectionHeading, SetupState } from './AreaChrome';
import { SCORE_SCALE, pointsForm, type CopyKey } from './copy';
import { pickName } from './model';
import type { GiftReveal as RevealData, PrinterToRate, RewardsHubData } from './types';
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

/**
 * The analysis, loaded when a code is about to be written: nobody else pays for it.
 * `prefetchable` and not a bare `React.lazy`: a module already here renders in the
 * same pass, where a lazy one first commits its empty fallback and React then holds
 * the sheet back by 300 ms, a dead moment between the answer and the sheet
 * (src/lib/routeReveal.ts).
 */
const loadReveal = () => import('./GiftReveal');
const GiftReveal = prefetchable(loadReveal);
const warmReveal = () => (GiftReveal as unknown as { preload: () => void }).preload();

/** What needs the customer first: a gift to choose, a code to write, a review to write, a decision to wait for, done. */
const ACTIONABILITY: Readonly<Record<PrinterToRate['state'], number>> = {
  reward_approved: 0,
  code_ready: 1,
  to_rate: 2,
  reward_pending: 3,
  rated: 4,
};

/** A state a newer server may add sorts after every known one. */
const UNKNOWN_RANK = 5;

export interface RatePlan {
  /** The screen's one raised card, or null when the first printer has no step to take from here. */
  focal: PrinterToRate | null;
  /** Every other printer, in order: «طابعاتك». */
  rest: PrinterToRate[];
}

/**
 * The printers in the order the screen lists them — gift to choose, code to
 * write, to rate, awaiting the gift decision, rated; the server's order within
 * each — and the focal one: the FIRST of them, when it has a gift to choose, a
 * code to write, or is still to rate and has a page to write the review on. The
 * rest stay in the list.
 */
export function ratePlan(printers: readonly PrinterToRate[]): RatePlan {
  const rank = (p: PrinterToRate) => ACTIONABILITY[p.state] ?? UNKNOWN_RANK;
  const sorted = printers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);
  const first = sorted[0];
  const focal = first && (first.state === 'reward_approved' || first.state === 'code_ready' || (first.state === 'to_rate' && !!first.slug)) ? first : null;
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
      return { tone: 'warning', text: t(p.reward_decision === 'revision' ? 'rate.revision' : 'rate.pending') };
    case 'code_ready':
      return { tone: 'success', text: t('rate.codeReady') };
    case 'reward_approved': {
      const level = positive(p.reward_level);
      if (p.gift?.status === 'ADDED_TO_ORDER') return { tone: 'success', text: t('rate.inCart') };
      if (level === null) return { tone: 'success', text: t('now.gift') };
      return { tone: 'success', text: t(p.gift?.scope === 'up_to' && level > 1 ? 'rate.upTo' : 'rate.approved', { level: formatFigure(level, lang) }) };
    }
    case 'rated': {
      if (p.gift?.status === 'ORDERED' || p.gift?.status === 'FULFILLED') return { tone: 'neutral', text: t('rate.giftOrdered') };
      if (p.code_void) return { tone: 'warning', text: t('rate.codeVoid') };
      if (p.reward_decision === 'rejected') return { tone: 'warning', text: t('rate.rewardRejected') };
      const stars = positive(p.stars);
      return stars !== null ? { tone: 'neutral', text: t('rate.rated', { stars: formatFigure(stars, lang) }) } : null;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------ the screen

export function RateScreen({ hub }: RateScreenProps) {
  if (hub.status === 'idle' || hub.status === 'loading') return <RateSkeleton />;
  const data = hub.data;
  if (hub.status === 'error' || !data) return <ErrorState error={hub.error} onRetry={() => void hub.reload()} />;
  if (data.installed === false) return <SetupState />;
  return <RateReady data={data} reload={hub.reload} />;
}

/** The sheet's state: what it shows, and whether the analysis plays. */
interface OpenReveal {
  data: RevealData;
  play: boolean;
}

function RateReady({ data, reload }: { data: RewardsHubData; reload: () => Promise<void> }) {
  const { t, lang } = useRewardsT();
  const printers = Array.isArray(data.printers) ? data.printers : [];
  const [reveal, setReveal] = useState<OpenReveal | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState(false);
  /** A code written and the hub not read since: owed, and paid however the customer leaves. */
  const owed = useRef(false);
  const refresh = useCallback(() => {
    owed.current = false;
    void reload();
  }, [reload]);
  // Gone by Back or a link with the sheet still up: the hub this page feeds must not go on saying «أدخل الكود».
  useEffect(
    () => () => {
      if (owed.current) void reload();
    },
    [reload]
  );

  /** A gift a code already opened, from its printer: the server's same answer, without the code. */
  const openGift = useCallback(async (giftId: string, play: boolean) => {
    setOpening(giftId);
    setOpenError(false);
    warmReveal();
    try {
      const answer = await api.get<RevealData>(`/api/rewards/program/gift-reveal/${encodeURIComponent(giftId)}`);
      setReveal({ data: answer, play });
    } catch {
      setOpenError(true);
    } finally {
      setOpening(null);
    }
  }, []);

  const sheet = reveal && (
    <ChunkBoundary compact>
      <Suspense fallback={null}>
        <GiftReveal
          data={reveal.data}
          play={reveal.play}
          onChanged={refresh}
          onClose={() => {
            setReveal(null);
            refresh();
          }}
        />
      </Suspense>
    </ChunkBoundary>
  );
  /**
   * The answer opens the sheet, and the hub is NOT read here: the page behind would
   * say the score and the levels while the sheet is still rising, before the analysis
   * has. The sheet reads it when it reaches the result (GiftReveal `onChanged`), or on
   * closing. A chunk that does not arrive loses nothing: no sheet comes to cover the
   * page, so it reads at once and finds the gift, which is the server's.
   */
  const onWritten = (answer: RevealData) => {
    owed.current = true;
    setReveal({ data: answer, play: true });
    void loadReveal().catch(refresh);
  };

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
        {/* A code in hand whose printer is not listed (a returned order, a printer moved out of the catalogue) still has a place to go. */}
        <QuietCodeRow open={false} onWritten={onWritten} />
        <HowTo />
        <GiftRules rating={data.rating} />
        {sheet}
      </>
    );
  }

  const { focal, rest } = ratePlan(printers);
  const codeOnFocal = focal?.state === 'code_ready';
  const codeAwaited = printers.some((p) => p.state === 'code_ready');
  return (
    <>
      <p className="px-1 text-[13px] leading-6 text-text-secondary">{t('rate.lead')}</p>
      {focal && <FocalPrinter printer={focal} onWritten={onWritten} onOpen={openGift} opening={opening} />}
      {!codeOnFocal && <QuietCodeRow open={codeAwaited} onWritten={onWritten} />}
      {openError && (
        <p role="alert" className="px-1 text-[12.5px] leading-5 text-danger">
          <Link to="/gifts" className="relative lv-hit underline underline-offset-2">
            {t('rate.openFailed')}
          </Link>
        </p>
      )}
      {rest.length > 0 && (
        <section aria-labelledby="rate-printers-title" className="space-y-2">
          <SectionHeading id="rate-printers-title">{t('rate.printers')}</SectionHeading>
          <ul className="space-y-2">
            {rest.map((p) => (
              <PrinterRow key={`${p.order_id}:${p.product_id}`} printer={p} onOpen={openGift} opening={opening} />
            ))}
          </ul>
          {printers.length >= PRINTERS_SHOWN_MAX && (
            <p className="px-1 text-[12px] leading-5 text-text-muted">{t('rate.capped', { n: formatFigure(printers.length, lang) })}</p>
          )}
        </section>
      )}
      <HowTo />
      <GiftRules rating={data.rating} />
      {sheet}
    </>
  );
}

// ------------------------------------------------------------ the code

/**
 * «عندك كود هدية؟»: the code the team handed over. The server reads it however it
 * was typed, and answers every wrong one in one sentence; the screen adds nothing.
 * The chunk starts loading the moment the field is touched, so the analysis opens
 * with the answer and never after it.
 */
function GiftCodeForm({ primary, onWritten, autoFocus }: { primary: boolean; onWritten: (answer: RevealData) => void; autoFocus?: boolean }) {
  const { t } = useRewardsT();
  const id = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!code.trim()) {
      setError(t('code.empty'));
      return;
    }
    setBusy(true);
    setError('');
    warmReveal();
    try {
      const answer = await api.post<RevealData>('/api/rewards/program/gift-code', { code });
      setCode('');
      onWritten(answer);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const refusal = err instanceof ApiError ? err.code : undefined;
      const voidWhy = err instanceof ApiError && err.details?.reason === 'cancelled' ? 'code.err.void.cancelled' : 'code.err.void.returned';
      setError(
        status === 429
          ? t('tooMany')
          : refusal === 'GIFT_CODE_INVALID'
            ? t('code.err.invalid')
            : refusal === 'GIFT_CODE_USED'
              ? t('code.err.used')
              : refusal === 'GIFT_CODE_VOID'
                ? t(voidWhy)
                : t('code.err.generic')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-1.5" data-gift-code-form>
      <label htmlFor={id} className="block text-[12.5px] font-semibold text-text-secondary">
        {t('code.label')}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          id={id}
          dir="ltr"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onFocus={warmReveal}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          maxLength={32}
          placeholder={CODE_PLACEHOLDER}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="lv-input min-w-0 flex-1 px-3 text-center text-[15px] font-bold tracking-wider uppercase"
          data-gift-code-input
        />
        <Button type="submit" variant={primary ? 'primary' : 'secondary'} loading={busy} loadingLabel={t('code.checking')} className="shrink-0" data-gift-code-submit>
          {t('code.confirm')}
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-[12.5px] leading-5 text-danger" data-gift-code-error>
          {error}
        </p>
      )}
    </form>
  );
}

/** How a code looks, with nothing in it to translate. */
const CODE_PLACEHOLDER = 'GFT-XXX-XXXX';

/** The quiet way in, on a page whose focal card is about something else. Open by itself when a code is awaited. */
function QuietCodeRow({ open, onWritten }: { open: boolean; onWritten: (answer: RevealData) => void }) {
  const { t } = useRewardsT();
  const [shown, setShown] = useState(open);
  const panel = useId();
  const visible = shown || open;
  return (
    <section className="lv-surface p-3" data-gift-code-row>
      <button
        type="button"
        aria-expanded={visible}
        aria-controls={panel}
        onClick={() => setShown((s) => !s)}
        className="flex min-h-11 w-full items-center gap-2 rounded-md text-start text-[14px] font-semibold text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Ticket className="w-4 h-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1">{t('code.ask')}</span>
      </button>
      <div id={panel} hidden={!visible} className="mt-2">
        {visible && <GiftCodeForm primary={false} onWritten={onWritten} autoFocus={shown && !open} />}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ the printers

/** The next printer: its gift to choose, the code to write, or its review to write. The screen's one primary. */
function FocalPrinter({
  printer: p,
  onWritten,
  onOpen,
  opening,
}: {
  printer: PrinterToRate;
  onWritten: (answer: RevealData) => void;
  onOpen: (giftId: string, play: boolean) => void;
  opening: string | null;
}) {
  const { t, lang } = useRewardsT();
  const approved = p.state === 'reward_approved';
  const awaiting = p.state === 'code_ready';
  const upTo = approved && p.gift?.scope === 'up_to' ? p.gift : null;
  const chip = printerChip(p, t, lang);
  const level = positive(p.reward_level);
  const delivered = formatDate(p.delivered_at, lang);
  const score = positive(p.final_score);
  const line = awaiting
    ? t('rate.codeReady.note')
    : upTo
      ? score !== null
        ? t('rate.score', { score: formatFigure(score, lang), max: formatFigure(SCORE_SCALE.to, lang) })
        : t('door.rate.gift')
      : approved
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
          {/* The whole name, and the chip on its own line in every state: beside it the name had 135 px and lost its end. */}
          <div className="flex flex-col items-start gap-1.5">
            <h2 id="rate-next-title" className="max-w-full text-[15px] font-bold leading-6 text-text-primary">
              <bdi>{pickName(p.name)}</bdi>
            </h2>
            {chip && <StatusChip tone={chip.tone}>{chip.text}</StatusChip>}
          </div>
          {line && <p className="text-[13px] leading-5 text-text-secondary">{line}</p>}
        </div>
      </div>
      {awaiting ? (
        <GiftCodeForm primary onWritten={onWritten} />
      ) : upTo ? (
        <div className="space-y-2">
          {upTo.status === 'ADDED_TO_ORDER' ? (
            <Link to="/cart" className="lv-button lv-button-primary w-full">
              {t('reveal.checkout')}
            </Link>
          ) : (
            <Button variant="primary" block loading={opening === upTo.id} onClick={() => onOpen(upTo.id, false)} data-gift-open={upTo.id}>
              {t(upTo.status === 'REDEEMED' ? 'reveal.addToCart' : 'rate.chooseGift')}
            </Button>
          )}
          <Button variant="ghost" block disabled={opening === upTo.id} onClick={() => onOpen(upTo.id, true)} data-gift-watch={upTo.id}>
            {t('rate.watch')}
          </Button>
        </div>
      ) : (
        <Link to={approved ? '/gifts' : reviewPath(p.slug)} className="lv-button lv-button-primary w-full">
          {t(approved ? 'rate.chooseGift' : 'rate.write')}
        </Link>
      )}
    </section>
  );
}

/**
 * One of «طابعاتك»: flat, its state in a chip, and a secondary link when a
 * step is left (the review to write, the gift under «هداياي»). The link is
 * described by the printer's name, so «اكتب مراجعتك» says which printer.
 * On a phone the link drops under the chip rather than squeezing the name, which
 * is never cut. A reward the team refused, or sent back, says so here with the
 * team's own written reason (a system refusal has none to show).
 */
function PrinterRow({ printer: p, onOpen, opening }: { printer: PrinterToRate; onOpen: (giftId: string, play: boolean) => void; opening: string | null }) {
  const { t, count, lang } = useRewardsT();
  const nameId = useId();
  const chip = printerChip(p, t, lang);
  const upTo = p.state === 'reward_approved' && p.gift?.scope === 'up_to' && p.gift.status !== 'ADDED_TO_ORDER' ? p.gift : null;
  const taken = p.state === 'rated' && (p.gift?.status === 'ORDERED' || p.gift?.status === 'FULFILLED');
  const action =
    p.state === 'to_rate' && p.slug
      ? { to: reviewPath(p.slug), label: t('rate.write') }
      : p.reward_decision === 'revision' && p.slug
        ? { to: reviewPath(p.slug), label: t('rate.revision.edit') }
      : p.state === 'reward_approved' && !upTo
        ? p.gift?.status === 'ADDED_TO_ORDER'
          ? { to: '/cart', label: t('reveal.checkout') }
          : { to: '/gifts', label: t('rate.gifts') }
        : taken
          ? { to: '/gifts', label: t('rate.gifts') }
          : null;
  // Row 303 R1: the printer went back, or its order was cancelled; the code it held opens nothing, and the row says why.
  const voided = p.code_void && !taken ? t(p.code_void === 'cancelled' ? 'rate.codeVoid.cancelled' : 'rate.codeVoid.returned') : '';
  // Row 303 R4: a refused gift still pays the review its points, and the row says how many.
  const earned = p.reward_decision === 'rejected' && (p.review_points ?? 0) > 0 ? t('rate.rejectedPoints', { points: count(pointsForm('rate.rejectedPoints'), p.review_points ?? 0) }) : '';
  const decided = p.reward_decision ? [p.reward_reason ? t('rate.reason', { reason: p.reward_reason }) : '', earned].filter(Boolean).join(' ') : null;
  const note = voided
    ? voided
    : decided !== null
      ? decided
      : p.state === 'reward_pending'
        ? t('rate.pendingNote')
        : p.state === 'code_ready'
          ? t('rate.codeReady.note')
          : p.state === 'to_rate' && !p.slug
            ? t('rate.noPage')
            : '';
  return (
    <li className="lv-surface p-3 flex items-center gap-3">
      <SafeImage src={p.image || null} alt="" aspect="square" sizes="48px" className="size-12 shrink-0 rounded-md" bgClassName="bg-surface" />
      <div className="min-w-0 flex-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48 flex flex-col items-start gap-1.5">
          <p id={nameId} className="max-w-full text-[14px] font-bold leading-5 text-text-primary">
            <bdi>{pickName(p.name)}</bdi>
          </p>
          {chip && <StatusChip tone={chip.tone}>{chip.text}</StatusChip>}
          {note && <p className="max-w-full break-words text-[12px] leading-5 text-text-muted" dir="auto" data-rate-note>{note}</p>}
        </div>
        {action && (
          <Link to={action.to} aria-describedby={nameId} className="lv-button lv-button-secondary lv-button-sm shrink-0">
            {action.label}
          </Link>
        )}
        {upTo && (
          <Button size="sm" loading={opening === upTo.id} onClick={() => onOpen(upTo.id, false)} aria-describedby={nameId} className="shrink-0" data-gift-open={upTo.id}>
            {t(upTo.status === 'REDEEMED' ? 'reveal.addToCart' : 'rate.chooseGift')}
          </Button>
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
              <p className="text-[13.5px] leading-6 text-text-secondary">
                {key === 'rate.step3'
                  ? t(key, { from: formatFigure(SCORE_SCALE.from, lang), to: formatFigure(SCORE_SCALE.to, lang), every: formatFigure(SCORE_SCALE.every, lang) })
                  : t(key)}
              </p>
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
 * «مستويات الهدايا» (the active levels, in the server's order, discs in ink, each
 * with the score that opens it; which gifts a level holds is for the customer whose
 * score opened it), then the two notes: what a review of any other product earns
 * at least (`rating.no_level_points`, hidden when the server sends none) and that
 * the gift is the team's decision, in kind (policy 8.2, 8.10).
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
            {levels.map((g) => (
              <li key={g.level} className="lv-well rounded-lg px-3 py-2.5 flex items-center gap-2 text-[13px]">
                <span className="size-7 shrink-0 rounded-full bg-surface-raised grid place-items-center text-[12px] font-bold tabular-nums text-text-primary">
                  {formatFigure(g.level, lang)}
                </span>
                <span dir="auto" className="min-w-0 flex-1 text-text-primary">
                  {tri(g.description) || t('rate.level', { n: formatFigure(g.level, lang) })}
                </span>
                {typeof g.threshold === 'number' && <span className="shrink-0 text-[12px] text-text-muted">{t('reveal.opensAt', { n: formatFigure(g.threshold, lang) })}</span>}
              </li>
            ))}
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
