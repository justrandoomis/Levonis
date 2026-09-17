import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft, Bell, PlayCircle, Paperclip, Check, Star, ShoppingBag, ShieldAlert, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { useSignInPrompt } from '../lib/guest';
import { api } from '../lib/api';
import { MotionCharacterHome } from '../components/bloub/MotionCharacterAnchor';
import { Overlay } from '../components/ui/Overlay';

/**
 * THE POINTS & MISSIONS PAGE.
 *
 * TWO RULES GOVERN THIS FILE.
 *
 * 1. IT DISPLAYS. IT NEVER DECIDES. Every amount on this screen arrives from
 *    GET /api/rewards already computed by the server, base and credited. The
 *    old page multiplied the check-in ladder by two for anybody it considered
 *    "PRO" — which was wrong for a PREMIUM member (who earns 1.5×), wrong
 *    wherever 1.5× rounds, and wrong the moment a subscription lapsed. There is
 *    now no arithmetic here at all.
 *
 * 2. IT TELLS THE TRUTH ABOUT WHY A NUMBER IS WHAT IT IS. A PRO member who
 *    earns 10 points for a 5-point check-in is shown «5 × 2» next to it, not
 *    just a larger figure. A task the server cannot verify is labelled as
 *    such instead of being presented as proven. The history comes from the
 *    award rows — each carrying the Baghdad day it credited, the base, and the
 *    multiplier — rather than from the wallet's free-text notes dated by a UTC
 *    clock that disagrees with the day the award belongs to.
 *
 * Arabic is the source language and every string is written ar-first. Sorani
 * (ckb) is deliberately NOT passed to `loc`: the third argument is omitted, so
 * `loc` falls back to the Arabic — the shop owner writes the Kurdish by hand,
 * and no machine invents it here.
 */

interface MissionView {
  base_points: number;
  points: number;
  claimed: boolean;
  available: boolean;
  verification: 'server_timed' | 'client_asserted';
  proof: string;
}
interface VideoView extends MissionView {
  videoUrl: string | null;
  required_seconds: number;
  seconds_remaining: number | null;
  started: boolean;
}
interface BrowseView extends MissionView {
  required_seconds: number;
  progress_seconds: number;
  seconds_remaining: number | null;
}
interface LadderDay {
  day: number;
  base_points: number;
  points: number;
  status: 'checked' | 'today' | 'upcoming';
}
interface HistoryRow {
  mission: string;
  day: string;
  points: number;
  base_points: number | null;
  multiplier_x100: number;
  tier_at_award: string;
  streak_day: number | null;
  awarded_at: string | null;
  direction: 'earn' | 'spend';
  note: string;
}
interface RewardsData {
  today: string;
  server_time: string;
  streak: number;
  checked_in_today: boolean;
  point_balance: number;
  checkin: {
    next_day: number;
    base_points: number;
    points: number;
    verification: 'server_timed' | 'client_asserted';
    proof: string;
    ladder: LadderDay[];
  };
  missions: { push: MissionView; video: VideoView; browse: BrowseView };
  multiplier: {
    x100: number;
    label: string;
    tier: 'free' | 'plus' | 'prime' | 'pro';
    active: boolean;
    expires_at: string | null;
    applies_to: string[];
  };
  history: HistoryRow[];
  is_pro: boolean;
}

interface AwardReply {
  points: number;
  base_points: number;
  multiplier_x100: number;
  day?: number;
  streak?: number;
}

