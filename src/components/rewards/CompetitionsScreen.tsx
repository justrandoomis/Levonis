/**
 * «المسابقات» — /rewards/competitions (rewards spec §3.5, with §4, §5 and §7).
 *
 * WHO RENDERS WHAT (src/pages/RewardsArea.tsx)
 * - The frame draws the header (h1 «المسابقات») with <CompetitionTabs /> in
 *   its second row while the customer is signed in or the session is still
 *   loading (never for a guest), the scroller and its `space-y-4` column.
 * - Session loading: the frame draws <CompetitionsSkeleton /> inside a
 *   TabPanels of the same group. A guest: the frame draws the sign-in state
 *   (guest.competitions.*), no tabs. A signed-in customer: this.
 * - The frame draws <StaleLine /> above the screen when `list.stale`, and
 *   <RelatedDoors current="competitions" /> after the panels; neither is
 *   drawn here.
 * - The frame owns the live region: it announces «حُمّلت نتائج أخرى» when
 *   `list.moreLoaded` grows, so «عرض المزيد» here only asks for the page.
 *
 * THE BODY is always inside
 *   <TabPanels value={view} order={['current', 'results']} group="rewards-competitions">
 * (while loading too): the header's tabs name that panel in aria-controls,
 * and the panel slides 20 px between the views. In each panel, by
 * `list.status`: the skeleton, the ErrorState, the SetupState
 * (`installed: false`), or the list.
 *
 * «الحالية»: «مفتوحة الآن», «تبدأ قريبًا», «قيد التحكيم» in the server's order
 * (open ones first, so fifty current competitions never bury what can be
 * entered), the cap line at CURRENT_MAX, the «chosen by the team» note; empty,
 * the EmptyState, with «اعرض النتائج» when there are results.
 *
 * «النتائج»: the «مشاركاتي فقط» toggle (a pressed lv-choice; it stays mounted
 * while its own list loads, so focus stays on it), the rows, and «عرض
 * المزيد» with its four states — idle, loading, error (the button stays to
 * retry) and end («هذه كل النتائج.»).
 *
 * A ROW is one link to the competition's page, never a button and never a
 * phase chip (the group heading carries the phase): the title, at most one
 * chip about THIS customer (their entry, else the gate keeping them out), the
 * fee while it can still be paid, when it closes or opens — a live clock only
 * inside 24 h — the places left when ten or fewer remain, and on a result the
 * winners. Its id goes to `lastOpened`, so Back to the list focuses it.
 *
 * DECIDES NOTHING. Phases, gates, places left, entries and winners are the
 * server's answer; dates read the answer's `server_time`, and every live
 * Countdown counts to `toDeviceTarget(iso, list.skewMs)`, its zero asking for
 * the list again (`reloadSoon`). Gold stays within the screen's budget: the
 * tabs' indicator and the «فزت…» chip. No raised card, no primary action.
 */
