/**
 * «المسابقة» — /rewards/competitions/:id (rewards spec §3.6, with §2.5, §4–§7).
 *
 * In order: its state and what this customer can do; what can be won; how to
 * enter; the description and the rules; the result. Policies 15.1 and 15.8
 * are said in full (the facts card, the entry sheet).
 *
 * WHO RENDERS WHAT (src/pages/RewardsArea.tsx)
 * - The frame draws the header (h1 «المسابقة», widened to `lg:max-w-4xl`),
 *   the scroller and its `space-y-4` column; the skeleton while the session
 *   loads; a guest's sign-in state; the competition's NotFound (a malformed
 *   id without a fetch, or the server's 404 even over a seed); the StaleLine
 *   above this screen when a re-read failed over data. So this screen never
 *   mounts without a competition to show or to wait for.
 * - Here, by `detail.status`: the skeleton while the first read has no seed,
 *   the ErrorState when it failed with nothing to show, else the page — at
 *   once from the row the customer tapped (the seed), then the server's own.
 *
 * LAYOUT. One root: the StatusCard first, then the sections in the phase's
 * order. At ≥ 1024 px the root is a two-column grid and the StatusCard sits,
 * sticky, in the end column, lifted (`lg:bg-surface-raised lg:shadow-lg`)
 * because it holds the CTA there; on a phone it is flat, the CTA lives in the
 * bar under the scroller (CompetitionCtaBar, portalled into the frame's
 * in-flow slot: never over the content, nothing fixed), and the bar renders
 * only when the gate gives it something to do.
 *
 * SECTIONS BY PHASE (an entry always leads, so "what became of mine" is the
 * first thing after the card):
 *   open / upcoming   prizes → how → description → details
 *                     (once entered: my entry → prizes → description → details)
 *   closed            my entry → prizes → description → details
 *   finished          winners → my entry → prizes → description → details
 *   cancelled         my entry → description → details (an entrant's page only)
 *
 * ENTERING. `openEntry`: submission 'none' opens EntryConfirm, anything else
 * EntrySheet. This screen owns their open state, so they unmount with it on
 * Back. After an entry the frame reads the detail and the wallet again and
 * marks the hub and the list stale; then the «مشاركتك» heading takes focus
 * (the CTA that opened the window is gone by then).
 *
 * DECIDES NOTHING. The phase, the gate (why this customer can or cannot
 * enter, the points short, the places left), the entry and the winners are
 * the server's answer. Day counts read `server_time`; every live Countdown
 * counts to `toDeviceTarget(iso, detail.skewMs)` and its zero asks for the
 * page again (`reloadSoon`), so an upcoming competition that opens grows its
 * bar after that read. Gold stays in the screen's budget: the «مفتوحة» chip
 * or the «فزت…» chip, and the first place's trophy.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Trophy, X } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { StatusChip, type Tone } from '../ui/Badge';
import { ErrorState } from '../ui/AsyncStates';
import Countdown from '../ui/Countdown';
import { Overlay } from '../ui/Overlay';
import SafeImage from '../ui/SafeImage';
import { formatFigure } from '../../lib/localeNumber';
import { formatDate, formatDateTime } from '../orders/format';
import { CompetitionSkeleton, ForwardChevron, SectionHeading } from './AreaChrome';
import { pointsForm, type CopyKey } from './copy';
import { EntryConfirm, EntrySheet, entryFee } from './EntrySheet';
import { isolateLatin, myResult, toDeviceTarget, underADay, wholeDaysLeft, type MyResult } from './model';
import type { Competition, CompetitionDetailResponse, CompetitionEntry, CompetitionGate } from './types';
import type { CompetitionRead } from './useRewardsData';
import { useRewardsT } from './useT';

export interface CompetitionScreenProps {
  /** The competition's id from the address, already checked against COMPETITION_ID. The entry POST is `/api/rewards/program/competitions/${encodeURIComponent(id)}/enter`. */
  id: string;
  /** useCompetition: seeded from the list (or the hub's preview), then read again. Never `notFound` here. */
  detail: CompetitionRead;
  /** Where CompetitionCtaBar is portalled: an in-flow element after the scroller. Null until it has mounted. */
  ctaSlot: HTMLElement | null;
  /** After a successful entry: `await Promise.all([detail.reload(), refreshWallet()])`, then `hub.invalidate(); list.invalidate()`, run by the frame. Never rejects. */
  onEntered: () => Promise<void>;
  /** For Countdown.onZero: reads the detail again 1.5 s later (crossings close together share one read). */
  reloadSoon: () => void;
}

