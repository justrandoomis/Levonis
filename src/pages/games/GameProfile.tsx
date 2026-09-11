/**
 * /games/profile — the farm profile: level and XP, reputation, coins, location
 * and the stats the server keeps. A stat the server did not send is shown as
 * "—", never as a zero. Guests get the sign-in panel.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Printer } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { ErrorState, UnauthorizedState } from '../../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import { dailyJobs, farmApi, statValue, type FarmState } from '../../lib/farmApi';
import { FARM_STRINGS } from '../farm/strings';
import { formatCoins, formatInt, nameOf } from '../farm/format';
import { GamesBody, GamesHeader, GamesPage } from '../farm/PageChrome';
import { CoinsChip, ProgressBar, SectionTitle, Stars } from '../farm/bits';
import { BTN_PRIMARY, PANEL, ROW } from '../farm/ui';

export default function GameProfile() {
  const { lang, dir } = useLanguage();
  const s = FARM_STRINGS[lang];
  const navigate = useNavigate();
  const { isAuthenticated, isLoaded } = useAuth();
  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const [farm, setFarm] = useState<FarmState | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setFarm(await farmApi.state());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    if (isLoaded && isAuthenticated) void load();
  }, [isLoaded, isAuthenticated, load]);

  const stat = (v: number | undefined, coins = false) =>
    typeof v === 'number' ? (
      <span dir="ltr">{coins ? formatCoins(v, lang) : formatInt(v, lang)}</span>
    ) : (
      <span aria-label={s.notSent}>{s.notSent}</span>
    );

  let body: React.ReactNode;
  if (!isLoaded) {
    body = (
      <SkeletonGroup className="space-y-4">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </SkeletonGroup>
    );
  } else if (!isAuthenticated) {
    body = <UnauthorizedState next="/games/profile" />;
  } else if (error) {
    body = <ErrorState error={error} onRetry={() => void load()} next="/games/profile" />;
  } else if (!farm) {
    body = (
      <SkeletonGroup className="space-y-4">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </SkeletonGroup>
    );
  } else {
    const p = farm.profile;
    const st = p.stats ?? {};
    const xpFrac = typeof p.xp_next === 'number' && p.xp_next > 0 ? p.xp / p.xp_next : 1;
    const stats: Array<{ key: string; label: string; value: React.ReactNode }> = [
      { key: 'delivered', label: s.profDelivered, value: stat(statValue(st, 'jobs_delivered', 'delivered')) },
      { key: 'late', label: s.profLate, value: stat(statValue(st, 'jobs_late', 'late')) },
      { key: 'cancelled', label: s.profCancelled, value: stat(statValue(st, 'jobs_cancelled', 'cancelled')) },
      { key: 'prints', label: s.profPrints, value: stat(statValue(st, 'prints')) },
      { key: 'failures', label: s.profFailures, value: stat(statValue(st, 'failures')) },
      { key: 'streak', label: s.profStreak, value: stat(statValue(st, 'streak')) },
      { key: 'lifetime', label: s.profLifetime, value: stat(statValue(st, 'lifetime_coins'), true) },
    ];
    const xpLabel = typeof p.xp_next === 'number' ? s.xpProgress(p.xp, p.xp_next) : `${formatInt(p.xp, lang)} XP`;
    const today = dailyJobs(farm.limits);
    body = (
      <>
        <section className={`${PANEL} p-5 space-y-4`} data-profile-head>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-white font-black text-[20px] leading-6 truncate">{p.farm_name}</h2>
              <p className="text-[12px] text-zinc-400 mt-1">
                <span className="tabular-nums">{s.level(p.level)}</span>
                <span aria-hidden="true" className="text-zinc-700">
                  {' · '}
                </span>
                <span className="text-zinc-300">{nameOf(p.location.name, lang, p.location.key.replace(/_/g, ' '))}</span>
              </p>
            </div>
            <CoinsChip coins={p.coins} lang={lang} s={s} />
          </div>
          <div className="space-y-1">
            <div className="flex items-baseline justify-between text-[11px]">
              <span className="text-zinc-500 tabular-nums">{xpLabel}</span>
              <Stars stars={p.stars} s={s} />
            </div>
            <ProgressBar fraction={xpFrac} label={xpLabel} />
          </div>
          {/* The daily cap the server enforces, in its own numbers; absent when it sent none. */}
          {today && (
            <p className="text-[11px] text-zinc-500 tabular-nums" data-profile-today>
              {s.todayJobs(today.jobs, today.cap)}
            </p>
          )}
          <dl className="grid grid-cols-2 gap-3 text-[12px]">
            <div className={`${ROW} px-3 py-2`}>
              <dt className="text-zinc-500">{s.printersOwned}</dt>
              <dd className="text-white font-bold tabular-nums" dir="ltr">
                {farm.printers.length} / {p.location.max_printers}
              </dd>
            </div>
            <div className={`${ROW} px-3 py-2`}>
              <dt className="text-zinc-500">{s.spools}</dt>
              <dd className="text-white font-bold tabular-nums" dir="ltr">
                {farm.spools.length}
              </dd>
            </div>
          </dl>
          <button type="button" onClick={() => navigate('/games/printer-farm')} className={`${BTN_PRIMARY} w-full`}>
            <Printer aria-hidden="true" className="w-4 h-4" />
            {s.enterFarm}
            <Forward aria-hidden="true" className="w-4 h-4" />
          </button>
        </section>

        <section className="space-y-3" aria-labelledby="profile-stats-title">
          <SectionTitle id="profile-stats-title" title={s.profStats} />
          <dl className={`${PANEL} divide-y divide-zinc-800/70`}>
            {stats.map((row) => (
              <div key={row.key} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[13px]" data-profile-stat={row.key}>
                <dt className="text-zinc-400">{row.label}</dt>
                <dd className="text-white font-bold tabular-nums">{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </>
    );
  }

  return (
    <GamesPage dir={dir} testId="game-profile">
      <GamesHeader title={s.profTitle} backLabel={s.back} fallback="/games" />
      <GamesBody>{body}</GamesBody>
    </GamesPage>
  );
}