import { Fragment, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { Check, Trophy } from 'lucide-react';
import { TabPanels, TabStrip } from '../ui/Tabs';
import { Button } from '../ui/Button';
import { StatusChip, type Tone } from '../ui/Badge';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import Countdown from '../ui/Countdown';
import { formatFigure } from '../../lib/localeNumber';
import { formatDate } from '../orders/format';
import { CompetitionsSkeleton, ForwardChevron, GroupHeading, ICON_DISC, SetupState } from './AreaChrome';
import { pointsForm, type CopyKey } from './copy';
import { SEP, competitionGroups, isolateLatin, myResult, nearDate, resultWhen, toDeviceTarget, underADay, type CompetitionsView, type CurrentPhase } from './model';
import type { Competition, CompetitionsPage } from './types';
import type { CompetitionsListRead } from './useRewardsData';
import { useRewardsT } from './useT';

export interface CompetitionTabsProps {
  view: CompetitionsView;
  /** The global counts (`list.counts`); no figures while undefined. */
  counts: CompetitionsPage['counts'] | undefined;
  /** REPLACE to the view (the frame navigates). */
  onChange: (view: CompetitionsView) => void;
}

/**
 * «الحالية | النتائج»: two equal tabs that never scroll, the gold indicator,
 * one label weight (so a Sorani strip never reflows), each tab wired to the
 * screen's TabPanels of the same group; the arrow keys move along it.
 */
export function CompetitionTabs({ view, counts, onChange }: CompetitionTabsProps) {
  const { t, lang } = useRewardsT();
  const figure = (n: number | undefined) =>
    typeof n === 'number' && <span className="text-[11px] font-bold tabular-nums text-text-muted">{formatFigure(n, lang)}</span>;
  return (
    <TabStrip
      group="rewards-competitions"
      panels
      fill
      indicatorClassName="bg-gold"
      label={t('tabs.label')}
      value={view}
      items={[
        { id: 'current', label: t('tab.current'), badge: figure(counts?.current) },
        { id: 'results', label: t('tab.results'), badge: figure(counts?.results) },
      ]}
      onChange={(id) => onChange(id === 'results' ? 'results' : 'current')}
    />
  );
}

export interface CompetitionsScreenProps {
  /** useCompetitionsList for `view` / `mine`: `items` (paged, each id once), `more`, `loadMore`, `counts`. */
  list: CompetitionsListRead;
  /** From the address: «النتائج» only for `?view=results`. */
  view: CompetitionsView;
  /** «مشاركاتي فقط» (`&mine=1`), honoured only with the results. */
  mine: boolean;
  /** REPLACE to «الحالية» / «النتائج» (the frame navigates; a no-op for the current view). */
  onViewChange: (view: CompetitionsView) => void;
  /** REPLACE to the results with or without «مشاركاتي فقط». */
  onMineChange: (mine: boolean) => void;
  /** Set it to the row's id in the row's onClick; the frame focuses that row on Back. */
  lastOpened: RefObject<string | null>;
  /** For Countdown.onZero: reads the list again 1.5 s later (crossings close together share one read). */
  reloadSoon: () => void;
}

export function CompetitionsScreen({ list, view, mine, onViewChange, onMineChange, lastOpened, reloadSoon }: CompetitionsScreenProps) {
  // «اعرض النتائج» in an empty «الحالية» leaves with the panel it sits in;
  // the results panel then gives focus to its first control, so it is never
  // dropped on the page.
  const focusResults = useRef(false);
  const rows: RowClock = { serverTime: list.data?.server_time ?? '', skewMs: list.skewMs, lastOpened, reloadSoon };
  return (
    <TabPanels value={view} order={['current', 'results']} group="rewards-competitions">
      {view === 'results' ? (
        <ResultsPanel list={list} mine={mine} onMineChange={onMineChange} focusOnArrival={focusResults} rows={rows} />
      ) : (
        <CurrentPanel
          list={list}
          rows={rows}
          onShowResults={() => {
            focusResults.current = true;
            onViewChange('results');
          }}
        />
      )}
    </TabPanels>
  );
}

// ------------------------------------------------------------ «الحالية»

/** worker CURRENT_MAX: «الحالية» never lists more, and `counts.current` stops there too. */
const CURRENT_MAX = 50;

const GROUP_TITLE: Readonly<Record<CurrentPhase, CopyKey>> = {
  open: 'group.open',
  upcoming: 'group.upcoming',
  closed: 'group.closed',
};

function CurrentPanel({ list, rows, onShowResults }: { list: CompetitionsListRead; rows: RowClock; onShowResults: () => void }) {
  const { t, lang } = useRewardsT();
  if (list.status === 'idle' || list.status === 'loading') return <CompetitionsSkeleton />;
  if (list.status === 'error' || !list.data) return <ErrorState error={list.error} onRetry={() => void list.reload()} />;
  if (list.data.installed === false) return <SetupState />;

  const counts = list.data.counts;
  const groups = competitionGroups(list.items);
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<Trophy className="w-6 h-6" aria-hidden="true" />}
        title={t('list.empty.current.title')}
        description={t('list.empty.current.body')}
        action={
          (counts?.results ?? 0) > 0 ? (
            <Button variant="secondary" className="mt-1" onClick={onShowResults}>
              {t('list.empty.current.toResults')}
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.phase} className="space-y-2">
          <GroupHeading label={t(GROUP_TITLE[g.phase])} n={g.items.length} />
          <ul className="space-y-2">
            {g.items.map((c) => (
              <CompetitionRow key={c.id} c={c} {...rows} />
            ))}
          </ul>
        </div>
      ))}
      {(counts?.current ?? 0) >= CURRENT_MAX && (
        <p className="px-1 text-[12px] text-text-muted">{t('list.capped', { n: formatFigure(list.items.length, lang) })}</p>
      )}
      <p className="px-1 text-center text-[12px] text-text-muted">{t('list.chosenNote')}</p>
    </div>
  );
}