export function CompetitionScreen({ id, detail, ctaSlot, onEntered, reloadSoon }: CompetitionScreenProps) {
  if (detail.status === 'ready' && detail.data) {
    return (
      <CompetitionDetail
        key={id}
        data={detail.data}
        skewMs={detail.skewMs}
        reload={detail.reload}
        ctaSlot={ctaSlot}
        onEntered={onEntered}
        reloadSoon={reloadSoon}
      />
    );
  }
  if (detail.status === 'error') return <ErrorState error={detail.error} onRetry={() => void detail.reload()} />;
  return <CompetitionSkeleton />;
}

// ------------------------------------------------------------ the words each state reads as

type RewardsT = ReturnType<typeof useRewardsT>;

/** What the server's answer and the device's clock need, for every line that dates or counts down. */
interface Clock {
  serverTime: string;
  skewMs: number;
  reloadSoon: () => void;
}

const PHASE_CHIP: Readonly<Record<Competition['phase'], { tone: Tone; key: CopyKey }>> = {
  draft: { tone: 'info', key: 'chip.upcoming' },
  upcoming: { tone: 'info', key: 'chip.upcoming' },
  open: { tone: 'accent', key: 'chip.open' },
  closed: { tone: 'warning', key: 'chip.closed' },
  finished: { tone: 'neutral', key: 'chip.finished' },
  cancelled: { tone: 'neutral', key: 'chip.cancelled' },
};

/** This customer's entry as a chip: one word, a dot (or the trophy) and a tint. */
const RESULT_CHIP: Readonly<Record<MyResult, { tone: Tone; key: CopyKey }>> = {
  entered: { tone: 'success', key: 'chip.entered' },
  awaiting: { tone: 'info', key: 'chip.awaiting' },
  won: { tone: 'accent', key: 'chip.won' },
  not_won: { tone: 'neutral', key: 'chip.notWon' },
  refunded_cancel: { tone: 'info', key: 'chip.refunded' },
  cancelled_free: { tone: 'neutral', key: 'chip.cancelled' },
  rejected: { tone: 'neutral', key: 'chip.rejected' },
  rejected_refund: { tone: 'neutral', key: 'chip.rejected' },
};

const HOW_FIRST: Readonly<Record<Competition['submission'], CopyKey>> = {
  none: 'how.none',
  text: 'how.text',
  photo: 'how.photo',
  photo_text: 'how.photoText',
};

const SENDS: Readonly<Record<Competition['submission'], CopyKey>> = {
  none: 'send.none',
  text: 'send.text',
  photo: 'send.photo',
  photo_text: 'send.photoText',
};

/** «بقيت 3 أماكن» shows only this close to the cap; the figure is the server's `spots_left`. */
const SPOTS_SHOWN_MAX = 10;
/** A winner's answer past this many characters folds to six lines behind «اقرأ المزيد». */
const ANSWER_FOLD_CHARS = 300;
/** After an entry the «مشاركتك» heading takes focus once it renders — within this long, never as a surprise later. */
const FOCUS_WINDOW_MS = 10_000;

/** A sentence whose `{points}` takes the counted form its key asks for (the † keys take the oblique Arabic dual). */
function withPoints(h: RewardsT, key: CopyKey, n: number): string {
  return h.t(key, { points: h.count(pointsForm(key), n) });
}

/** The places left, when the competition is open and close to its cap; else null. */
function fewSpots(c: Competition): number | null {
  const n = c.gate?.spots_left;
  return c.phase === 'open' && typeof n === 'number' && n > 0 && n <= SPOTS_SHOWN_MAX ? n : null;
}

/** What the CTA offers, read from the server's gate: enter, earn the points short, or find a printer. Anything else has no CTA. */
type CtaKind = 'enter' | 'short' | 'eligible';

function ctaOf(gate: CompetitionGate | undefined): CtaKind | null {
  if (!gate) return null;
  if (gate.can_enter) return 'enter';
  if (gate.blocked_by === 'insufficient_points') return 'short';
  if (gate.blocked_by === 'not_eligible') return 'eligible';
  return null;
}

