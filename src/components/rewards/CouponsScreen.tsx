/**
 * «كوبوناتي» — /rewards/coupons (rewards spec §3.2): use the coupon that ends
 * first, see exactly what each one covers, and look up the past ones.
 *
 * WHO RENDERS WHAT (src/pages/RewardsArea.tsx)
 * - The frame draws the header (h1 «كوبوناتي»), the scroller and its
 *   `space-y-4` column; this returns the screen's blocks as a fragment.
 * - Session loading: the frame draws <CouponsSkeleton />. A guest: the frame
 *   draws the sign-in state (guest.coupons.*). A signed-in customer: this.
 * - The frame draws <StaleLine /> above the screen when `hub.stale`, and
 *   <RelatedDoors current="coupons" /> after it; neither is drawn here.
 *
 * By `hub.status`:
 * - no data yet: <CouponsSkeleton />; a failed first read: <ErrorState />;
 * - `installed === false` (before migration 0220): <SetupState />;
 * - ready: `hub.data.coupons` (≤ 40: active by soonest end, then the rest
 *   newest first) and `hub.data.coupon_counts`.
 *
 * THE SCREEN, top to bottom:
 * 1. The active coupons. The FOCAL one — the first `usable` active coupon,
 *    the soonest the customer can actually spend — is this screen's one
 *    raised card and holds its one primary button, «استخدمه الآن». Every other
 *    active coupon is a flat card with a secondary «استخدمه». A coupon with
 *    nothing on sale to spend it on says so in its chip and has no use button.
 *    With no active coupon: the EmptyState (what each printer earns, and the
 *    points shop when it sells anything), and the past list opens by itself.
 * 2. «الكوبونات السابقة (n)», folded, n from `coupon_counts.past`: compact
 *    rows with what became of each (used — with its order —, expired,
 *    withdrawn and why).
 * 3. «تُعرض أحدث 40 من 52» when the counts exceed the list.
 *
 * RULES IT KEEPS
 * - It decides nothing: states, windows, targets and counts are the server's;
 *   day counts and «under 24 h» read `server_time`, and a live clock counts to
 *   `toDeviceTarget(expires_at, hub.skewMs)`, so a phone with a wrong clock
 *   still ends at the server's instant. At zero the hub is read again
 *   (`reloadSoon`) and the coupon moves to the past list.
 * - «استخدمه الآن», «استخدمه» and «ومنتجان آخران» all go through
 *   `useCouponAction()` (./couponUse): the code is saved for the cart, then
 *   the coupon's one page, or the choice of its products in the targets
 *   sheet. The sheet is rendered once, here, and unmounts with the screen.
 * - The code is copied by CodeCopy (below): its own 44 px IconButton and a
 *   polite status line, never the house's 32 px inline copy control. A failed
 *   copy says so and leaves the code on screen to type — never a tick.
 * - Gold: none. Badges and chips carry word + dot + tint; points are ink.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, Copy, Percent, Ticket, Truck } from 'lucide-react';
import { useMoney } from '../../CurrencyContext';
import { copyText as copyToClipboard } from '../../lib/copyText';
import { formatFigure, formatPercent } from '../../lib/localeNumber';
import { formatDate } from '../orders/format';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import { StatusChip } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import Countdown from '../ui/Countdown';
import { CouponsSkeleton, ForwardChevron, ICON_DISC, INLINE_LINK, SetupState } from './AreaChrome';
import type { CopyKey } from './copy';
import { useCouponAction, useShipDetail } from './couponUse';
import { SEP, couponDestination, nearDate, revokeKey, toDeviceTarget, underADay, usable, wholeDaysLeft } from './model';
import type { RewardCoupon, RewardsHubData } from './types';
import type { Read } from './useRewardsData';
import { useRewardsT } from './useT';

export interface CouponsScreenProps {
  /** GET /api/rewards/program (useRewardsHub): `coupons`, `coupon_counts`, `program`, `shop`, `server_time`. */
  hub: Read<RewardsHubData>;
  /** For Countdown.onZero: reads the hub again 1.5 s later (crossings close together share one read). */
  reloadSoon: () => void;
}

/** How many of a filament coupon's products its card names inline; the rest open the targets sheet. */
const NAMES_SHOWN = 2;
/** How long the tick and «نُسخ الكود» stay after a copy. */
const COPIED_MS = 2_000;

