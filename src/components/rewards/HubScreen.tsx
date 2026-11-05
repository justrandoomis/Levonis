/**
 * «المكافآت» — THE HUB, /rewards (rewards spec §3.1).
 *
 * In one glance: the one thing to do now, the points, and the four sections.
 * It is the same height whatever the account holds (at most one card, the
 * points strip, four doors, the terms link), so a section that grows never
 * buries another: the items themselves live on the sections' own pages.
 *
 * WHO RENDERS WHAT (src/pages/RewardsArea.tsx)
 * - The frame draws the header (h1 «المكافآت», back, mascot), the scroller
 *   and its `space-y-4` column, the skeleton while the session loads, and the
 *   StaleLine above this screen whenever `hub.stale`. A guest gets
 *   <HubGuest />, a signed-in customer <HubScreen />.
 *
 * HubScreen, by `hub.status` (§3.1 States):
 * - the first read, no data yet: <HubSkeleton />;
 * - 'error', no data: the danger alert with «إعادة المحاولة» (its retry keeps
 *   the alert on screen, the button busy, until the read answers); the strip
 *   with the wallet's balance, or a muted «—» while the wallet has not
 *   answered (never an invented 0), and no pending line; the doors with their
 *   how-lines and no badges; no card;
 * - `installed: false` (before migration 0220): the strip, whose balance is
 *   real, and <SetupState />; no doors, no card;
 * - ready: «بانتظارك» from `nextAction` (no card when it is null), the strip,
 *   the doors from `doorLines`.
 * Every state of a signed-in customer ends with the terms link.
 *
 * RULES KEPT HERE
 * - Decides nothing: the card, the figures, the windows and the counts are
 *   the server's (`nextAction` and `doorLines` only pick and word them).
 * - Clocks: «under 24 h» and the dates from `server_time`; a live clock
 *   counts to `toDeviceTarget(iso, hub.skewMs)` and reads the hub again
 *   (`reloadSoon`) when it reaches zero.
 * - Gold: the coin only. Badges are neutral, hidden from assistive tech, and
 *   the same count is spelled in the door's text.
 * - Raised: the «بانتظارك» card here and the guest card in HubGuest, never
 *   both on one screen; each holds the screen's one primary.
 * - A date and a figure never share one text run: each card line holds one.
 * - The coupon's «استخدمه الآن» is useCouponAction (./couponUse): it saves
 *   the code, then the cart, the product, the section or the targets sheet,
 *   which this screen owns and renders once.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Coins, Gift, Hourglass, Star, Ticket, Trophy, type LucideIcon } from 'lucide-react';
import { useMoney } from '../../CurrencyContext';
import { useSignInPrompt } from '../../lib/guest';
import { formatFigure, formatPercent } from '../../lib/localeNumber';
import { formatDate } from '../orders/format';
import { Button } from '../ui/Button';
import Countdown from '../ui/Countdown';
import { CoinStar, CountBadge, ForwardChevron, HubSkeleton, ICON_DISC, INLINE_LINK, PRESSABLE_ROW, SetupState } from './AreaChrome';
import { pointsForm, type CopyKey } from './copy';
import { useCouponAction } from './couponUse';
import { doorLines, doorText, nearDate, nextAction, toDeviceTarget, underADay, type Doors, type NextAction } from './model';
import type { Competition, PrinterToRate, RewardCoupon, RewardsHubData } from './types';
import type { Read } from './useRewardsData';
import { useRewardsT } from './useT';

export interface HubScreenProps {
  /** GET /api/rewards/program (useRewardsHub). Enabled for this screen, so never 'idle' for long. */
  hub: Read<RewardsHubData>;
  /** The wallet's point balance for the strip when the hub could not load; null while the wallet has not answered. */
  walletPoints: number | null;
  /** For Countdown.onZero: reads the hub again 1.5 s later (crossings close together share one read). */
  reloadSoon: () => void;
}

