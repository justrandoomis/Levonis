import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft, Bell, PlayCircle, Check, Star, ShoppingBag, ShieldAlert, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { useSignInPrompt } from '../lib/guest';
import { api, ApiError } from '../lib/api';
import { refusalLang, refusalText } from '../lib/refusalStrings';
import { formatFigure } from '../lib/localeNumber';
import { EmptyState } from '../components/ui/AsyncStates';
import { MotionCharacterHome } from '../components/bloub/MotionCharacterAnchor';
import { Overlay } from '../components/ui/Overlay';
import Spinner from '../components/ui/Spinner';

/**
 * THE POINTS & MISSIONS PAGE.
 *
 * TWO RULES GOVERN THIS FILE.
 *
 * 1. IT DISPLAYS. IT NEVER DECIDES. Every amount on this screen arrives from
 *    GET /api/rewards already computed by the server, base and credited. The
 *    old page multiplied the check-in ladder by two for anybody it considered
 *    "PRO" — which was wrong for a PREMIUM member (who earned 1.5× until 0145), wrong
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
 * Arabic is the source language and every string is written ar-first, with
 * its Sorani (ckb) beside it. A ckb slot never carries a copy of the Arabic
 * (docs/DECISIONS.md row 183, which replaced the old «the owner writes the
 * Kurdish by hand» rule for this screen); the Kurdish uses the app's own
 * vocabulary («خاڵ», «ئەرک», «ڕیکلام») and a native review is welcome.
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
  /** How points are earned, from the server (0146). Absent on an older server. */
  earning?: { iqd_per_point: number; checkin_top_rung: number };
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
  const { loc, dir, lang } = useLanguage();
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
      // The refusal table's sentence for a code it knows, else ours — never
      // the server's raw English («Authentication required»).
      const code = err instanceof ApiError ? err.code : undefined;
      setLoadError(
        refusalText(code, refusalLang(lang)) ||
          loc('تعذّر تحميل صفحة النقاط', 'Couldn’t load your points', 'نەتوانرا پەڕەی خاڵەکان بار بکرێت')
      );
    }
  }, [loc, lang]);

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
    const gain = `+${r.points} ${loc('نقطة', 'pts', 'خاڵ')}`;
    return r.multiplier_x100 > 100
      ? `${what} · ${gain} (${r.base_points} × ${(r.multiplier_x100 / 100).toString()})`
      : `${what} · ${gain}`;
  };

  const failureText = (err: unknown) =>
    err instanceof Error && err.message ? err.message : loc('تعذّر إتمام العملية', 'That did not go through', 'کردارەکە تەواو نەبوو');

  const handleCheckIn = async () => {
    if (!data || data.checked_in_today || isCheckingIn) return;
    setIsCheckingIn(true);
    setNotice(null);
    try {
      const res = await api.post<AwardReply>('/api/rewards/checkin');
      say('good', awardMessage(res, loc(`تسجيل اليوم ${res.day ?? ''}`, `Day ${res.day ?? ''} check-in`, `ئامادەبوونی ڕۆژی ${res.day ?? ''}`)));
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
        say('bad', loc('هذا المتصفح لا يدعم الإشعارات.', 'This browser does not support notifications.', 'ئەم وێبگەڕە پشتگیریی ئاگادارکردنەوە ناکات.'));
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        say('bad', loc('يجب السماح بالإشعارات للحصول على هذه المكافأة.', 'Allow notifications to earn this reward.', 'بۆ وەرگرتنی ئەم خەڵاتە دەبێت ڕێگە بە ئاگادارکردنەوەکان بدەیت.'));
        return;
      }
      const res = await api.post<AwardReply>('/api/rewards/push');
      /*
        «تم منح الإذن», NOT «تم تفعيل الإشعارات».
        
        This said «تم تفعيل الإشعارات» — the exact sentence the settings page
        promises never to show, in as many words: «لا توجد خدمة إرسال Web Push
        على الخادم بعد، فلا نعرض «تم التفعيل»». Two screens of this app made
        opposite claims about the same thing, and the one that claimed success
        was the one handing out points for it.
        
        The mission is real and the reward stands — granting permission is the
        one step only the customer can take, and it is what a delivery service
        will need the day there is one. What was false was the word
        «مُفعّل» for a channel that cannot yet send. The sentence now says what
        actually happened.
        
        Sorani says the same thing in its own words (DECISIONS row 183).
      */
      say('good', awardMessage(res, loc('تم منح إذن الإشعارات في هذا المتصفح', 'Notification permission granted in this browser', 'ڕێگەپێدانی ئاگادارکردنەوە لەم وێبگەڕەدا درا')));
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
      say('bad', loc('لا يوجد إعلان متاح اليوم.', 'No ad is available today.', 'ئەمڕۆ هیچ ڕیکلامێک بەردەست نییە.'));
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
      say('good', awardMessage(res, loc('شاهدت الإعلان', 'Ad watched', 'ڕیکلامەکەت بینی')));
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
          `Mission started — browse for ${mins} minutes. The time is counted by the store's server and pauses when you are idle.`,
          `ئەرکەکە دەستی پێکرد — ${mins} خولەک بەرهەمەکان بگەڕێ. کاتەکە لەسەر ڕاژەکاری فرۆشگا دەژمێردرێت و کاتێک بێکار بیت دەوەستێت.`
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
    checkin: loc('تسجيل الدخول اليومي', 'Daily check-in', 'ئامادەبوونی ڕۆژانە'),
    push: loc('تفعيل الإشعارات', 'Notifications enabled', 'چالاککردنی ئاگادارکردنەوەکان'),
    video: loc('مشاهدة إعلان', 'Watched an ad', 'بینینی ڕیکلام'),
    browse: loc('تصفّح المنتجات', 'Browsed products', 'گەڕان بە بەرهەمەکاندا'),
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
      : d.toLocaleDateString(lang === 'en' ? 'en-GB' : lang === 'ckb' ? ['ckb-IQ', 'ar-IQ'] : 'ar-IQ', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  /** Says plainly that the store cannot verify a task, instead of implying it can. */
  const UnverifiedTag = ({ proof }: { proof: string }) => (
    <span
      title={proof}
      className="lv-chip [--chip:var(--color-warning)] inline-flex items-center gap-1 text-[10px] font-bold rounded-full px-2 py-0.5"
    >
      <ShieldAlert aria-hidden="true" className="w-3 h-3" />
      {loc('غير مُتحقَّق منه', 'Not verifiable', 'پشتڕاست نەکراوەتەوە')}
    </span>
  );

  return (
    <div data-testid="rewards-root" dir={dir} className="w-full min-h-screen font-sans flex flex-col text-text-primary pb-24 overflow-y-auto relative">
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
        {/* A ghost back arrow: no resting or pressed fill (the clay ratchet
            counts filled hand-drawn buttons), and no shared IconButton import,
            which would add to the storefront bundle. The arrow is ink — gold is
            the focus cue, not a decoration. */}
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
          className="w-11 h-11 -ms-2 flex items-center justify-center rounded-full hover:opacity-80 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus transition"
        >
          <ChevronLeft aria-hidden="true" className="w-6 h-6 rtl:rotate-180" strokeWidth={2.5} />
        </button>
        <h1 className="text-[17px] font-bold text-center flex-1">{loc('النقاط والمهام', 'Points & Missions', 'خاڵ و ئەرکەکان')}</h1>
        {/* Registers this page's own character anchor, so the shell stops
            reserving a separate landing strip above this header. */}
        <MotionCharacterHome kind="top-header" compact />
        {/* The tier badge is the server's answer, never a local guess. */}
        {multiplier && multiplier.active ? (
          <span className="p-1 px-3 text-[12px] font-bold rounded-full bg-gold text-accent-contrast uppercase">
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
            <p className="text-text-secondary font-medium mb-4">
              {loc('سجّل الدخول لجمع النقاط ومتابعتها', 'Sign in to earn and track your points', 'بچۆ ژوورەوە بۆ کۆکردنەوە و بەدواداچوونی خاڵەکانت')}
            </p>
            <button onClick={signIn} className="lv-button lv-button-primary px-6">
              {loc('تسجيل الدخول', 'Sign in', 'چوونە ژوورەوە')}
            </button>
          </div>
        ) : (
          <>
            {loadError && (
              <div className="lv-alert lv-alert-danger text-[13px] font-medium text-text-primary text-center mb-4">
                {loadError}
              </div>
            )}
            {notice && (
              <div
                role="status"
                aria-live="polite"
                className={`lv-alert text-[13px] font-medium text-text-primary text-center mb-4 ${
                  notice.tone === 'good' ? 'lv-alert-success' : 'lv-alert-danger'
                }`}
              >
                {notice.text}
              </div>
            )}

            {/* Balance */}
            <div className="flex justify-between items-center mb-6 relative">
              <div className="pt-2">
                <div className="text-[14px] text-gold mb-0.5 font-medium">{loc('رصيدي', 'My Balance', 'باڵانسەکەم')}</div>
                <div aria-live="polite" className="text-[56px] leading-[1.1] font-bold tracking-tight tabular-nums">
                  {formatFigure(data?.point_balance ?? pointBalance ?? 0, lang)}
                </div>
              </div>
              {/* THE COIN: one raised gold disc lit from above, the star in ink.
                  It was three stacked layers — a sideways hard shadow, a hex
                  gradient and a 4px rim, tilted — a second light source on a
                  page that has one. */}
              <div aria-hidden="true" className="w-24 h-24 rounded-full bg-gold-fill shadow-1 grid place-items-center text-onyx shrink-0">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-[44px] h-[44px]">
                  <path d="M12 0C12 6.627 17.373 12 24 12C17.373 12 12 17.373 12 24C12 17.373 6.627 12 0 12C6.627 12 12 6.627 12 0Z" />
                </svg>
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
                className={`rounded-xl p-4 mb-6 border ${
                  boosted ? 'bg-gold/10 border-gold/30' : 'bg-surface border-border-subtle'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles aria-hidden="true" className={`w-4 h-4 ${boosted ? 'text-gold' : 'text-text-secondary'}`} />
                  <h3 className={`font-bold text-[14px] ${boosted ? 'text-gold' : 'text-text-primary'}`}>
                    {boosted
                      ? loc(
                          `اشتراكك يمنحك ${multiplier.label.replace('x', '')}× من النقاط`,
                          `Your subscription earns you ${multiplier.label.replace('x', '')}× points`,
                          `بەشداریکردنەکەت ${multiplier.label.replace('x', '')}× خاڵت پێدەدات`
                        )
                      : loc('نقاطك بالمعدّل الأساسي (1×)', 'You earn at the standard rate (1×)', 'خاڵەکانت بە ڕێژەی بنەڕەتین (1×)')}
                  </h3>
                </div>
                <p className="text-text-secondary text-[12px] leading-relaxed">
                  {boosted
                    ? loc(
                        'يُطبَّق على تسجيل الدخول اليومي والمهام والشراء والتقييمات. المُضاعِف يُثبَّت لحظة منح النقاط، فانتهاء الاشتراك لاحقًا لا يغيّر ما رَبِحته.',
                        'Applied to daily check-in, missions, purchases and reviews. The multiplier is frozen at the moment each award is made, so a subscription that later ends never changes what you already earned.',
                        'لەسەر ئامادەبوونی ڕۆژانە، ئەرکەکان، کڕین و هەڵسەنگاندنەکان جێبەجێ دەکرێت. چەندجارەکەرەکە لە ساتی پێدانی خاڵەکاندا جێگیر دەکرێت، بۆیە کۆتاییهاتنی بەشداریکردن دواتر ئەوەی بردووتەوە ناگۆڕێت.'
                      )
                    : data?.earning
                      ? loc(
                          `نقطة واحدة عن كل ${data.earning.iqd_per_point.toLocaleString('en-US')} د.ع من مشترياتك، وتسجيل الدخول اليومي يبدأ بنقطة ويزيد نقطة كل يوم متتالٍ حتى ${data.earning.checkin_top_rung} نقاط.`,
                          `One point for every ${data.earning.iqd_per_point.toLocaleString('en-US')} IQD you spend, and the daily check-in starts at one point and climbs by one each consecutive day, up to ${data.earning.checkin_top_rung}.`,
                          `بۆ هەر ${data.earning.iqd_per_point.toLocaleString('en-US')} د.ع لە کڕینەکانت یەک خاڵ، و ئامادەبوونی ڕۆژانە بە یەک خاڵ دەست پێدەکات و هەر ڕۆژێکی یەک لە دوای یەک یەک خاڵ زیاد دەبێت تا ${data.earning.checkin_top_rung} خاڵ.`
                        )
                      : loc(
                          'يُطبَّق على تسجيل الدخول اليومي والمهام والشراء والتقييمات.',
                          'Applies to daily check-in, missions, purchases and reviews.',
                          'لەسەر ئامادەبوونی ڕۆژانە، ئەرکەکان، کڕین و هەڵسەنگاندنەکان جێبەجێ دەکرێت.'
                        )}
                </p>
                {boosted && multiplier.expires_at && (
                  <p className="text-text-muted text-[11px] mt-2">
                    {loc('ينتهي في', 'Ends', 'کۆتایی دێت لە')} {new Date(multiplier.expires_at).toLocaleDateString()}
                  </p>
                )}
              </div>
            )}

            {/* Check-in card: the screen's one focal card, a single raised slab.
                It was a notebook page — a rotated under-layer, binder holes and
                a paperclip — three objects pretending to be one. Hidden while
                the page could not load, rather than claiming a 0-day streak. */}
            {(data || !loadError) && (
            <div className="mb-6">
              <div className="lv-surface-raised p-4">
                <div>
                  <h2 className="text-[16px] font-bold mb-1">
                    {loc(
                      `سجّلت دخولك ${data?.streak ?? 0} ${(data?.streak ?? 0) === 1 ? 'يومًا' : 'أيام'} متتالية`,
                      `You've checked in for ${data?.streak ?? 0} day${(data?.streak ?? 0) === 1 ? '' : 's'}`,
                      `${data?.streak ?? 0} ڕۆژی یەک لە دوای یەک ئامادە بوویت`
                    )}
                  </h2>
                  <p className="text-[11px] text-text-secondary mb-4">
                    {loc(
                      'اليوم يُحدَّد بتوقيت بغداد على خادم المتجر — لا بتوقيت جهازك.',
                      "The day is the store server's Baghdad date — not your device's.",
                      'ڕۆژەکە بە کاتی بەغدا لەسەر ڕاژەکاری فرۆشگا دیاری دەکرێت — نەک بە کاتی ئامێرەکەت.'
                    )}
                  </p>

                  <div className="flex justify-between mb-5 overflow-x-auto pb-2 pt-1 -mx-1 px-1 hide-scrollbar items-end gap-1">
                    {ladder.map((d) => (
                      <div
                        key={d.day}
                        className={`flex flex-col items-center flex-shrink-0 relative ${
                          d.status === 'today'
                            ? 'w-[48px] pb-1.5 border border-gold rounded-md bg-surface-raised transform -translate-y-1 overflow-hidden animate-day-pop'
                            : d.status === 'checked'
                              ? 'w-[42px] pt-1 pb-1.5 bg-surface-selected rounded-md'
                              : 'w-[42px] pt-1 pb-1.5 lv-well rounded-md'
                        }`}
                      >
                        {d.status === 'today' ? (
                          <div className="w-full bg-gold text-accent-contrast text-[9px] font-bold text-center py-1 mb-1.5 tracking-wide">
                            {loc('اليوم', 'Today', 'ئەمڕۆ')}
                          </div>
                        ) : (
                          <span
                            className={`text-[10px] font-bold tracking-tight mb-1.5 ${
                              d.status === 'checked' ? 'text-gold' : 'text-text-secondary'
                            }`}
                          >
                            {loc(`يوم ${d.day}`, `Day ${d.day}`, `ڕۆژی ${d.day}`)}
                          </span>
                        )}

                        <div className="flex items-center justify-center mb-1 h-[24px]">
                          {d.status === 'checked' ? (
                            <div className="w-[20px] h-[20px] bg-gold rounded-full flex items-center justify-center shadow-sm">
                              <Check aria-hidden="true" className="w-3.5 h-3.5 text-onyx" strokeWidth={4} />
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
                            d.status === 'today' ? 'text-text-primary' : d.status === 'checked' ? 'text-gold' : 'text-text-secondary'
                          }`}
                        >
                          {d.points}
                        </span>
                        {d.points !== d.base_points && (
                          <span className="text-[8px] text-text-muted tabular-nums">{d.base_points}×{multiplier?.label.replace('x', '')}</span>
                        )}
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={handleCheckIn}
                    disabled={!data || data.checked_in_today || isCheckingIn}
                    className="lv-button lv-button-primary w-full min-h-12 text-[15px]"
                  >
                    {isCheckingIn ? (
                      <Spinner size="sm" delayMs={0} decorative />
                    ) : data?.checked_in_today ? (
                      loc('تم التسجيل اليوم', 'Checked in', 'ئەمڕۆ ئامادە بوویت')
                    ) : (
                      loc(`سجّل الدخول (+${data?.checkin.points ?? 0})`, `Check in (+${data?.checkin.points ?? 0})`, `ئامادەبوون تۆمار بکە (+${data?.checkin.points ?? 0})`)
                    )}
                  </button>
                </div>
              </div>
            </div>
            )}

            {/* Missions */}
            <div className="mt-8 mb-8">
              <h2 className="text-[17px] font-bold mb-4 px-1 text-text-primary">{loc('اجمع النقاط', 'Earn Points', 'خاڵ کۆبکەرەوە')}</h2>
              <div className="space-y-3 px-1">
                {!data && !loadError && (
                  <div className="flex justify-center py-6">
                    <div className="w-6 h-6 border-2 border-gold/20 border-t-gold rounded-full animate-spin" />
                  </div>
                )}
                {/* The page could not load: say so under the heading, with a
                    way to try again, rather than leaving it empty. */}
                {!data && loadError && (
                  <EmptyState
                    compact
                    title={loc('لا توجد طرق لكسب النقاط الآن', 'No ways to earn points right now', 'ئێستا هیچ ڕێگایەک بۆ کۆکردنەوەی خاڵ نییە')}
                    action={
                      <button type="button" onClick={loadRewards} className="lv-button lv-button-secondary mt-1">
                        {loc('إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە')}
                      </button>
                    }
                  />
                )}
                {allDailyDone && (
                  <div className="text-text-secondary text-center py-4 text-sm">
                    {loc('أنهيت كل مهام اليوم.', "You're all caught up for today!", 'هەموو ئەرکەکانی ئەمڕۆت تەواو کرد.')}
                  </div>
                )}

                {missions && !missions.push.claimed && (
                  <button
                    type="button"
                    onClick={handlePushMission}
                    disabled={loadingMission === 'push' || !missions.push.available}
                    className="lv-surface w-full text-start p-4 flex items-center justify-between hover:bg-surface-raised active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="size-10 rounded-full bg-gold/10 flex items-center justify-center shrink-0">
                        {loadingMission === 'push' ? (
                          <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
                        ) : (
                          <Bell aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-text-primary font-bold text-[14px] flex items-center gap-2 flex-wrap">
                          {loc('فعّل الإشعارات', 'Enable Notifications', 'ئاگادارکردنەوەکان چالاک بکە')}
                          {missions.push.verification === 'client_asserted' && <UnverifiedTag proof={missions.push.proof} />}
                        </h4>
                        <span className="text-text-secondary font-medium text-[12px]">
                          {loc('مرة واحدة لكل حساب', 'Once per account', 'یەک جار بۆ هەر هەژمارێک')}
                        </span>
                      </div>
                    </div>
                    <div className="text-gold font-bold text-[16px] text-end shrink-0">
                      +{missions.push.points}
                      {breakdown(missions.push.base_points, missions.push.points) && (
                        <div className="text-[10px] text-text-secondary font-medium">
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
                    className={`lv-surface w-full text-start p-4 flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus transition-colors ${
                      missions.video.available ? 'hover:bg-surface-raised active:shadow-press' : 'opacity-60 cursor-not-allowed'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="size-10 rounded-full bg-gold/10 flex items-center justify-center shrink-0">
                        {loadingMission === 'video' ? (
                          <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
                        ) : (
                          <PlayCircle aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-text-primary font-bold text-[14px] flex items-center gap-2 flex-wrap">
                          {loc('شاهد إعلانًا', 'Watch Ad', 'ڕیکلامێک ببینە')}
                          <UnverifiedTag proof={missions.video.proof} />
                        </h4>
                        <span className="text-text-secondary font-medium text-[12px]">
                          {missions.video.available
                            ? loc(
                                `${missions.video.required_seconds} ثانية على الأقل — يحسبها الخادم`,
                                `${missions.video.required_seconds}s minimum, timed by the server`,
                                `لانیکەم ${missions.video.required_seconds} چرکە — ڕاژەکار دەیژمێرێت`
                              )
                            : loc('لا يوجد إعلان اليوم', 'No ad today', 'ئەمڕۆ ڕیکلام نییە')}
                        </span>
                      </div>
                    </div>
                    <div className="text-gold font-bold text-[16px] text-end shrink-0">
                      +{missions.video.points}
                      {breakdown(missions.video.base_points, missions.video.points) && (
                        <div className="text-[10px] text-text-secondary font-medium">
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
                    className="lv-surface w-full text-start p-4 flex items-center justify-between hover:bg-surface-raised active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="size-10 rounded-full bg-gold/10 flex items-center justify-center shrink-0">
                        {loadingMission === 'browse' ? (
                          <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
                        ) : (
                          <ShoppingBag aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-text-primary font-bold text-[14px] flex items-center gap-2 flex-wrap">
                          {loc('تصفّح المنتجات', 'Browse Products', 'بەرهەمەکان بگەڕێ')}
                          <UnverifiedTag proof={missions.browse.proof} />
                        </h4>
                        <span className="text-text-secondary font-medium text-[12px]">
                          {loc(
                            `${Math.round(missions.browse.required_seconds / 60)} دقائق`,
                            `${Math.round(missions.browse.required_seconds / 60)} mins`,
                            `${Math.round(missions.browse.required_seconds / 60)} خولەک`
                          )}
                          {missions.browse.progress_seconds > 0 &&
                            ` • ${missions.browse.progress_seconds}/${missions.browse.required_seconds}s`}
                        </span>
                      </div>
                    </div>
                    <div className="text-gold font-bold text-[16px] text-end shrink-0">
                      +{missions.browse.points}
                      {breakdown(missions.browse.base_points, missions.browse.points) && (
                        <div className="text-[10px] text-text-secondary font-medium">
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
            {data && (
            <div className="mt-8 mb-8">
              <h2 className="text-[17px] font-bold mb-4 px-1 text-text-primary">{loc('سجلّ النقاط', 'Points History', 'مێژووی خاڵەکان')}</h2>
              <div className="px-1">
                {data.history.length === 0 && (
                  <EmptyState
                    compact
                    icon={<Star aria-hidden="true" className="w-6 h-6" />}
                    title={loc('لا حركات على نقاطك بعد', 'No points activity yet', 'هێشتا هیچ جووڵەیەک لە خاڵەکانتدا نییە')}
                  />
                )}
                {data.history.length > 0 && (
                <div className="lv-surface overflow-hidden divide-y divide-border-subtle">
                {data.history.map((h, i) => {
                  const spend = h.direction === 'spend';
                  return (
                  <div key={`${h.mission}-${h.day}-${h.awarded_at ?? ''}-${i}`} className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`size-10 rounded-full flex items-center justify-center shrink-0 ${spend ? 'lv-well' : 'bg-gold/10'}`}>
                        {spend ? (
                          <ShoppingBag aria-hidden="true" className="w-5 h-5 text-text-secondary" />
                        ) : (
                          <Star aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-text-primary font-bold text-[14px]">
                          {/* A ledger movement has no mission; it carries its own wording. */}
                          {missionLabel[h.mission] ?? (h.note || h.mission)}
                          {h.streak_day ? ` · ${loc(`يوم ${h.streak_day}`, `day ${h.streak_day}`, `ڕۆژی ${h.streak_day}`)}` : ''}
                        </h4>
                        <span className="text-text-secondary font-medium text-[12px]">
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
                    <div className={`font-bold text-[16px] shrink-0 tabular-nums ${spend ? 'text-text-primary' : 'text-gold'}`}>
                      {spend ? '−' : '+'}{h.points} {loc('نقطة', 'pts', 'خاڵ')}
                    </div>
                  </div>
                  );
                })}
                </div>
                )}
              </div>
            </div>
            )}
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
          <h3 id="rewards-video-title" className="text-text-primary font-bold text-lg mb-2">
            {loc('شاهد الإعلان لتربح النقاط', 'Watch the ad to earn', 'ڕیکلامەکە ببینە بۆ بردنەوەی خاڵ')}
          </h3>
          <p className="text-text-secondary text-sm text-center mb-6">
            {loc('شاهد الإعلان كاملًا للحصول على نقاطك.', 'Please watch the entire video to receive your points.', 'ڕیکلامەکە بە تەواوی ببینە بۆ وەرگرتنی خاڵەکانت.')}
          </p>

          <div className="w-full aspect-video bg-charcoal rounded-lg mb-6 relative overflow-hidden flex items-center justify-center border border-border-subtle">
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
              className="lv-button lv-button-primary w-full min-h-12"
              onClick={handleVideoClaim}
              disabled={loadingMission === 'video_claim'}
            >
              {loadingMission === 'video_claim'
                ? loc('جارٍ المطالبة…', 'Claiming...', 'وەرگرتن…')
                : loc(`احصل على ${data?.missions.video.points} نقطة`, `Claim ${data?.missions.video.points} pts`, `${data?.missions.video.points} خاڵ وەربگرە`)}
            </button>
          ) : (
            <div className="w-full flex items-center justify-between gap-3">
              <span className="text-gold font-bold text-sm">
                {adWait > 0
                  ? loc(`متبقٍ ${adWait} ثانية`, `${adWait}s remaining`, `${adWait} چرکە ماوە`)
                  : loc('الإعلان قيد التشغيل…', 'Video is playing...', 'ڕیکلامەکە پەخش دەکرێت…')}
              </span>
              <button
                className="lv-button lv-button-ghost"
                onClick={() => setShowVideoModal(false)}
              >
                {loc('إغلاق', 'Close', 'داخستن')}
              </button>
            </div>
          )}
        </div>
      </Overlay>
    </div>
  );
}