export function CouponsScreen({ hub, reloadSoon }: CouponsScreenProps) {
  const { t, lang } = useRewardsT();
  const coupon = useCouponAction();
  // null: the past list follows the data (open when nothing is active); a
  // press makes it the customer's choice.
  const [pastChoice, setPastChoice] = useState<boolean | null>(null);

  const data = hub.data;
  if (!data) {
    return hub.status === 'error' ? <ErrorState error={hub.error} onRetry={() => void hub.reload()} /> : <CouponsSkeleton />;
  }
  if (data.installed === false) return <SetupState />;

  const coupons = data.coupons ?? [];
  const active = coupons.filter((c) => c.state === 'active');
  const past = coupons.filter((c) => c.state !== 'active');
  const focal = active.find(usable) ?? null;
  const ordered = focal ? [focal, ...active.filter((c) => c !== focal)] : active;
  const pastOpen = pastChoice ?? active.length === 0;
  const counts = data.coupon_counts;
  const pastCount = counts?.past ?? past.length;
  const total = counts ? counts.active + counts.past : coupons.length;
  const use = (c: RewardCoupon) => coupon.useIt(c);

  return (
    <>
      {ordered.length > 0 ? (
        <ul className="space-y-3">
          {ordered.map((c) => (
            <CouponCard
              key={c.id}
              c={c}
              focal={c === focal}
              serverTime={data.server_time}
              skewMs={hub.skewMs}
              reloadSoon={reloadSoon}
              onUse={use}
            />
          ))}
        </ul>
      ) : (
        <CouponsEmpty data={data} />
      )}

      {past.length > 0 && (
        <div>
          <h2>
            <Button
              variant="ghost"
              block
              aria-expanded={pastOpen}
              aria-controls="past-coupons"
              className="justify-between"
              iconEnd={<ChevronDown className={`w-4 h-4 shrink-0 ${pastOpen ? 'rotate-180' : ''}`} aria-hidden="true" />}
              onClick={() => setPastChoice(!pastOpen)}
            >
              {t('coupons.past', { n: formatFigure(pastCount, lang) })}
            </Button>
          </h2>
          <ul id="past-coupons" hidden={!pastOpen} className="mt-2 lv-surface overflow-hidden divide-y divide-border-subtle">
            {past.map((c) => (
              <PastRow key={c.id} c={c} />
            ))}
          </ul>
        </div>
      )}

      {total > coupons.length && (
        <p className="px-1 text-[12px] leading-5 text-text-muted">
          {t('coupons.capped', { shown: formatFigure(coupons.length, lang), total: formatFigure(total, lang) })}
        </p>
      )}

      {coupon.sheet}
    </>
  );
}

// ------------------------------------------------------------ one active coupon

interface CouponCardProps {
  c: RewardCoupon;
  /** The soonest usable coupon: raised, with the screen's one primary button. */
  focal: boolean;
  serverTime: string;
  skewMs: number;
  reloadSoon: () => void;
  onUse: (c: RewardCoupon) => void;
}

/** «توصيل مجاني» / «خصم 15٪ على الفلامنت». */
function useCouponTitle() {
  const { t, lang } = useRewardsT();
  return (c: RewardCoupon) =>
    c.kind === 'free_shipping' ? t('coupon.freeShipping') : t('coupon.filament', { percent: formatPercent(c.percent, lang, 0) });
}