export default function Rewards() {
  const navigate = useNavigate();
  const { pointBalance, refreshWallet } = useWallet();
  const { isAuthenticated, isLoaded: authLoaded } = useAuth();
  const { loc, dir } = useLanguage();
  const { signIn } = useSignInPrompt();

  const [data, setData] = useState<RewardsData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [loadingMission, setLoadingMission] = useState<string | null>(null);
  const [showVideoModal, setShowVideoModal] = useState(false);
  const [isVideoFinished, setIsVideoFinished] = useState(false);
  /** Counted down from the server's own answer; the server still decides. */
  const [adWait, setAdWait] = useState(0);

  const videoTriggerRef = useRef<HTMLButtonElement>(null);

  const loadRewards = useCallback(async () => {
    try {
      const res = await api.get<RewardsData>('/api/rewards');
      setData(res);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : loc('تعذّر تحميل صفحة النقاط', 'Failed to load rewards'));
    }
  }, [loc]);

  useEffect(() => {
    if (!authLoaded || !isAuthenticated) return;
    loadRewards();
  }, [authLoaded, isAuthenticated, loadRewards]);

  // The ad countdown. It is a courtesy, not a gate: the server refuses an
  // early claim on its own `started_at` whatever this number says.
  useEffect(() => {
    if (adWait <= 0) return;
    const id = setInterval(() => setAdWait((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [adWait]);

  const multiplier = data?.multiplier;
  const boosted = (multiplier?.x100 ?? 100) > 100;

  /** «+10 نقطة» and, when a subscription is paying more, «5 × 2» beside it. */
  const breakdown = (base: number, total: number) =>
    boosted && total !== base ? `${base} × ${multiplier?.label.replace('x', '')}` : '';

  const say = (tone: 'good' | 'bad', text: string) => setNotice({ tone, text });

  const awardMessage = (r: AwardReply, what: string) => {
    const gain = `+${r.points} ${loc('نقطة', 'pts')}`;
    return r.multiplier_x100 > 100
      ? `${what} · ${gain} (${r.base_points} × ${(r.multiplier_x100 / 100).toString()})`
      : `${what} · ${gain}`;
  };

  const failureText = (err: unknown) =>
    err instanceof Error && err.message ? err.message : loc('تعذّر إتمام العملية', 'That did not go through');

  const handleCheckIn = async () => {
    if (!data || data.checked_in_today || isCheckingIn) return;
    setIsCheckingIn(true);
    setNotice(null);
    try {
      const res = await api.post<AwardReply>('/api/rewards/checkin');
      say('good', awardMessage(res, loc(`تسجيل اليوم ${res.day ?? ''}`, `Day ${res.day ?? ''} check-in`)));
      await Promise.all([loadRewards(), refreshWallet()]);
    } catch (err) {
      say('bad', failureText(err));
      await loadRewards();
    } finally {
      setIsCheckingIn(false);
    }
  };

  const handlePushMission = async () => {
    if (loadingMission || !data || data.missions.push.claimed) return;
    setLoadingMission('push');
    setNotice(null);
    try {
      if (!('Notification' in window)) {
        say('bad', loc('هذا المتصفح لا يدعم الإشعارات.', 'This browser does not support notifications.'));
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        say('bad', loc('يجب السماح بالإشعارات للحصول على هذه المكافأة.', 'Allow notifications to earn this reward.'));
        return;
      }
      const res = await api.post<AwardReply>('/api/rewards/push');
      say('good', awardMessage(res, loc('تم تفعيل الإشعارات', 'Notifications enabled')));
      await Promise.all([loadRewards(), refreshWallet()]);
    } catch (err) {
      say('bad', failureText(err));
      await loadRewards();
    } finally {
      setLoadingMission(null);
    }
  };

  /**
   * Opening the ad asks the SERVER to start the clock. There is no claim
   * without that ticket, so the window cannot be opened, skipped and claimed
   * in the same second the way it once could.
   */
  const handleVideoMission = async () => {
    if (loadingMission || !data || data.missions.video.claimed) return;
    if (!data.missions.video.available || !data.missions.video.videoUrl) {
      say('bad', loc('لا يوجد إعلان متاح اليوم.', 'No ad is available today.'));
      return;
    }
    setLoadingMission('video');
    setNotice(null);
    try {
      const res = await api.post<{ required_seconds: number; seconds_remaining: number }>('/api/rewards/video/start');
      setAdWait(res.seconds_remaining);
      setIsVideoFinished(false);
      setShowVideoModal(true);
    } catch (err) {
      say('bad', failureText(err));
      await loadRewards();
    } finally {
      setLoadingMission(null);
    }
  };

  const handleVideoClaim = async () => {
    setLoadingMission('video_claim');
    try {
      const res = await api.post<AwardReply>('/api/rewards/video');
      say('good', awardMessage(res, loc('شاهدت الإعلان', 'Ad watched')));
      setShowVideoModal(false);
      await Promise.all([loadRewards(), refreshWallet()]);
    } catch (err) {
      // The server's refusal is the truth — including "not finished yet".
      say('bad', failureText(err));
      await loadRewards();
    } finally {
      setLoadingMission(null);
    }
  };

  const handleBrowseMission = async () => {
    if (loadingMission || !data || data.missions.browse.claimed) return;
    setLoadingMission('browse');
    setNotice(null);
    try {
      await api.post('/api/rewards/browse/start');
      window.dispatchEvent(new Event('levo_mission_start'));
      const mins = Math.round(data.missions.browse.required_seconds / 60);
      say(
        'good',
        loc(
          `بدأت المهمة — تصفّح المنتجات ${mins} دقائق. الوقت يُحسب على خادم المتجر ويتوقف عند الخمول.`,
          `Mission started — browse for ${mins} minutes. The time is counted by the store's server and pauses when you are idle.`
        )
      );
      navigate('/');
    } catch (err) {
      say('bad', failureText(err));
      await loadRewards();
    } finally {
      setLoadingMission(null);
    }
  };

  const missions = data?.missions;
  const ladder = data?.checkin.ladder ?? [];
  const allDailyDone = !!missions && missions.push.claimed && missions.video.claimed && missions.browse.claimed;

  const missionLabel: Record<string, string> = {
    checkin: loc('تسجيل الدخول اليومي', 'Daily check-in'),
    push: loc('تفعيل الإشعارات', 'Notifications enabled'),
    video: loc('مشاهدة إعلان', 'Watched an ad'),
    browse: loc('تصفّح المنتجات', 'Browsed products'),
  };

  /**
   * When a history line happened. A dated mission shows its Baghdad day, which
   * is the period it was earned for; everything else shows the instant the
   * server recorded. `day` is never rendered on its own, because for the
   * one-time push mission it is the word 'once'.
   */
  const historyWhen = (h: HistoryRow): string => {
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(h.day);
    if (dated) return h.day;
    if (!h.awarded_at) return '';
    const d = new Date(h.awarded_at);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString(loc('ar-IQ', 'en-GB'), { year: 'numeric', month: 'short', day: 'numeric' });
  };

  /** Says plainly that the store cannot verify a task, instead of implying it can. */
  const UnverifiedTag = ({ proof }: { proof: string }) => (
    <span
      title={proof}
      className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-300/90 bg-amber-400/10 rounded-full px-2 py-0.5"
    >
      <ShieldAlert aria-hidden="true" className="w-3 h-3" />
      {loc('غير مُتحقَّق منه', 'Not verifiable')}
    </span>
  );

  return (
    <div data-testid="rewards-root" dir={dir} className="w-full bg-black min-h-screen font-sans flex flex-col text-white pb-24 overflow-y-auto relative">
      <div
        aria-hidden="true"
        className="absolute top-0 left-0 w-full h-[800px] pointer-events-none"
        style={{ background: 'linear-gradient(to bottom, #141416 0%, #0d0d0f 45%, #000000 100%)' }}
      ></div>
      <div
        aria-hidden="true"
        className="absolute top-0 left-0 w-full h-96 opacity-[0.07] pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(#ffffff 1.5px, transparent 1.5px)',
          backgroundSize: '16px 16px',
          maskImage: 'linear-gradient(to bottom, black, transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)',
        }}
      ></div>

      {/* Header */}
      <div className="flex items-center px-4 py-4 sticky top-0 z-10 relative">
        <button
          onClick={() => navigate(-1)}
          aria-label={loc('رجوع', 'Back')}
          className="w-11 h-11 -ms-2 flex items-center justify-center rounded-full hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold transition-colors"
        >
          <ChevronLeft aria-hidden="true" className="w-6 h-6 text-gold rtl:rotate-180" strokeWidth={2.5} />
        </button>
        <h1 className="text-[17px] font-bold text-center flex-1">{loc('النقاط والمهام', 'Points & Missions')}</h1>
        {/* Registers this page's own character anchor, so the shell stops
            reserving a separate landing strip above this header. */}
        <MotionCharacterHome kind="top-header" compact />
        {/* The tier badge is the server's answer, never a local guess. */}
        {multiplier && multiplier.active ? (
          <span className="p-1 px-3 text-[12px] font-bold rounded-full bg-gold text-black uppercase">
            {multiplier.tier === 'prime' ? 'PREMIUM' : multiplier.tier}
          </span>
        ) : (
          <span className="w-[52px]"></span>
        )}
      </div>

      <div className="px-5 relative z-10 mt-2">
        {authLoaded && !isAuthenticated ? (
          <div className="text-center py-20">
            <Star aria-hidden="true" className="w-10 h-10 mx-auto mb-3 text-gold/70" />
            <p className="text-zinc-300 font-medium mb-4">
              {loc('سجّل الدخول لجمع النقاط ومتابعتها', 'Sign in to earn and track your points')}
            </p>
            <button onClick={signIn} className="px-6 py-2.5 bg-gold text-black rounded-full font-bold text-sm">
              {loc('تسجيل الدخول', 'Sign in')}
            </button>
          </div>
        ) : (
          <>
            {loadError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-2xl p-3 text-center mb-4">
                {loadError}
              </div>
            )}
            {notice && (
              <div
                role="status"
                aria-live="polite"
                className={`text-[13px] font-medium rounded-2xl p-3 text-center mb-4 border ${
                  notice.tone === 'good'
                    ? 'bg-gold/10 border-gold/30 text-gold'
                    : 'bg-red-500/10 border-red-500/30 text-red-400'
                }`}
              >
                {notice.text}
              </div>
            )}

            {/* Balance */}
            <div className="flex justify-between items-center mb-6 relative">
              <div className="pt-2">
                <div className="text-[14px] text-gold mb-0.5 font-medium">{loc('رصيدي', 'My Balance')}</div>
                <div aria-live="polite" className="text-[56px] leading-[1.1] font-black tracking-tight tabular-nums">
                  {(data?.point_balance ?? pointBalance).toLocaleString()}
                </div>
              </div>
              <div className="relative right-2">
                <div className="w-24 h-24 rounded-full relative z-10 transform -rotate-12">
                  <div className="absolute inset-0 rounded-full bg-[#6b5f3c] transform translate-x-[3px] translate-y-[4px]"></div>
                  <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-[#BAA369] to-[#ffe55c] border-[4px] border-[#ffe55c] flex items-center justify-center shadow-[inset_-3px_-3px_12px_rgba(0,0,0,0.15)]">
                    <div className="text-black drop-shadow-[1px_2px_2px_rgba(0,0,0,0.25)] relative top-[-1px]">
                      <svg viewBox="0 0 24 24" fill="white" className="w-[44px] h-[44px] transform rotate-12">
                        <path d="M12 0C12 6.627 17.373 12 24 12C17.373 12 12 17.373 12 24C12 17.373 6.627 12 0 12C6.627 12 12 6.627 12 0Z" />
                      </svg>
                    </div>
                  </div>
                </div>
                <div className="absolute inset-0 w-24 h-24 rounded-full bg-black/20 blur-md transform translate-y-6 -translate-x-0 z-0"></div>
              </div>
            </div>

            {/*
              THE MULTIPLIER, STATED. The owner's brief: a PRO must see that
              they earned double, not just a bigger number with no explanation.
              Both halves are here — the rate, and the list of what it applies
              to — and both come from the server.
            */}
            {multiplier && (
              <div
                data-testid="rewards-multiplier"
                className={`rounded-[20px] p-4 mb-6 border ${
                  boosted ? 'bg-gold/10 border-gold/30' : 'bg-[#18181b] border-white/5'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles aria-hidden="true" className={`w-4 h-4 ${boosted ? 'text-gold' : 'text-zinc-400'}`} />
                  <h3 className={`font-bold text-[14px] ${boosted ? 'text-gold' : 'text-white'}`}>
                    {boosted
                      ? loc(
                          `اشتراكك يمنحك ${multiplier.label.replace('x', '')}× من النقاط`,
                          `Your subscription earns you ${multiplier.label.replace('x', '')}× points`
                        )
                      : loc('نقاطك بالمعدّل الأساسي (1×)', 'You earn at the standard rate (1×)')}
                  </h3>
                </div>
                <p className="text-zinc-300 text-[12px] leading-relaxed">
                  {boosted
                    ? loc(
                        'يُطبَّق على تسجيل الدخول اليومي والمهام والشراء والتقييمات. المُضاعِف يُثبَّت لحظة منح النقاط، فانتهاء الاشتراك لاحقًا لا يغيّر ما رَبِحته.',
                        'Applied to daily check-in, missions, purchases and reviews. The multiplier is frozen at the moment each award is made, so a subscription that later ends never changes what you already earned.'
                      )
                    : loc(
                        'اشتراك بريميوم يمنح 1.5× واشتراك برو يمنح 2× على تسجيل الدخول والمهام والشراء والتقييمات.',
                        'PREMIUM earns 1.5× and PRO earns 2× on check-in, missions, purchases and reviews.'
                      )}
                </p>
                {boosted && multiplier.expires_at && (
                  <p className="text-zinc-400 text-[11px] mt-2">
                    {loc('ينتهي في', 'Ends')} {new Date(multiplier.expires_at).toLocaleDateString()}
                  </p>
                )}
              </div>
            )}

            {/* Check-in card */}
            <div className="relative mb-6 mx-1">
              <div className="absolute inset-0 bg-gradient-to-br from-[#18181b] to-[#27272a] rounded-[28px] transform -rotate-[2deg] translate-y-1 -translate-x-1 shadow-sm"></div>
              <div className="bg-[#111113] rounded-[24px] p-4 shadow-[0_8px_30px_rgba(0,0,0,0.06)] relative z-10">
                <div className="absolute top-5 bottom-5 left-2 flex flex-col justify-between opacity-50">
                  {[...Array(12)].map((_, i) => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-black/50 shadow-inner"></div>
                  ))}
                </div>
                <div className="absolute -top-3 right-3 text-zinc-400 transform rotate-[30deg] z-20 drop-shadow-md">
                  <Paperclip aria-hidden="true" className="w-6 h-6" strokeWidth={1.5} />
                </div>

                <div className="ps-3">
                  <h2 className="text-[16px] font-bold mb-1">
                    {loc(
                      `سجّلت دخولك ${data?.streak ?? 0} ${(data?.streak ?? 0) === 1 ? 'يومًا' : 'أيام'} متتالية`,
                      `You've checked in for ${data?.streak ?? 0} day${(data?.streak ?? 0) === 1 ? '' : 's'}`
                    )}
                  </h2>
                  <p className="text-[11px] text-zinc-400 mb-4">
                    {loc(
                      'اليوم يُحدَّد بتوقيت بغداد على خادم المتجر — لا بتوقيت جهازك.',
                      "The day is the store server's Baghdad date — not your device's."
                    )}
                  </p>

                  <div className="flex justify-between mb-5 overflow-x-auto pb-2 pt-1 -mx-1 px-1 hide-scrollbar items-end gap-1">
                    {ladder.map((d) => (
                      <div
                        key={d.day}
                        className={`flex flex-col items-center flex-shrink-0 relative ${
                          d.status === 'today'
                            ? 'w-[48px] pb-1.5 border border-gold rounded-[14px] shadow-[0_4px_12px_rgba(186,163,105,0.15)] bg-[#27272a] transform -translate-y-1 overflow-hidden animate-day-pop'
                            : d.status === 'checked'
                              ? 'w-[42px] pt-1 pb-1.5 bg-gradient-to-b from-[#18181b] to-[#27272a] rounded-[14px]'
                              : 'w-[42px] pt-1 pb-1.5 bg-[#18181b] rounded-[14px]'
                        }`}
                      >
                        {d.status === 'today' ? (
                          <div className="w-full bg-gold text-black text-[9px] font-bold text-center py-1 mb-1.5 tracking-wide">
                            {loc('اليوم', 'Today')}
                          </div>
                        ) : (
                          <span
                            className={`text-[10px] font-bold tracking-tight mb-1.5 ${
                              d.status === 'checked' ? 'text-gold' : 'text-zinc-400'
                            }`}
                          >
                            {loc(`يوم ${d.day}`, `Day ${d.day}`)}
                          </span>
                        )}

                        <div className="flex items-center justify-center mb-1 h-[24px]">
                          {d.status === 'checked' ? (
                            <div className="w-[20px] h-[20px] bg-gold rounded-full flex items-center justify-center shadow-sm">
                              <Check aria-hidden="true" className="w-3.5 h-3.5 text-black" strokeWidth={4} />
                            </div>
                          ) : (
                            <svg viewBox="0 0 24 24" fill="#BAA369" className="w-[20px] h-[20px]">
                              <circle cx="12" cy="12" r="10" />
                              <path
                                d="M12 6C12 8.5 15.5 11 18 11C15.5 11 12 13.5 12 16C12 13.5 8.5 11 6 11C8.5 11 12 8.5 12 6Z"
                                fill="white"
                              />
                            </svg>
                          )}
                        </div>

                        {/* The server's own figure. Nothing is multiplied here. */}
                        <span
                          className={`text-[11px] font-bold ${
                            d.status === 'today' ? 'text-white' : d.status === 'checked' ? 'text-gold' : 'text-zinc-400'
                          }`}
                        >
                          {d.points}
                        </span>
                        {d.points !== d.base_points && (
                          <span className="text-[8px] text-zinc-500 tabular-nums">{d.base_points}×{multiplier?.label.replace('x', '')}</span>
                        )}
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={handleCheckIn}
                    disabled={!data || data.checked_in_today || isCheckingIn}
                    className={`w-full min-h-[48px] py-3.5 rounded-[20px] font-bold text-[15px] transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold
                ${!data || data.checked_in_today ? 'bg-[#18181b] text-zinc-400' : 'bg-gold text-black'}`}
                  >
                    {isCheckingIn ? (
                      <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin mx-auto" />
                    ) : data?.checked_in_today ? (
                      loc('تم التسجيل اليوم', 'Checked in')
                    ) : (
                      loc(`سجّل الدخول (+${data?.checkin.points ?? 0})`, `Check in (+${data?.checkin.points ?? 0})`)
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Missions */}
            <div className="mt-8 mb-8">
              <h2 className="text-[17px] font-bold mb-4 px-1 text-white">{loc('اجمع النقاط', 'Earn Points')}</h2>
              <div className="space-y-3 px-1">
                {!data && !loadError && (
                  <div className="flex justify-center py-6">
                    <div className="w-6 h-6 border-2 border-gold/20 border-t-gold rounded-full animate-spin" />
                  </div>
                )}
                {allDailyDone && (
                  <div className="text-zinc-400 text-center py-4 text-sm">
                    {loc('أنهيت كل مهام اليوم.', "You're all caught up for today!")}
                  </div>
                )}

                {missions && !missions.push.claimed && (
                  <button
                    type="button"
                    onClick={handlePushMission}
                    disabled={loadingMission === 'push' || !missions.push.available}
                    className="w-full text-start bg-[#18181b] rounded-[20px] p-4 flex items-center justify-between shadow-sm hover:bg-[#27272a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-60 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center shrink-0">
                        {loadingMission === 'push' ? (
                          <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
                        ) : (
                          <Bell aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-white font-bold text-[14px] flex items-center gap-2 flex-wrap">
                          {loc('فعّل الإشعارات', 'Enable Notifications')}
                          {missions.push.verification === 'client_asserted' && <UnverifiedTag proof={missions.push.proof} />}
                        </h4>
                        <span className="text-zinc-400 font-medium text-[12px]">
                          {loc('مرة واحدة لكل حساب', 'Once per account')}
                        </span>
                      </div>
                    </div>
                    <div className="text-gold font-bold text-[16px] text-end shrink-0">
                      +{missions.push.points}
                      {breakdown(missions.push.base_points, missions.push.points) && (
                        <div className="text-[10px] text-zinc-400 font-medium">
                          {breakdown(missions.push.base_points, missions.push.points)}
                        </div>
                      )}
                    </div>
                  </button>
                )}

                {missions && !missions.video.claimed && (
                  <button
                    type="button"
                    ref={videoTriggerRef}
                    onClick={handleVideoMission}
                    disabled={!missions.video.available || loadingMission === 'video'}
                    className={`w-full text-start bg-[#18181b] rounded-[20px] p-4 flex items-center justify-between shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold transition-colors ${
                      missions.video.available ? 'hover:bg-[#27272a]' : 'opacity-60 cursor-not-allowed'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center shrink-0">
                        {loadingMission === 'video' ? (
                          <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
                        ) : (
                          <PlayCircle aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-white font-bold text-[14px] flex items-center gap-2 flex-wrap">
                          {loc('شاهد إعلانًا', 'Watch Ad')}
                          <UnverifiedTag proof={missions.video.proof} />
                        </h4>
                        <span className="text-zinc-400 font-medium text-[12px]">
                          {missions.video.available
                            ? loc(
                                `${missions.video.required_seconds} ثانية على الأقل — يحسبها الخادم`,
                                `${missions.video.required_seconds}s minimum, timed by the server`
                              )
                            : loc('لا يوجد إعلان اليوم', 'No ad today')}
                        </span>
                      </div>
                    </div>
                    <div className="text-gold font-bold text-[16px] text-end shrink-0">
                      +{missions.video.points}
                      {breakdown(missions.video.base_points, missions.video.points) && (
                        <div className="text-[10px] text-zinc-400 font-medium">
                          {breakdown(missions.video.base_points, missions.video.points)}
                        </div>
                      )}
                    </div>
                  </button>
                )}

                {missions && !missions.browse.claimed && (
                  <button
                    type="button"
                    onClick={handleBrowseMission}
                    disabled={loadingMission === 'browse' || !missions.browse.available}
                    className="w-full text-start bg-[#18181b] rounded-[20px] p-4 flex items-center justify-between shadow-sm hover:bg-[#27272a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-60 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center shrink-0">
                        {loadingMission === 'browse' ? (
                          <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
                        ) : (
                          <ShoppingBag aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-white font-bold text-[14px] flex items-center gap-2 flex-wrap">
                          {loc('تصفّح المنتجات', 'Browse Products')}
                          <UnverifiedTag proof={missions.browse.proof} />
                        </h4>
                        <span className="text-zinc-400 font-medium text-[12px]">
                          {loc(
                            `${Math.round(missions.browse.required_seconds / 60)} دقائق`,
                            `${Math.round(missions.browse.required_seconds / 60)} mins`
                          )}
                          {missions.browse.progress_seconds > 0 &&
                            ` • ${missions.browse.progress_seconds}/${missions.browse.required_seconds}s`}
                        </span>
                      </div>
                    </div>
                    <div className="text-gold font-bold text-[16px] text-end shrink-0">
                      +{missions.browse.points}
                      {breakdown(missions.browse.base_points, missions.browse.points) && (
                        <div className="text-[10px] text-zinc-400 font-medium">
                          {breakdown(missions.browse.base_points, missions.browse.points)}
                        </div>
                      )}
                    </div>
                  </button>
                )}
              </div>
            </div>

            {/*
              HISTORY, FROM THE AWARD ROWS.
              Each line carries the Baghdad day it credited and, when a
              subscription paid more, the base and the multiplier that produced
              the figure — so "why was this 8 and that one 5" is answerable on
              the screen instead of only in the database.
            */}
            <div className="mt-8 mb-8">
              <h2 className="text-[17px] font-bold mb-4 px-1 text-white">{loc('سجلّ النقاط', 'Points History')}</h2>
              <div className="space-y-3 px-1">
                {data && data.history.length === 0 && (
                  <div className="text-zinc-400 text-center py-4 text-sm">{loc('لا يوجد نشاط بعد', 'No recent activity')}</div>
                )}
                {data?.history.map((h, i) => {
                  const spend = h.direction === 'spend';
                  return (
                  <div key={`${h.mission}-${h.day}-${h.awarded_at ?? ''}-${i}`} className="bg-[#18181b] rounded-[20px] p-4 flex items-center justify-between shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${spend ? 'bg-rose-400/10' : 'bg-gold/10'}`}>
                        {spend ? (
                          <ShoppingBag aria-hidden="true" className="w-5 h-5 text-rose-300" />
                        ) : (
                          <Star aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-white font-bold text-[14px]">
                          {/* A ledger movement has no mission; it carries its own wording. */}
                          {missionLabel[h.mission] ?? (h.note || h.mission)}
                          {h.streak_day ? ` · ${loc(`يوم ${h.streak_day}`, `day ${h.streak_day}`)}` : ''}
                        </h4>
                        <span className="text-zinc-400 font-medium text-[12px]">
                          {/* THE INSTANT, NOT THE PERIOD. `day` is the mission's
                              accounting period and for the one-time push mission
                              it is the literal string 'once', which is not a date
                              anyone can read. The server already sends the real
                              instant; a mission keeps its Baghdad day beside it. */}
                          {historyWhen(h)}
                          {h.multiplier_x100 > 100 && h.base_points !== null
                            ? ` · ${h.base_points} × ${(h.multiplier_x100 / 100).toString()} ${h.tier_at_award.toUpperCase()}`
                            : ''}
                        </span>
                      </div>
                    </div>
                    <div className={`font-bold text-[16px] shrink-0 ${spend ? 'text-rose-300' : 'text-gold'}`}>
                      {spend ? '−' : '+'}{h.points} {loc('نقطة', 'pts')}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/*
        THE AD WINDOW. It can only be opened after the server has issued the
        ticket, and the Claim button is only offered when the video has played
        through AND the server's own countdown has run out. Even then the
        server re-checks its own `started_at` — this is a courtesy, not the gate.
      */}
      <Overlay
        open={showVideoModal && !!data?.missions.video.videoUrl}
        onClose={() => setShowVideoModal(false)}
        labelledBy="rewards-video-title"
        anchor={videoTriggerRef}
        placement="center"
        z={50}
        dismissOnScrim={false}
        testId="rewards-video"
        panelClassName="w-full max-w-md"
      >
        <div className="p-6 flex flex-col items-center">
          <h3 id="rewards-video-title" className="text-white font-bold text-lg mb-2">
            {loc('شاهد الإعلان لتربح النقاط', 'Watch the ad to earn')}
          </h3>
          <p className="text-zinc-300 text-sm text-center mb-6">
            {loc('شاهد الإعلان كاملًا للحصول على نقاطك.', 'Please watch the entire video to receive your points.')}
          </p>

          <div className="w-full aspect-video bg-black rounded-xl mb-6 relative overflow-hidden flex items-center justify-center border border-white/5">
            <video
              src={data?.missions.video.videoUrl ?? undefined}
              autoPlay
              controls={false}
              playsInline
              className="w-full h-full object-contain"
              onEnded={() => setIsVideoFinished(true)}
            />
          </div>

          {isVideoFinished && adWait <= 0 ? (
            <button
              className="w-full py-3.5 rounded-xl font-bold bg-gold text-black hover:bg-gold/90 transition-colors"
              onClick={handleVideoClaim}
              disabled={loadingMission === 'video_claim'}
            >
              {loadingMission === 'video_claim'
                ? loc('جارٍ المطالبة…', 'Claiming...')
                : loc(`احصل على ${data?.missions.video.points} نقطة`, `Claim ${data?.missions.video.points} pts`)}
            </button>
          ) : (
            <div className="w-full flex items-center justify-between gap-3">
              <span className="text-gold font-bold text-sm">
                {adWait > 0
                  ? loc(`متبقٍ ${adWait} ثانية`, `${adWait}s remaining`)
                  : loc('الإعلان قيد التشغيل…', 'Video is playing...')}
              </span>
              <button
                className="px-4 py-2 rounded-lg font-bold text-zinc-300 hover:text-white hover:bg-white/10 transition-colors text-sm"
                onClick={() => setShowVideoModal(false)}
              >
                {loc('إغلاق', 'Close')}
              </button>
            </div>
          )}
        </div>
      </Overlay>
    </div>
  );
}