// ------------------------------------------------------------ the page

interface DetailProps {
  data: CompetitionDetailResponse;
  skewMs: number;
  reload: () => Promise<void>;
  ctaSlot: HTMLElement | null;
  onEntered: () => Promise<void>;
  reloadSoon: () => void;
}

function CompetitionDetail({ data, skewMs, reload, ctaSlot, onEntered, reloadSoon }: DetailProps) {
  const { t } = useRewardsT();
  const c = data.competition;
  const entry = c.my_entry;
  const clock: Clock = { serverTime: data.server_time, skewMs, reloadSoon };
  const cta = ctaOf(c.gate);

  const [entryOpen, setEntryOpen] = useState(false);
  const openEntry = useCallback(() => setEntryOpen(true), []);
  const closeEntry = useCallback(() => setEntryOpen(false), []);

  // «مشاركتك» after an entry: asked for once the frame's refresh is in, done
  // as soon as the heading exists.
  const mineRef = useRef<HTMLHeadingElement | null>(null);
  const [focusMineAt, setFocusMineAt] = useState(0);
  const hasEntry = !!entry;
  useEffect(() => {
    if (!focusMineAt || !hasEntry) return;
    setFocusMineAt(0);
    if (Date.now() - focusMineAt > FOCUS_WINDOW_MS) return;
    mineRef.current?.focus();
  }, [focusMineAt, hasEntry]);
  const entered = useCallback(async () => {
    await onEntered();
    setFocusMineAt(Date.now());
  }, [onEntered]);

  // A winner's photo, kept after closing so the viewer slides away with it.
  const [viewer, setViewer] = useState<{ url: string; place: number; open: boolean } | null>(null);
  const showPhoto = useCallback((url: string, place: number) => setViewer({ url, place, open: true }), []);
  const closePhoto = useCallback(() => setViewer((v) => (v ? { ...v, open: false } : v)), []);

  const mine = entry ? <MyEntry key="mine" c={c} entry={entry} headingRef={mineRef} /> : null;
  const prizes = <Prizes key="prizes" c={c} />;
  const terms = <Terms key="terms" c={c} />;
  const facts = <Facts key="facts" c={c} />;
  let sections: ReactNode[];
  switch (c.phase) {
    case 'finished':
      sections = [<Winners key="winners" c={c} onPhoto={showPhoto} />, mine, prizes, terms, facts];
      break;
    case 'closed':
      sections = [mine, prizes, terms, facts];
      break;
    case 'cancelled':
      sections = [mine, terms, facts];
      break;
    default:
      // «كيف تشارك» tells what to send; once sent, the entry takes its place at the top.
      sections = entry ? [mine, prizes, terms, facts] : [prizes, <HowTo key="how" c={c} />, terms, facts];
  }

  return (
    <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6 lg:items-start lg:space-y-0">
      <StatusCard c={c} clock={clock} cta={cta} onEnter={openEntry} />
      <div className="space-y-4 lg:col-start-1 lg:row-start-1">
        {sections}
        <Link to="/rewards/competitions" className="lv-button lv-button-secondary w-full justify-between">
          {t('detail.all')}
          <ForwardChevron />
        </Link>
      </div>
      {cta &&
        ctaSlot &&
        createPortal(
          <CompetitionCtaBar>
            <CtaContent c={c} cta={cta} place="bar" onEnter={openEntry} />
          </CompetitionCtaBar>,
          ctaSlot
        )}
      {c.submission === 'none' ? (
        <EntryConfirm open={entryOpen} onClose={closeEntry} competition={c} reload={reload} onEntered={entered} />
      ) : (
        <EntrySheet
          open={entryOpen}
          onClose={closeEntry}
          competition={c}
          pointBalance={data.point_balance}
          reload={reload}
          onEntered={entered}
        />
      )}
      {viewer && <PhotoViewer url={viewer.url} place={viewer.place} open={viewer.open} onClose={closePhoto} />}
    </div>
  );
}

// ------------------------------------------------------------ the status card