function CouponCard({ c, focal, serverTime, skewMs, reloadSoon, onUse }: CouponCardProps) {
  const { t, count, lang } = useRewardsT();
  const title = useCouponTitle();
  const ship = c.kind === 'free_shipping';
  const canUse = couponDestination(c).kind !== 'none';
  const left = wholeDaysLeft(c.expires_at, serverTime);
  const days = Number.isFinite(left) ? Math.max(0, left) : 0;
  const surface = focal ? 'lv-surface-raised' : 'lv-surface';
  const source =
    c.source === 'points_shop'
      ? t('coupon.fromShop', { points: count('points', c.points_spent) })
      : c.source === 'admin'
        ? t('coupon.fromTeam')
        : t('coupon.fromPrinter');

  return (
    <li className={`${surface} p-4 space-y-3`} data-testid="reward-coupon" data-focal={focal || undefined}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={ICON_DISC}>
          {ship ? <Truck className="w-5 h-5" /> : <Percent className="w-5 h-5" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h2 className="min-w-0 text-[16px] font-bold leading-6 text-text-primary">{title(c)}</h2>
          {/* One state chip: the days left, or — nothing on sale to spend it on — that. */}
          {canUse ? (
            <StatusChip tone={days <= 1 ? 'warning' : 'success'}>{count('daysLeft', days)}</StatusChip>
          ) : (
            <StatusChip tone="warning">{t('coupon.chip.noTargets')}</StatusChip>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-[12px] leading-5 text-text-muted">
          {underADay(c.expires_at, serverTime) ? (
            <Countdown target={toDeviceTarget(c.expires_at, skewMs)} kind="ends" onZero={reloadSoon} className="text-[12px]" />
          ) : (
            t('coupon.validUntil', { date: nearDate(c.expires_at, serverTime, lang) })
          )}
        </p>
        <p className="text-[13px] leading-6 text-text-secondary">
          <CouponScope c={c} onMore={() => onUse(c)} />
        </p>
        <p className="text-[12px] leading-5 text-text-muted">
          {!ship && c.max_quantity ? `${t('coupon.pieces', { pieces: count('pieces', c.max_quantity) })} · ` : ''}
          {t('coupon.ruleStack')} · {t(ship ? 'coupon.ruleShip' : 'coupon.ruleNoOffer')}
        </p>
      </div>

      <CodeCopy code={c.code} />

      {canUse &&
        (focal ? (
          <Button variant="primary" block onClick={() => onUse(c)}>
            {t('coupon.use')}
          </Button>
        ) : (
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => onUse(c)}>
              {t('coupon.useShort')}
            </Button>
          </div>
        ))}

      <p className="text-[11.5px] leading-5 text-text-muted">{source}</p>
    </li>
  );
}

/**
 * What a coupon covers. Free delivery: its amount and the order it needs. Filament:
 * the cap, then up to two of the coupon's OWN products (links to their pages)
 * and «ومنتجان آخران» opening the rest in the targets sheet; or its section;
 * or — nothing it covers is on sale now — that sentence. An older server
 * sends no targets: «على الفلامنت المختار», and the cart takes the code.
 */
function CouponScope({ c, onMore }: { c: RewardCoupon; onMore: () => void }) {
  const { t, count, tri, lang } = useRewardsT();
  const { money } = useMoney();
  const shipDetail = useShipDetail();
  if (c.kind === 'free_shipping') return <>{shipDetail(c)}</>;

  const cap = c.max_discount_iqd;
  const capped = cap != null && cap > 0;
  const targets = c.targets;
  if (targets === undefined) return <>{capped ? t('coupon.capSelected', { money: money(cap) }) : t('coupon.selected')}</>;

  const lead = capped ? t('coupon.capOn', { money: money(cap) }) : t('coupon.on');
  if (!targets || couponDestination(c).kind === 'none') {
    return (
      <>
        {lead} {t('coupon.noTargets')}
      </>
    );
  }

  const named = (targets.products ?? []).slice(0, NAMES_SHOWN);
  if (named.length > 0) {
    const rest = Math.max(0, (targets.products_total ?? named.length) - named.length);
    return (
      <>
        {lead}{' '}
        {named.map((p, i) => (
          <React.Fragment key={p.id}>
            {i > 0 && SEP[lang]}
            {p.slug ? (
              <Link to={`/product/${encodeURIComponent(p.slug)}`} dir="auto" className={INLINE_LINK}>
                {tri(p.name)}
              </Link>
            ) : (
              <span dir="auto">{tri(p.name)}</span>
            )}
          </React.Fragment>
        ))}
        {rest > 0 && (
          <>
            {' '}
            <button type="button" aria-haspopup="dialog" onClick={onMore} className={INLINE_LINK}>
              {count('moreProducts', rest)}
            </button>
          </>
        )}
      </>
    );
  }

  if (targets.section) {
    return (
      <>
        {lead}{' '}
        <Link to={targets.section.path} dir="auto" className={INLINE_LINK}>
          {tri(targets.section.name)}
        </Link>
      </>
    );
  }
  return (
    <>
      {lead} {t('coupon.noTargets')}
    </>
  );
}

// ------------------------------------------------------------ the code

/**
 * The coupon's code in a well, and its copy button: a 44 px IconButton. The
 * status line beside it is polite: «نُسخ الكود» with a tick for two seconds,
 * or — the clipboard refused — «تعذّر النسخ — الكود ظاهر لتكتبه بنفسك», with
 * no tick, until the next press. A long status wraps under the code instead of
 * squeezing it.
 */
export function CodeCopy({ code }: { code: string }) {
  const { t } = useRewardsT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const ok = await copyToClipboard(code);
    setState(ok ? 'copied' : 'failed');
    if (ok) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setState('idle');
      }, COPIED_MS);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <code dir="ltr" className="lv-well min-w-0 flex-1 basis-36 truncate select-all rounded-md px-3 py-2 text-[14px] font-bold tabular-nums text-text-primary">
        {code}
      </code>
      <IconButton
        variant="secondary"
        label={t('coupon.copy')}
        icon={state === 'copied' ? <Check className="w-4 h-4 text-success" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
        // Not returned: the copy is instant, and a returned promise would flash the busy spinner.
        onClick={() => {
          void copy();
        }}
      />
      <span role="status" aria-live="polite" className={state === 'idle' ? 'sr-only' : 'text-[12px] leading-5 text-text-muted'}>
        {state === 'copied' ? t('coupon.copied') : state === 'failed' ? t('coupon.copyFailed') : ''}
      </span>
    </div>
  );
}