export function HubScreen({ hub, walletPoints, reloadSoon }: HubScreenProps) {
  const coupon = useCouponAction();
  // The customer's own «إعادة المحاولة» keeps the alert (and its busy button,
  // which holds the focus) on screen until the read answers; any other read
  // with no data yet shows the skeleton.
  const [retrying, setRetrying] = useState(false);
  const { reload } = hub;
  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await reload();
    } finally {
      setRetrying(false);
    }
  }, [reload]);

  const data = hub.data;
  if (!data) {
    if (hub.status === 'error' || (hub.status === 'loading' && retrying)) {
      return (
        <>
          <HubError onRetry={retry} />
          <BalanceStrip points={walletPoints} pending={0} />
          <HubDoors doors={doorLines(null)} serverTime="" />
          <TermsLink />
        </>
      );
    }
    return <HubSkeleton />;
  }

  const pending = data.pending_points?.points ?? 0;
  if (data.installed === false) {
    return (
      <>
        <BalanceStrip points={data.point_balance} pending={pending} />
        <SetupState />
        <TermsLink />
      </>
    );
  }

  const next = nextAction(data);
  return (
    <>
      {next && <NowCard action={next} hub={data} skewMs={hub.skewMs} reloadSoon={reloadSoon} onUseCoupon={coupon.useIt} />}
      <BalanceStrip points={data.point_balance} pending={pending} />
      <HubDoors doors={doorLines(data)} serverTime={data.server_time} />
      <TermsLink />
      {coupon.sheet}
    </>
  );
}

/** The four sections a guest is told about, in the doors' icons. */
const BENEFITS: ReadonlyArray<{ key: CopyKey; Icon: LucideIcon }> = [
  { key: 'guest.benefit.coupons', Icon: Ticket },
  { key: 'guest.benefit.rate', Icon: Star },
  { key: 'guest.benefit.shop', Icon: Coins },
  { key: 'guest.benefit.competitions', Icon: Trophy },
];

/**
 * The hub for a guest (§3.1 GuestCard): the raised card naming the four
 * sections, its primary sign-in Button (useSignInPrompt().signIn, which
 * returns to pathname + search), then the terms link. No doors, no fetch.
 */
export function HubGuest() {
  const { t } = useRewardsT();
  const { signIn } = useSignInPrompt();
  return (
    <>
      <section aria-labelledby="hub-guest-title" className="lv-surface-raised p-5 space-y-4">
        <h2 id="hub-guest-title" className="text-[20px] font-bold leading-8 text-text-primary">
          {t('guest.hub.title')}
        </h2>
        <ul className="space-y-3">
          {BENEFITS.map(({ key, Icon }) => (
            <li key={key} className="flex items-center gap-3">
              <span aria-hidden="true" className="size-9 shrink-0 rounded-full lv-well grid place-items-center text-text-secondary">
                <Icon className="w-[18px] h-[18px]" />
              </span>
              <span className="min-w-0 flex-1 text-[13.5px] leading-6 text-text-secondary">{t(key)}</span>
            </li>
          ))}
        </ul>
        <Button variant="primary" block onClick={signIn}>
          {t('guest.signIn')}
        </Button>
      </section>
      <TermsLink />
    </>
  );
}

// ------------------------------------------------------------ the read failed, with nothing to show