function StatusCard({ c, clock, cta, onEnter }: { c: Competition; clock: Clock; cta: CtaKind | null; onEnter: () => void }) {
  const h = useRewardsT();
  const { t, count, ord, tri } = h;
  const phase = PHASE_CHIP[c.phase] ?? PHASE_CHIP.upcoming;
  const open = c.phase === 'open';
  const closingSoon = open && underADay(c.ends_at, clock.serverTime);
  const result = myResult(c);
  const resultChip = result ? RESULT_CHIP[result] : null;
  const place = c.my_entry?.place ?? 0;
  // The won chip needs its place; a result that only repeats the phase chip («أُلغيت») is said once.
  const showResult = !!resultChip && resultChip.key !== phase.key && (result !== 'won' || place >= 1);
  const fee = entryFee(c);
  const firstPrize = c.prize_points?.[0] ?? 0;
  const prizeWords = tri(c.prize);
  const spots = fewSpots(c);
  const blocked = c.gate?.blocked_by ?? null;

  return (
    <section
      aria-labelledby="competition-title"
      className="lv-surface p-4 flex flex-col gap-3 lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4 lg:self-start lg:bg-surface-raised lg:shadow-lg"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={phase.tone}>{t(phase.key)}</StatusChip>
        {open && !closingSoon && (
          <StatusChip tone="neutral">{count('daysLeft', Math.max(0, wholeDaysLeft(c.ends_at, clock.serverTime)))}</StatusChip>
        )}
        {showResult && resultChip && (
          <StatusChip
            tone={resultChip.tone}
            icon={result === 'won' ? <Trophy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : undefined}
          >
            {result === 'won' ? t('chip.won', { place: ord(place) }) : t(resultChip.key)}
          </StatusChip>
        )}
      </div>
      <StatusLine c={c} clock={clock} />
      <h2 id="competition-title" tabIndex={-1} dir="auto" className="text-[20px] font-bold leading-8 text-text-primary focus:outline-none">
        {isolateLatin(tri(c.title) || t('title.competition'))}
      </h2>
      {firstPrize > 0 ? (
        <p className="flex items-center gap-1.5 text-[15px] font-semibold text-text-primary">
          <Trophy className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 tabular-nums">{withPoints(h, 'status.firstPrize', firstPrize)}</span>
        </p>
      ) : prizeWords ? (
        <p className="flex items-center gap-1.5 text-[15px] font-semibold text-text-primary">
          <Trophy className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span dir="auto" className="min-w-0 line-clamp-1">
            {isolateLatin(prizeWords)}
          </span>
        </p>
      ) : null}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-5 text-text-muted tabular-nums">
        <span>{fee > 0 ? withPoints(h, 'row.fee', fee) : t('row.free')}</span>
        <span aria-hidden="true">·</span>
        <span>{count('entrants', c.entries_count ?? 0)}</span>
        {spots !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span>{count('spotsLeft', spots)}</span>
          </>
        )}
      </p>
      {blocked === 'full' && <p className="text-[13px] leading-6 text-text-secondary">{t('status.full')}</p>}
      {/* At ≥ 1024 px the CTA below says it, beside its way out. */}
      {blocked === 'not_eligible' && <p className="text-[13px] leading-6 text-text-secondary lg:hidden">{t('cta.notEligible')}</p>}
      {cta && (
        <div className="hidden lg:flex lg:flex-col lg:gap-2">
          <CtaContent c={c} cta={cta} place="card" onEnter={onEnter} />
        </div>
      )}
    </section>
  );
}

/** The card's one line about time: a live clock inside 24 h, else the date — or what the phase means. */
function StatusLine({ c, clock }: { c: Competition; clock: Clock }) {
  const { t, lang } = useRewardsT();
  const line = 'text-[12px] leading-5 text-text-muted';
  switch (c.phase) {
    case 'open':
      return underADay(c.ends_at, clock.serverTime) ? (
        <p className={line}>
          <Countdown target={toDeviceTarget(c.ends_at, clock.skewMs)} kind="ends" onZero={clock.reloadSoon} />
        </p>
      ) : (
        <p className={line}>{t('status.closes', { datetime: formatDateTime(c.ends_at, lang) })}</p>
      );
    case 'upcoming':
      return underADay(c.starts_at, clock.serverTime) ? (
        <p className={line}>
          <Countdown target={toDeviceTarget(c.starts_at, clock.skewMs)} kind="opens" onZero={clock.reloadSoon} />
        </p>
      ) : (
        <p className={line}>{t('status.opens', { datetime: formatDateTime(c.starts_at, lang) })}</p>
      );
    case 'closed':
      return <p className={line}>{t('status.closed')}</p>;
    case 'finished':
      return (
        <p className={line}>
          {c.results_at ? t('row.results', { date: formatDate(c.results_at, lang) }) : t('row.ended', { date: formatDate(c.ends_at, lang) })}
        </p>
      );
    case 'cancelled':
      return <p className={line}>{t('status.cancelled')}</p>;
    default:
      return null;
  }
}

