/**
 * /games — the games hub. Open to guests.
 *
 * One real game: the Printer Farm. A signed-in player sees their own farm's
 * name, level, coins and stars straight from GET /api/farm/state (the same
 * call that boots the game); a guest sees an honest sign-in panel that brings
 * them back here. Below it, the way into the leaderboards, the farm profile
 * and the conversion rules. Nothing on this page is a placeholder.
 *
 * WHILE THE GAME IS SHELVED — «قريبا — تحت التطوير» — this page is the one
 * place that still shows it. The owner asked for the farm to be marked
 * coming-soon, not removed: a card that vanished would read as "cancelled",
 * a card that says قريبا reads as "this is coming". So the farm keeps its
 * place at the top, wearing the notice, with no way in; the three rows below
 * it stay listed for the same reason and stop being links.
 *
 * The notice is not a client decision. GET /api/farm/status carries the
 * server's switch, so the owner lifts the shelving with one settings write and
 * this page goes back to the live farm with no deploy. An admin is let through
 * by the same call and sees the working game with a note saying who it is
 * closed to.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Coins, Printer, Trophy, UserRound, Wrench } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { ErrorState, UnauthorizedState } from '../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import { farmApi, type FarmState } from '../lib/farmApi';
import { FARM_STRINGS } from './farm/strings';
import { GamesBody, GamesHeader, GamesPage } from './farm/PageChrome';
import { CoinsChip, Stars } from './farm/bits';
import { useFarmAccess } from './farm/shelved';
import { BTN_PRIMARY, CHIP, FOCUS, PANEL } from './farm/ui';

export default function Games() {
  const { lang, dir } = useLanguage();
  const s = FARM_STRINGS[lang];
  const navigate = useNavigate();
  const { isAuthenticated, isLoaded } = useAuth();
  const { access, error: accessError, reload: reloadAccess } = useFarmAccess();
  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  const [farm, setFarm] = useState<FarmState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  // The server's two answers, kept apart: `shelved` is what the CARD says,
  // `mayPlay` is what this viewer may do about it. They differ for an admin.
  const shelved = access?.shelved === true;
  const mayPlay = access?.may_play === true;

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
    if (!isLoaded || !access) return;
    // Nothing is asked of a shelved game: /api/farm/state would refuse this
    // viewer, and an error box is not what «قريبا» should look like.
    if (isAuthenticated && access.may_play) void load();
    else {
      setFarm(null);
      setError(null);
    }
  }, [isLoaded, isAuthenticated, access, load]);

  const links = [
    { to: '/leaderboards', icon: Trophy, title: s.hubLeaderboards, desc: s.hubLeaderboardsDesc, id: 'leaderboards' },
    { to: '/games/profile', icon: UserRound, title: s.hubProfile, desc: s.hubProfileDesc, id: 'profile' },
    { to: '/games/redeem', icon: Coins, title: s.hubRedeem, desc: s.hubRedeemDesc, id: 'redeem' },
  ];

  /** The card's lower half: the notice, the sign-in panel, or the live farm. */
  let card: React.ReactNode;
  if (accessError !== null) {
    // We could not ask whether the game is open. Say so and offer the retry —
    // never dress an unanswered question up as «قريبا».
    card = <ErrorState compact error={accessError} onRetry={reloadAccess} next="/games" />;
  } else if (!isLoaded || !access) {
    card = (
      <SkeletonGroup>
        <Skeleton className="h-16 w-full rounded-xl" />
      </SkeletonGroup>
    );
  } else if (!mayPlay) {
    card = (
      <div className="space-y-2" data-hub-farm-shelved>
        <p className="text-white font-bold text-[15px]">{s.shelved.title}</p>
        <p className="text-[13px] text-zinc-400 leading-relaxed">{s.shelved.body}</p>
      </div>
    );
  } else if (!isAuthenticated) {
    card = <UnauthorizedState compact title={s.hubGuestTitle} description={s.hubGuestDesc} next="/games/printer-farm" />;
  } else if (error) {
    card = <ErrorState compact error={error} onRetry={() => void load()} next="/games" />;
  } else if (!farm || loading) {
    card = (
      <SkeletonGroup className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-32 rounded-full" />
        <Skeleton className="h-11 w-full rounded-xl" />
      </SkeletonGroup>
    );
  } else {
    card = (
      <div className="space-y-4" data-hub-farm-summary>
        {/* An admin is inside a game the players cannot open: say so plainly,
            and say where the switch that closed it lives. */}
        {shelved && (
          <p className="text-[12px] text-honey leading-relaxed" data-hub-farm-admin-note>
            {s.shelved.adminBody}
          </p>
        )}
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
    );
  }

  return (
    <GamesPage dir={dir} testId="games-hub">
      <GamesHeader title={s.hubTitle} backLabel={s.back} fallback="/profile" />
      <GamesBody>
        {/* ------------------------------------------------- the farm card */}
        <section className={`${PANEL} overflow-hidden`} aria-labelledby="hub-farm-title" data-hub-farm data-hub-shelved={shelved || undefined}>
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
            <div className="flex items-start justify-between gap-3">
              <h2 id="hub-farm-title" className="flex items-center gap-2 text-white font-black text-[22px] leading-7 min-w-0">
                <Printer aria-hidden="true" className="w-6 h-6 text-gold shrink-0" />
                {s.title}
              </h2>
              {/* The owner's word, on the card that keeps the game's place. An
                  admin's copy names who the door is shut to instead. */}
              {shelved && (
                <span className={`${CHIP} border-honey/40 text-honey bg-honey/10 shrink-0`} data-hub-shelved-badge>
                  <Wrench aria-hidden="true" className="w-3 h-3" />
                  {mayPlay ? s.shelved.adminBadge : s.shelved.badge}
                </span>
              )}
            </div>
            <p className="text-[13px] text-zinc-400 leading-relaxed">{s.hubDesc}</p>
          </div>

          <div className="border-t border-zinc-800/70 p-5">{card}</div>
        </section>

        {/* -------------------------------------------------------- links */}
        <nav aria-label={s.hubTitle} className="space-y-2">
          {links.map((l) =>
            mayPlay ? (
              <Link
                key={l.id}
                to={l.to}
                data-hub-link={l.id}
                className={`${PANEL} flex items-center gap-3 px-4 py-3 min-h-[56px] hover:border-zinc-700 transition-colors press-scale ${FOCUS}`}
              >
                <span className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-gold shrink-0">
                  <l.icon aria-hidden="true" className="w-4.5 h-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-white font-bold text-[14px] truncate">{l.title}</span>
                  <span className="block text-[11.5px] text-zinc-500 truncate">{l.desc}</span>
                </span>
                <Chevron aria-hidden="true" className="w-4 h-4 text-zinc-600 shrink-0" />
              </Link>
            ) : (
              // Still listed, and no longer a control: the three rows belong to
              // the shelved game, so they say when they come back rather than
              // leading to a page that would refuse them. Nothing to focus,
              // nothing to click, nothing to disable.
              <div
                key={l.id}
                data-hub-link={l.id}
                data-hub-link-shelved={shelved ? '1' : undefined}
                data-hub-link-unknown={shelved ? undefined : '1'}
                className={`${PANEL} flex items-center gap-3 px-4 py-3 min-h-[56px] opacity-60`}
              >
                <span className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 shrink-0">
                  <l.icon aria-hidden="true" className="w-4.5 h-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-zinc-300 font-bold text-[14px] truncate">{l.title}</span>
                  {/* THE SAME THREE-WAY SPLIT THE CARD ABOVE MAKES.
                      «يفتح مع اللعبة» asserts the game is shut. That is only
                      true when the server SAID so. While the status is
                      unread — in flight, or permanently after a failed
                      request — the row said it anyway, so a customer with a
                      LIVE game and one dropped request was told three times
                      that it had not opened, directly beneath a card offering
                      to retry the question. It also reads as a broken promise
                      to an admin who knows the game is open. */}
                  <span className="block text-[11.5px] text-zinc-500 truncate">
                    {shelved ? s.shelved.linkNote : s.shelved.linkUnknown}
                  </span>
                </span>
              </div>
            )
          )}
        </nav>
      </GamesBody>
    </GamesPage>
  );
}
