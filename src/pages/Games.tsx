/**
 * /games — the games hub. Open to guests.
 *
 * One real game: the Printer Farm. A signed-in player sees their own farm's
 * name, level, coins and stars straight from GET /api/farm/state (the same
 * call that boots the game); a guest sees an honest sign-in panel that brings
 * them back here. Below it, the way into the leaderboards, the farm profile
 * and the conversion rules. Nothing on this page is a placeholder.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Coins, Printer, Trophy, UserRound } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { ErrorState, UnauthorizedState } from '../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import { farmApi, type FarmState } from '../lib/farmApi';
import { FARM_STRINGS } from './farm/strings';
import { GamesBody, GamesHeader, GamesPage } from './farm/PageChrome';
import { CoinsChip, Stars } from './farm/bits';
import { BTN_PRIMARY, FOCUS, PANEL } from './farm/ui';

export default function Games() {
  const { lang, dir } = useLanguage();
  const s = FARM_STRINGS[lang];
  const navigate = useNavigate();
  const { isAuthenticated, isLoaded } = useAuth();
  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  const [farm, setFarm] = useState<FarmState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFarm(await farmApi.state());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (isAuthenticated) void load();
    else {
      setFarm(null);
      setError(null);
    }
  }, [isLoaded, isAuthenticated, load]);

  const links = [
    { to: '/leaderboards', icon: Trophy, title: s.hubLeaderboards, desc: s.hubLeaderboardsDesc, id: 'leaderboards' },
    { to: '/games/profile', icon: UserRound, title: s.hubProfile, desc: s.hubProfileDesc, id: 'profile' },
    { to: '/games/redeem', icon: Coins, title: s.hubRedeem, desc: s.hubRedeemDesc, id: 'redeem' },
  ];

  return (
    <GamesPage dir={dir} testId="games-hub">
      <GamesHeader title={s.hubTitle} backLabel={s.back} fallback="/profile" />
      <GamesBody>
        {/* ------------------------------------------------- the farm card */}
        <section className={`${PANEL} overflow-hidden`} aria-labelledby="hub-farm-title" data-hub-farm>
          <div className="p-5 space-y-3">
            {/* The kicker is Latin only in English: `lang`/`dir` (and the
                letter-spacing, which breaks Arabic joining) apply there alone;
                Arabic and Kurdish inherit the page. */}
            <p
              className={`text-[10px] font-semibold text-zinc-500 ${lang === 'en' ? 'uppercase tracking-[0.08em]' : ''}`}
              lang={lang === 'en' ? 'en' : undefined}
              dir={lang === 'en' ? 'ltr' : undefined}
            >
              {s.hubKicker}
            </p>
            <h2 id="hub-farm-title" className="flex items-center gap-2 text-white font-black text-[22px] leading-7">
              <Printer aria-hidden="true" className="w-6 h-6 text-[#BAA369]" />
              {s.title}
            </h2>
            <p className="text-[13px] text-zinc-400 leading-relaxed">{s.hubDesc}</p>
          </div>

          <div className="border-t border-zinc-800/70 p-5">
            {!isLoaded ? (
              <SkeletonGroup>
                <Skeleton className="h-16 w-full rounded-xl" />
              </SkeletonGroup>
            ) : !isAuthenticated ? (
              <UnauthorizedState compact title={s.hubGuestTitle} description={s.hubGuestDesc} next="/games/printer-farm" />
            ) : error ? (
              <ErrorState compact error={error} onRetry={() => void load()} next="/games" />
            ) : !farm || loading ? (
              <SkeletonGroup className="space-y-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-8 w-32 rounded-full" />
                <Skeleton className="h-11 w-full rounded-xl" />
              </SkeletonGroup>
            ) : (
              <div className="space-y-4" data-hub-farm-summary>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] text-zinc-500">{s.hubYourFarm}</p>
                    <p className="text-white font-bold text-[16px] truncate">{farm.profile.farm_name}</p>
                    <div className="flex items-center gap-2 text-[11.5px] text-zinc-400 mt-0.5">
                      <span className="tabular-nums">{s.level(farm.profile.level)}</span>
                      <span aria-hidden="true" className="text-zinc-700">
                        ·
                      </span>
                      <Stars stars={farm.profile.stars} s={s} />
                    </div>
                  </div>
                  <CoinsChip coins={farm.profile.coins} lang={lang} s={s} />
                </div>
                <button type="button" onClick={() => navigate('/games/printer-farm')} className={`${BTN_PRIMARY} w-full`} data-hub-enter>
                  {s.enterFarm}
                  <Forward aria-hidden="true" className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </section>

        {/* -------------------------------------------------------- links */}
        <nav aria-label={s.hubTitle} className="space-y-2">
          {links.map((l) => (
            <Link
              key={l.id}
              to={l.to}
              data-hub-link={l.id}
              className={`${PANEL} flex items-center gap-3 px-4 py-3 min-h-[56px] hover:border-zinc-700 transition-colors press-scale ${FOCUS}`}
            >
              <span className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-[#BAA369] shrink-0">
                <l.icon aria-hidden="true" className="w-4.5 h-4.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-white font-bold text-[14px] truncate">{l.title}</span>
                <span className="block text-[11.5px] text-zinc-500 truncate">{l.desc}</span>
              </span>
              <Chevron aria-hidden="true" className="w-4 h-4 text-zinc-600 shrink-0" />
            </Link>
          ))}
        </nav>
      </GamesBody>
    </GamesPage>
  );
}