// ------------------------------------------------------------ the CTA

/**
 * What the gate lets this customer do: enter (the price on the button), earn
 * the points still short, or find a printer. In the bar it carries the
 * places-left note; in the card (≥ 1024 px) the card's own meta line says it.
 */
function CtaContent({ c, cta, place, onEnter }: { c: Competition; cta: CtaKind; place: 'bar' | 'card'; onEnter: () => void }) {
  const h = useRewardsT();
  const { t, count } = h;
  const note = 'text-[12px] leading-5 text-text-secondary';
  if (cta === 'short') {
    return (
      <>
        <p className={note}>{count('pointsShortToEnter', c.gate?.points_short ?? 0)}</p>
        <Link to="/points" className="lv-button lv-button-secondary w-full">
          {t('earn')}
        </Link>
      </>
    );
  }
  if (cta === 'eligible') {
    return (
      <>
        <p className={note}>{t('cta.notEligible')}</p>
        <Link to="/printer-finder" className="lv-button lv-button-secondary w-full">
          {t('help.choosePrinter')}
        </Link>
      </>
    );
  }
  const fee = entryFee(c);
  const spots = place === 'bar' ? fewSpots(c) : null;
  return (
    <>
      {spots !== null && <p className={note}>{count('spotsLeft', spots)}</p>}
      <Button variant="primary" block onClick={onEnter} data-competition-enter>
        {fee > 0 ? withPoints(h, 'cta.enterFee', fee) : t('cta.enter')}
      </Button>
    </>
  );
}