// ------------------------------------------------------------ «النتائج»

function ResultsPanel({
  list,
  mine,
  onMineChange,
  focusOnArrival,
  rows,
}: {
  list: CompetitionsListRead;
  mine: boolean;
  onMineChange: (mine: boolean) => void;
  /** Set when the customer arrived from «اعرض النتائج»: the toggle takes focus. */
  focusOnArrival: RefObject<boolean>;
  rows: RowClock;
}) {
  const { t } = useRewardsT();
  const toggle = useRef<HTMLButtonElement | null>(null);
  const endNote = useRef<HTMLParagraphElement | null>(null);
  const askedMore = useRef(false);
  const more = list.more;

  useEffect(() => {
    if (!focusOnArrival.current) return;
    focusOnArrival.current = false;
    toggle.current?.focus({ preventScroll: true });
  }, [focusOnArrival]);

  // The last page takes «عرض المزيد» away while it holds focus: «هذه كل
  // النتائج.» takes it instead, so the keyboard is not sent back to the top.
  useEffect(() => {
    if (more === 'loading') return;
    const asked = askedMore.current;
    askedMore.current = false;
    if (!asked || more !== 'end') return;
    const at = document.activeElement;
    if (!at || at === document.body) endNote.current?.focus({ preventScroll: true });
  }, [more]);

  if (list.status === 'ready' && list.data?.installed === false) return <SetupState />;

  // «اعرض كل النتائج» goes with the empty state it sits in; the toggle stays.
  const showAll = () => {
    onMineChange(false);
    toggle.current?.focus({ preventScroll: true });
  };

  let body: ReactNode;
  if (list.status === 'idle' || list.status === 'loading') {
    body = <CompetitionsSkeleton />;
  } else if (list.status === 'error' || !list.data) {
    body = <ErrorState error={list.error} onRetry={() => void list.reload()} />;
  } else if (list.items.length === 0) {
    body = mine ? (
      <EmptyState
        compact
        icon={<Trophy className="w-6 h-6" aria-hidden="true" />}
        title={t('list.empty.mine.title')}
        action={
          <Button variant="secondary" className="mt-1" onClick={showAll}>
            {t('list.empty.mine.cta')}
          </Button>
        }
      />
    ) : (
      <EmptyState icon={<Trophy className="w-6 h-6" aria-hidden="true" />} title={t('list.empty.results.title')} description={t('list.empty.results.body')} />
    );
  } else {
    body = (
      <>
        <ul className="space-y-2">
          {list.items.map((c) => (
            <CompetitionRow key={c.id} c={c} {...rows} />
          ))}
        </ul>
        {more === 'end' ? (
          <p ref={endNote} tabIndex={-1} className="px-1 text-center text-[12px] text-text-muted focus:outline-none">
            {t('list.end')}
          </p>
        ) : (
          <div className="space-y-2">
            <Button
              variant="secondary"
              block
              loading={more === 'loading'}
              onClick={() => {
                askedMore.current = true;
                return list.loadMore();
              }}
            >
              {t('list.more')}
            </Button>
            {more === 'error' && (
              <p role="alert" className="px-1 text-center text-[12px] text-danger">
                {t('list.moreError')}
              </p>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <button
          ref={toggle}
          type="button"
          aria-pressed={mine}
          onClick={() => onMineChange(!mine)}
          className="lv-choice inline-flex items-center gap-2 px-3 text-[13px] font-semibold"
        >
          {mine && (
            <span className="lv-choice-mark">
              <Check className="h-3 w-3" aria-hidden="true" />
            </span>
          )}
          {t('filter.mine')}
        </button>
      </div>
      {body}
    </div>
  );
}

// ------------------------------------------------------------ one row

/** What every row reads beside its competition: the answer's clock, and the frame's hooks. */
interface RowClock {
  /** The answer's `server_time`: dates and «under 24 h» by the server, never the device. */
  serverTime: string;
  /** For `toDeviceTarget`: the server's clock minus the device's. */
  skewMs: number;
  lastOpened: RefObject<string | null>;
  reloadSoon: () => void;
}

/** A row names the places left only when this few remain (§3.5). */
const FEW_SPOTS = 10;
/** The winners a result names before «و{n} فائزين آخرين». */
const WINNERS_NAMED = 3;

type ChipKey =
  | 'chip.entered'
  | 'chip.awaiting'
  | 'chip.won'
  | 'chip.notWon'
  | 'chip.refunded'
  | 'chip.cancelled'
  | 'chip.rejected'
  | 'chip.full'
  | 'chip.printerOwners';

interface ViewerChip {
  tone: Tone;
  key: ChipKey;
  /** «فزت بالمركز {place}». */
  place?: number;
}

const PRINTER_OWNERS: ViewerChip = { tone: 'neutral', key: 'chip.printerOwners' };

/**
 * At most one chip about THIS customer, the first that applies (§3.5): what
 * became of their entry, else why the server's gate keeps them out. The gate
 * names the window before who may enter (worker `gateOf`), so an upcoming
 * competition reports 'upcoming'; the server's own `eligible` still tells a
 * customer without a Levonis printer whom it is for before it opens, and
 * stands in for an older server's missing gate.
 */
function viewerChip(c: Competition): ViewerChip | null {
  switch (myResult(c)) {
    case 'entered':
      return { tone: 'success', key: 'chip.entered' };
    case 'awaiting':
      return { tone: 'info', key: 'chip.awaiting' };
    case 'won': {
      const place = c.my_entry?.place;
      // The server names a winner with a place, always; without one there is no place to say.
      return typeof place === 'number' && place >= 1 ? { tone: 'accent', key: 'chip.won', place } : null;
    }
    case 'not_won':
      return { tone: 'neutral', key: 'chip.notWon' };
    case 'refunded_cancel':
      return { tone: 'info', key: 'chip.refunded' };
    case 'cancelled_free':
      return { tone: 'neutral', key: 'chip.cancelled' };
    case 'rejected':
    case 'rejected_refund':
      return { tone: 'neutral', key: 'chip.rejected' };
    default:
      break;
  }
  const blocked = c.gate?.blocked_by;
  if (blocked === 'full') return { tone: 'neutral', key: 'chip.full' };
  if (blocked === 'not_eligible') return PRINTER_OWNERS;
  if (c.eligible === false && (c.phase === 'upcoming' || (c.phase === 'open' && !c.gate))) return PRINTER_OWNERS;
  return null;
}

/**
 * One competition: a link to its page (≈ 84 px, no image, no description).
 * Its name is the title and its description the facts line (and the winners),
 * so a screen reader hears the row the way it reads.
 */
function CompetitionRow({ c, serverTime, skewMs, lastOpened, reloadSoon }: RowClock & { c: Competition }) {
  const { t, tx, count, ord, tri, lang } = useRewardsT();
  const titleId = `cmp-${c.id}-t`;
  const metaId = `cmp-${c.id}-m`;
  const winnersId = `cmp-${c.id}-w`;
  const chip = viewerChip(c);
  /** A dated sentence, or nothing when the server's instant does not read. */
  const dated = (key: CopyKey, date: string) => (date ? t(key, { date }) : null);

  let when: ReactNode = null;
  switch (c.phase) {
    case 'open':
      when = underADay(c.ends_at, serverTime) ? (
        <Countdown target={toDeviceTarget(c.ends_at, skewMs)} kind="ends" onZero={reloadSoon} />
      ) : (
        dated('row.closes', nearDate(c.ends_at, serverTime, lang))
      );
      break;
    case 'upcoming':
      when = underADay(c.starts_at, serverTime) ? (
        <Countdown target={toDeviceTarget(c.starts_at, skewMs)} kind="opens" onZero={reloadSoon} />
      ) : (
        dated('row.opens', nearDate(c.starts_at, serverTime, lang))
      );
      break;
    case 'closed':
      when = dated('row.closedOn', nearDate(c.ends_at, serverTime, lang));
      break;
    default: {
      // A result: the day its winners were announced, else the day it ended; a cancelled one is never dated.
      const ended = resultWhen(c);
      if (ended) when = 'date' in ended ? dated(ended.key, formatDate(ended.date, lang)) : t(ended.key);
      break;
    }
  }

  // The facts after the chip, each its own item (so a figure and a date never share a run).
  const facts: ReactNode[] = [];
  if (c.phase === 'open' || c.phase === 'upcoming') {
    facts.push(c.entry_mode === 'points' && c.entry_points > 0 ? t('row.fee', { points: count(pointsForm('row.fee'), c.entry_points) }) : t('row.free'));
  }
  if (when) facts.push(when);
  const spots = c.gate?.spots_left;
  if (c.phase === 'open' && typeof spots === 'number' && spots > 0 && spots <= FEW_SPOTS) facts.push(count('spotsLeft', spots));

  const winners = c.phase === 'finished' ? (c.winners ?? []) : [];
  const named = winners.slice(0, WINNERS_NAMED);
  const others = winners.length - named.length;

  return (
    <li>
      <Link
        to={`/rewards/competitions/${encodeURIComponent(c.id)}`}
        data-competition-link={c.id}
        aria-labelledby={titleId}
        aria-describedby={named.length > 0 ? `${metaId} ${winnersId}` : metaId}
        onClick={() => {
          lastOpened.current = c.id;
        }}
        className="lv-surface flex items-start gap-3 p-3 hover:bg-surface-raised active:shadow-press transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span aria-hidden="true" className={ICON_DISC}>
          <Trophy className="w-5 h-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span id={titleId} dir="auto" className="block text-[14px] font-bold leading-5 line-clamp-2 text-text-primary">
            {isolateLatin(tri(c.title) || t('title.competition'))}
          </span>
          <span id={metaId} className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5 text-text-muted tabular-nums">
            {chip && (
              <StatusChip tone={chip.tone} icon={chip.tone === 'accent' ? <Trophy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : undefined}>
                {chip.place !== undefined ? t(chip.key, { place: ord(chip.place) }) : t(chip.key)}
              </StatusChip>
            )}
            {facts.map((fact, i) => (
              <Fragment key={i}>
                {i > 0 && <span aria-hidden="true">·</span>}
                <span>{fact}</span>
              </Fragment>
            ))}
          </span>
          {named.length > 0 && (
            <span id={winnersId} className="mt-1 block text-[12px] leading-5 text-text-secondary line-clamp-2">
              {tx('row.winners', {
                names: (
                  <>
                    {named.map((w, i) => (
                      <Fragment key={`${w.place}-${i}`}>
                        {i > 0 && SEP[lang]}
                        <bdi dir="auto">{w.name}</bdi>
                      </Fragment>
                    ))}
                    {others > 0 && ` ${count('moreWinners', others)}`}
                  </>
                ),
              })}
            </span>
          )}
        </span>
        <ForwardChevron className="mt-2.5" />
      </Link>
    </li>
  );
}