// ------------------------------------------------------------ no active coupon

/**
 * «لا كوبونات صالحة الآن»: what every delivered printer earns (from the
 * programme the server sends, only while it runs) and how long a coupon
 * lasts; the points shop when it sells anything.
 */
function CouponsEmpty({ data }: { data: RewardsHubData }) {
  const { t, count, lang } = useRewardsT();
  const { money } = useMoney();
  const p = data.program;
  let what = '';
  if (p?.enabled) {
    const ship = !!p.free_shipping?.enabled;
    const filament = !!p.filament?.enabled;
    const percent = formatPercent(p.filament?.percent ?? 0, lang, 0);
    const amount = p.free_shipping?.amount_iqd;
    const min = p.free_shipping?.min_order_iqd ?? 0;
    const terms = amount ? { amount: money(amount), min: money(min), pieces: count('pieces', p.filament?.max_pieces ?? 1) } : null;
    what =
      ship && filament
        ? terms
          ? t(min > 0 ? 'coupons.what.bothTerms' : 'coupons.what.bothAmount', { percent, ...terms })
          : t('coupons.what.both', { percent })
        : ship
          ? terms
            ? t(min > 0 ? 'coupons.what.shipTerms' : 'coupons.what.shipAmount', terms)
            : t('coupons.what.ship')
          : filament
            ? t('coupons.what.filament', { percent })
            : '';
    const cap = p.filament?.max_discount_iqd;
    if (what && filament && cap != null && cap > 0) what = `${what} ${t('coupons.what.cap', { money: money(cap) })}`;
  }
  return (
    <EmptyState
      icon={<Ticket className="w-6 h-6" aria-hidden="true" />}
      title={t('coupons.empty.title')}
      description={
        what
          ? p.weekly?.enabled
            ? t('coupons.empty.bodyWeekly', { what, months: count('months', p.weekly.months), days: count('days', p.valid_days) })
            : t('coupons.empty.body', { what, days: count('days', p.valid_days) })
          : undefined
      }
      action={
        (data.shop ?? []).length > 0 ? (
          <Link to="/rewards/shop" className="lv-button lv-button-secondary mt-1">
            {t('coupons.empty.shop')}
          </Link>
        ) : undefined
      }
    />
  );
}

// ------------------------------------------------------------ a past coupon

/** A compact row: what it was, and what became of it — used (with its order), expired, or withdrawn and why. */
function PastRow({ c }: { c: RewardCoupon }) {
  const { t, lang } = useRewardsT();
  const title = useCouponTitle();
  const ship = c.kind === 'free_shipping';
  let chip: CopyKey;
  let line: React.ReactNode = null;
  if (c.state === 'used') {
    chip = 'chip.used';
    line = (
      <>
        {t('past.usedOn')}
        {c.used_on_order_id && (
          <>
            {' · '}
            <Link to={`/orders/${encodeURIComponent(c.used_on_order_id)}`} className={`${INLINE_LINK} inline-flex items-center gap-0.5`}>
              {t('past.viewOrder')}
              <ForwardChevron />
            </Link>
          </>
        )}
      </>
    );
  } else if (c.state === 'expired') {
    chip = 'chip.expired';
    line = t('past.expiredOn', { date: formatDate(c.expires_at, lang) });
  } else {
    chip = 'chip.withdrawn';
    // A reason the past list has no words for reads as the chip alone, not «سُحب» twice.
    const why = revokeKey(c.revoke_reason);
    line = why === 'chip.withdrawn' ? null : t(why);
  }
  return (
    <li className="flex items-start gap-3 p-3" data-testid="reward-coupon-past">
      <span aria-hidden="true" className="size-8 shrink-0 rounded-full lv-well grid place-items-center text-text-muted">
        {ship ? <Truck className="w-4 h-4" /> : <Percent className="w-4 h-4" />}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <p className="min-w-0 text-[14px] font-bold leading-5 text-text-primary">{title(c)}</p>
          <StatusChip tone="neutral">{t(chip)}</StatusChip>
        </div>
        {line && <p className="text-[12px] leading-5 text-text-muted">{line}</p>}
      </div>
    </li>
  );
}