/** Under the scroller on a phone and a tablet, in the page's flow (the frame's slot): never over the content. */
function CompetitionCtaBar({ children }: { children: ReactNode }) {
  return (
    <div data-competition-cta className="shrink-0 material material-thick border-t border-border-subtle lg:hidden">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------ the sections

/** «مشاركتك»: what became of this customer's entry, in words, then the entry itself. The chip is the status card's. */
function MyEntry({ c, entry, headingRef }: { c: Competition; entry: CompetitionEntry; headingRef: Ref<HTMLHeadingElement> }) {
  const h = useRewardsT();
  const { t, tri, lang } = h;
  const lines: string[] = [];
  switch (myResult(c)) {
    case 'entered':
      lines.push(t('mine.enteredOn', { date: formatDate(entry.created_at, lang) }), t('mine.open'));
      break;
    case 'awaiting':
      lines.push(t('mine.judging'));
      break;
    case 'won':
      if (entry.prize_points > 0) lines.push(withPoints(h, 'mine.wonPoints', entry.prize_points));
      if (tri(c.prize)) lines.push(t('mine.wonKind'));
      break;
    case 'not_won':
      lines.push(t('mine.notWon'));
      break;
    case 'refunded_cancel':
      lines.push(withPoints(h, 'mine.refundCancel', entry.entry_points));
      break;
    case 'cancelled_free':
      lines.push(t('mine.cancelFree'));
      break;
    case 'rejected':
      lines.push(t('mine.rejected'));
      break;
    case 'rejected_refund':
      lines.push(withPoints(h, 'mine.rejectedRefund', entry.entry_points));
      break;
    default:
      break;
  }
  return (
    <section aria-labelledby="mine-title" className="lv-surface p-4 space-y-3">
      <h2 id="mine-title" ref={headingRef} tabIndex={-1} className="text-[15px] font-bold leading-6 text-text-primary focus:outline-none">
        {t('mine.title')}
      </h2>
      {lines.map((text, i) => (
        <p key={i} className="text-[13.5px] leading-6 text-text-secondary">
          {text}
        </p>
      ))}
      {entry.answer && (
        <p dir="auto" className="whitespace-pre-line text-[14px] leading-7 text-text-primary">
          {entry.answer}
        </p>
      )}
      {entry.media_url && <SafeImage src={entry.media_url} aspect="square" sizes="160px" className="w-40 rounded-lg" alt="" />}
      <p className="text-[12px] leading-5 text-text-muted">{t('mine.locked')}</p>
    </section>
  );
}

/** «الجوائز»: each place that pays points, then the prize in words. */
function Prizes({ c }: { c: Competition }) {
  const { t, count, ord, tri } = useRewardsT();
  const places = (c.prize_points ?? []).map((points, i) => ({ place: i + 1, points })).filter((p) => p.points > 0);
  const words = tri(c.prize);
  if (places.length === 0 && !words) return null;
  return (
    <section aria-labelledby="prizes-title" className="space-y-2">
      <SectionHeading id="prizes-title">{t('prizes.title')}</SectionHeading>
      {places.length > 0 && (
        <ol className="lv-surface overflow-hidden divide-y divide-border-subtle">
          {places.map(({ place, points }) => (
            <li key={place} className="flex items-center justify-between gap-3 px-4 py-3 text-[14px]">
              <span className="flex min-w-0 items-center gap-2 text-text-primary">
                {place === 1 ? (
                  <Trophy className="w-4 h-4 shrink-0 text-gold" aria-hidden="true" />
                ) : (
                  <span className="w-4 h-4 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0">{t('prizes.place', { place: ord(place) })}</span>
              </span>
              <span className="shrink-0 font-bold tabular-nums text-text-primary">{count('points', points)}</span>
            </li>
          ))}
        </ol>
      )}
      {words && (
        <p dir="auto" className="whitespace-pre-line px-1 text-[13px] leading-6 text-text-secondary">
          {isolateLatin(words)}
        </p>
      )}
    </section>
  );
}

/** «كيف تشارك»: what to send, then by when — and that the Levonis team chooses. */
function HowTo({ c }: { c: Competition }) {
  const { t, lang } = useRewardsT();
  const steps = [t(HOW_FIRST[c.submission] ?? 'how.none'), t('how.send', { end: formatDateTime(c.ends_at, lang) })];
  return (
    <section aria-labelledby="how-title" className="space-y-2">
      <SectionHeading id="how-title">{t('how.title')}</SectionHeading>
      <ol className="lv-surface p-4 space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3">
            <span aria-hidden="true" className="size-8 shrink-0 rounded-full lv-well grid place-items-center text-[13px] font-bold tabular-nums text-text-primary">
              {formatFigure(i + 1, lang)}
            </span>
            <p className="min-w-0 flex-1 pt-1 text-[13.5px] leading-6 text-text-secondary">{step}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** «الوصف والشروط»: the owner's text in full (it holds the question), however long. */
function Terms({ c }: { c: Competition }) {
  const { t, tri } = useRewardsT();
  const text = tri(c.description);
  if (!text) return null;
  return (
    <section aria-labelledby="terms-title" className="space-y-2">
      <SectionHeading id="terms-title">{t('terms.title')}</SectionHeading>
      <div className="lv-surface p-4">
        <p dir="auto" className="whitespace-pre-line text-[14px] leading-7 text-text-secondary">
          {text}
        </p>
      </div>
    </section>
  );
}

/** «تفاصيل الاشتراك»: the terms of entering, then one entry per account and who chooses the winners (15.4). */
function Facts({ c }: { c: Competition }) {
  const h = useRewardsT();
  const { t, count, lang } = h;
  const fee = entryFee(c);
  const rows: ReadonlyArray<readonly [CopyKey, string]> = [
    ['facts.entry', fee > 0 ? withPoints(h, 'facts.fee', fee) : t('facts.free')],
    ['facts.send', t(SENDS[c.submission] ?? 'send.none')],
    ['facts.who', t(c.eligibility === 'printer_owners' ? 'who.printerOwners' : 'who.everyone')],
    ['facts.window', t('window.range', { start: formatDateTime(c.starts_at, lang), end: formatDateTime(c.ends_at, lang) })],
    [
      'facts.entrants',
      c.max_entries != null
        ? t('entrants.of', { n: formatFigure(c.entries_count ?? 0, lang), max: formatFigure(c.max_entries, lang) })
        : count('entrants', c.entries_count ?? 0),
    ],
  ];
  return (
    <section aria-labelledby="facts-title" className="space-y-2">
      <SectionHeading id="facts-title">{t('facts.title')}</SectionHeading>
      <div className="lv-surface overflow-hidden divide-y divide-border-subtle">
        <dl className="divide-y divide-border-subtle">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-3 text-[13.5px]">
              <dt className="text-text-muted">{t(label)}</dt>
              <dd className="min-w-0 text-end leading-6 text-text-primary">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="px-4 py-3 text-[13.5px] text-text-primary">{t('facts.once')}</p>
        <p className="px-4 py-3 text-[13px] leading-6 text-text-secondary">{t('facts.chosen')}</p>
      </div>
    </section>
  );
}

type Winner = Competition['winners'][number];

/** «الفائزون», in the server's order: each with the place, the shortened name, the prize, the photo and the answer. */
function Winners({ c, onPhoto }: { c: Competition; onPhoto: (url: string, place: number) => void }) {
  const { t } = useRewardsT();
  const winners = c.winners ?? [];
  return (
    <section aria-labelledby="winners-title" className="space-y-2">
      <SectionHeading id="winners-title">{t('winners.title')}</SectionHeading>
      {winners.length === 0 ? (
        <p className="px-1 text-[13px] leading-6 text-text-muted">{t('winners.none')}</p>
      ) : (
        <ol className="space-y-3">
          {winners.map((w) => (
            <WinnerItem key={w.place} w={w} onPhoto={onPhoto} />
          ))}
        </ol>
      )}
    </section>
  );
}

function WinnerItem({ w, onPhoto }: { w: Winner; onPhoto: (url: string, place: number) => void }) {
  const { t, count, ord, lang } = useRewardsT();
  const [unfolded, setUnfolded] = useState(false);
  const answer = w.answer ?? '';
  const answerId = `winner-${w.place}-answer`;
  const media = w.media_url;
  return (
    <li className="lv-surface p-3 space-y-3">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="size-8 shrink-0 rounded-full lv-well grid place-items-center text-[13px] font-bold tabular-nums text-text-primary">
          {w.place === 1 ? <Trophy className="w-4 h-4 text-gold" /> : formatFigure(w.place, lang)}
        </span>
        <span className="sr-only">{t('prizes.place', { place: ord(w.place) })}</span>
        <bdi dir="auto" className="min-w-0 flex-1 truncate text-[14px] font-bold text-text-primary">
          {w.name}
        </bdi>
        {w.prize_points > 0 && <span className="shrink-0 text-[13px] font-bold tabular-nums text-text-primary">{count('points', w.prize_points)}</span>}
      </div>
      {media && (
        <button
          type="button"
          aria-label={t('winners.photo')}
          onClick={() => onPhoto(media, w.place)}
          className="block w-full max-w-60 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <SafeImage
            src={media}
            aspect="square"
            sizes="(min-width: 640px) 240px, 70vw"
            className="w-full max-w-60 rounded-lg"
            alt={t('winners.photoAlt', { place: ord(w.place) })}
          />
        </button>
      )}
      {answer && (
        <>
          <p id={answerId} dir="auto" className={`whitespace-pre-line text-[14px] leading-7 text-text-secondary ${unfolded ? '' : 'line-clamp-6'}`}>
            {answer}
          </p>
          {answer.length > ANSWER_FOLD_CHARS && (
            <Button variant="ghost" size="sm" aria-expanded={unfolded} aria-controls={answerId} onClick={() => setUnfolded((v) => !v)}>
              {t(unfolded ? 'winners.readLess' : 'winners.readMore')}
            </Button>
          )}
        </>
      )}
    </li>
  );
}

/** A winner's photo, whole, in a centred window on its own ground. */
function PhotoViewer({ url, place, open, onClose }: { url: string; place: number; open: boolean; onClose: () => void }) {
  const { t, ord } = useRewardsT();
  const label = t('winners.photoAlt', { place: ord(place) });
  return (
    <Overlay
      open={open}
      onClose={onClose}
      placement="center"
      solid
      label={label}
      panelClassName="bg-surface-raised p-2 max-w-[560px] w-[92vw]"
      testId="competition-photo"
    >
      <div className="flex justify-end">
        <IconButton variant="secondary" label={t('close')} icon={<X className="w-5 h-5" aria-hidden="true" />} onClick={onClose} />
      </div>
      <SafeImage src={url} alt={label} aspect="square" fit="contain" sizes="(min-width: 640px) 560px, 100vw" className="mt-1 w-full rounded-lg" />
    </Overlay>
  );
}