function HubError({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useRewardsT();
  return (
    <div role="alert" className="lv-alert lv-alert-danger flex items-center justify-between gap-3 text-[13px] text-text-primary">
      <span className="min-w-0">{t('hub.error')}</span>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------ «بانتظارك»: the one thing to do now

/** A line under the card's title: one sentence, in 13 px secondary ink. */
const NOW_LINE = 'text-[13px] text-text-secondary';

interface NowCardProps {
  action: NextAction;
  hub: RewardsHubData;
  skewMs: number;
  reloadSoon: () => void;
  onUseCoupon: (c: RewardCoupon) => void;
}

function NowCard({ action, hub, skewMs, reloadSoon, onUseCoupon }: NowCardProps) {
  const clock = { serverTime: hub.server_time, skewMs, reloadSoon };
  if (action.kind === 'coupon-ending' || action.kind === 'coupon') {
    return <NowCoupon coupon={action.coupon} ending={action.kind === 'coupon-ending'} clock={clock} onUse={onUseCoupon} />;
  }
  if (action.kind === 'gift') return <NowGift printer={action.printer} />;
  if (action.kind === 'competition') return <NowCompetition competition={action.competition} clock={clock} />;
  return <NowRate printer={action.printer} />;
}

/** The card's frame: the eyebrow (icon in ink, the h2 the section is named by), the title, its lines, the one primary. */
function NowFrame({
  kind,
  Icon,
  eyebrow,
  title,
  ownerText = false,
  children,
  primary,
}: {
  kind: NextAction['kind'];
  Icon: LucideIcon;
  eyebrow: string;
  title: string;
  /** The title is the owner's words (a competition, a printer): it takes its own direction. */
  ownerText?: boolean;
  /** The lines under the title, one fact each. */
  children?: ReactNode;
  primary: ReactNode;
}) {
  return (
    <section aria-labelledby="now-eyebrow" data-rewards-now={kind} className="lv-surface-raised p-4 space-y-3">
      <h2 id="now-eyebrow" className="flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary">
        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{eyebrow}</span>
      </h2>
      <div className="space-y-1">
        <p dir={ownerText ? 'auto' : undefined} className="break-words text-[17px] font-bold leading-6 text-text-primary">
          {title}
        </p>
        {children}
      </div>
      {primary}
    </section>
  );
}

interface Clock {
  serverTime: string;
  skewMs: number;
  reloadSoon: () => void;
}

/** When it ends: a live clock in its last 24 h (by the server's clock), else the date. */
function EndsLine({ iso, dateKey, clock }: { iso: string; dateKey: 'coupon.endsOn' | 'row.closes'; clock: Clock }) {
  const { t, lang } = useRewardsT();
  if (underADay(iso, clock.serverTime)) {
    return (
      <p className={NOW_LINE}>
        <Countdown target={toDeviceTarget(iso, clock.skewMs)} kind="ends" onZero={clock.reloadSoon} className="text-[13px]" />
      </p>
    );
  }
  const date = nearDate(iso, clock.serverTime, lang);
  return date ? <p className={NOW_LINE}>{t(dateKey, { date })}</p> : null;
}

/** A usable coupon (the one ending within 48 h first): what it is, when it ends, what it covers, «استخدمه الآن». */
function NowCoupon({ coupon: c, ending, clock, onUse }: { coupon: RewardCoupon; ending: boolean; clock: Clock; onUse: (c: RewardCoupon) => void }) {
  const { t, lang } = useRewardsT();
  const { money } = useMoney();
  const freeDelivery = c.kind === 'free_shipping';
  const title = freeDelivery ? t('coupon.freeShipping') : t('coupon.filament', { percent: formatPercent(c.percent, lang, 0) });
  const cap = c.max_discount_iqd;
  const detail = freeDelivery
    ? t('coupon.shipDetail')
    : cap != null && cap > 0
      ? t('coupon.capSelected', { money: money(cap) })
      : t('coupon.selected');
  return (
    <NowFrame
      kind={ending ? 'coupon-ending' : 'coupon'}
      Icon={ending ? Hourglass : Ticket}
      eyebrow={t(ending ? 'now.couponEnding' : 'now.couponActive')}
      title={title}
      primary={
        <Button variant="primary" block onClick={() => onUse(c)}>
          {t('coupon.use')}
        </Button>
      }
    >
      <EndsLine iso={c.expires_at} dateKey="coupon.endsOn" clock={clock} />
      <p className={NOW_LINE}>{detail}</p>
    </NowFrame>
  );
}

/** A review the team approved: the gift is the customer's to choose in «هداياي». */
function NowGift({ printer: p }: { printer: PrinterToRate }) {
  const { t, tri, lang } = useRewardsT();
  return (
    <NowFrame
      kind="gift"
      Icon={Gift}
      eyebrow={t('now.gift')}
      title={tri(p.name)}
      ownerText
      primary={
        <Link to="/gifts" className="lv-button lv-button-primary w-full">
          {t('rate.chooseGift')}
        </Link>
      }
    >
      {p.reward_level != null && <p className={NOW_LINE}>{t('now.gift.body', { level: formatFigure(p.reward_level, lang) })}</p>}
    </NowFrame>
  );
}

/**
 * The open competition closing first that the server says this customer can
 * enter. It opens the competition's page (never the sheet), so the question,
 * the prizes and the rules are read before entering.
 */
function NowCompetition({ competition: c, clock }: { competition: Competition; clock: Clock }) {
  const { t, tri, count } = useRewardsT();
  const fee = c.entry_mode === 'points' && c.entry_points > 0;
  return (
    <NowFrame
      kind="competition"
      Icon={Trophy}
      eyebrow={t('now.competition')}
      title={tri(c.title)}
      ownerText
      primary={
        <Link to={`/rewards/competitions/${encodeURIComponent(c.id)}`} className="lv-button lv-button-primary w-full">
          {t('now.competition.cta')}
        </Link>
      }
    >
      <EndsLine iso={c.ends_at} dateKey="row.closes" clock={clock} />
      <p className={NOW_LINE}>{fee ? t('row.fee', { points: count(pointsForm('row.fee'), c.entry_points) }) : t('row.free')}</p>
    </NowFrame>
  );
}

/** The newest delivered printer still to review (it has a page): «اكتب مراجعتك» on that page. */
function NowRate({ printer: p }: { printer: PrinterToRate }) {
  const { t, tri, lang } = useRewardsT();
  const date = formatDate(p.delivered_at, lang);
  return (
    <NowFrame
      kind="rate"
      Icon={Star}
      eyebrow={t('now.rate')}
      title={tri(p.name)}
      ownerText
      primary={
        <Link to={`/product/${encodeURIComponent(p.slug)}#reviews`} className="lv-button lv-button-primary w-full">
          {t('rate.write')}
        </Link>
      }
    >
      {date && <p className={NOW_LINE}>{t('now.rate.body', { date })}</p>}
    </NowFrame>
  );
}

// ------------------------------------------------------------ the points strip

/**
 * «رصيدك» and the balance, to /points («النقاط والمهام»: history, check-in,
 * missions). The link is named by where it goes and described by the figures.
 * `points` null is a balance not known yet: a muted «—», never a 0.
 */
function BalanceStrip({ points, pending }: { points: number | null; pending: number }) {
  const { t, count } = useRewardsT();
  const showPending = pending > 0;
  return (
    <Link
      to="/points"
      aria-labelledby="hub-points-door"
      aria-describedby={`hub-balance-label hub-balance-figure${showPending ? ' hub-balance-pending' : ''}`}
      className={PRESSABLE_ROW}
    >
      <span aria-hidden="true" className="size-9 shrink-0 rounded-full bg-gold-fill text-onyx grid place-items-center">
        <CoinStar className="w-4 h-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2 text-[12px] font-semibold text-text-secondary">
          <span id="hub-balance-label" className="min-w-0">
            {t('hub.balance')}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <span id="hub-points-door">{t('hub.pointsDoor')}</span>
            <ForwardChevron />
          </span>
        </span>
        {points === null ? (
          <span id="hub-balance-figure" className="block text-ui-xl font-normal text-text-muted">
            —
          </span>
        ) : (
          <span id="hub-balance-figure" className="block text-ui-xl font-bold tabular-nums text-text-primary">
            {count('points', points)}
          </span>
        )}
        {showPending && (
          <span id="hub-balance-pending" className="block text-[12px] text-text-muted">
            {t('hub.pending', { points: count('points', pending) })}
          </span>
        )}
      </span>
    </Link>
  );
}

// ------------------------------------------------------------ the four doors

const DOORS: ReadonlyArray<{ key: keyof Doors; to: string; title: CopyKey; Icon: LucideIcon }> = [
  { key: 'coupons', to: '/rewards/coupons', title: 'title.coupons', Icon: Ticket },
  { key: 'competitions', to: '/rewards/competitions', title: 'title.competitions', Icon: Trophy },
  { key: 'rate', to: '/rewards/rate', title: 'title.rate', Icon: Star },
  { key: 'shop', to: '/rewards/shop', title: 'title.shop', Icon: Coins },
];

/**
 * «أقسام المكافآت»: four fixed links, one column on a phone, two from `sm`.
 * Each is named by its title and described by its status lines (two at most,
 * clamped); the badge beside the title repeats a count the lines spell.
 */
function HubDoors({ doors, serverTime }: { doors: Doors; serverTime: string }) {
  const { t, lang } = useRewardsT();
  return (
    <nav aria-label={t('hub.doors')}>
      <ul className="grid gap-2 sm:grid-cols-2">
        {DOORS.map(({ key, to, title, Icon }) => {
          const door = doors[key];
          const titleId = `hub-door-${key}`;
          const statusId = `hub-door-${key}-status`;
          return (
            <li key={key}>
              <Link
                to={to}
                aria-labelledby={titleId}
                aria-describedby={door.lines.length > 0 ? statusId : undefined}
                className={`${PRESSABLE_ROW} h-full`}
              >
                <span aria-hidden="true" className={ICON_DISC}>
                  <Icon className="w-5 h-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span id={titleId} className="min-w-0 flex-1 text-[15px] font-bold leading-6 text-text-primary">
                      {t(title)}
                    </span>
                    <CountBadge n={door.badge} />
                    <ForwardChevron />
                  </span>
                  {door.lines.length > 0 && (
                    <span id={statusId} className="text-[12.5px] leading-5 text-text-secondary line-clamp-2">
                      {door.lines.map((line, i) => (
                        <span key={i} className="block">
                          {doorText(line, lang, serverTime)}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ------------------------------------------------------------ the terms

/** «شروط برنامج المكافآت», centred under everything. */
function TermsLink() {
  const { t } = useRewardsT();
  return (
    <p className="text-center text-[13px]">
      <Link to="/policies/rewards" className={INLINE_LINK}>
        {t('terms')}
      </Link>
    </p>
  );
}
