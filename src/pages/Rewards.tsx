import React, { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, Bell, PlayCircle, Paperclip, Check, Star, ShoppingBag } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';

interface RewardsData {
  today: string;
  streak: number;
  checked_in_today: boolean;
  point_balance: number;
  missions: {
    push: { points: number; claimed: boolean };
    video: { points: number; claimed: boolean; available: boolean; videoUrl: string | null };
    browse: { points: number; claimed: boolean; required_seconds: number; progress_seconds: number };
  };
  is_pro: boolean;
}

export default function Rewards() {
  const navigate = useNavigate();
  const { pointBalance, pointTransactions, refreshWallet } = useWallet();
  const { isAuthenticated, isLoaded: authLoaded } = useAuth();

  const [data, setData] = useState<RewardsData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [loadingMission, setLoadingMission] = useState<string | null>(null);
  const [showVideoModal, setShowVideoModal] = useState(false);
  const [isVideoFinished, setIsVideoFinished] = useState(false);

  const loadRewards = useCallback(async () => {
    try {
      const res = await api.get<RewardsData>('/api/rewards');
      setData(res);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load rewards');
    }
  }, []);

  useEffect(() => {
    if (!authLoaded || !isAuthenticated) return;
    loadRewards();
  }, [authLoaded, isAuthenticated, loadRewards]);

  const isPro = data?.is_pro ?? false;
  const currentStreak = data?.streak ?? 0;
  const isCheckedInToday = data?.checked_in_today ?? false;
  const currentDay = currentStreak + (isCheckedInToday ? 0 : 1);

  // Mirrors the server's schedule for display; the server decides the credit.
  const getPointsForDay = (day: number) => {
    let pts = 20;
    if (day === 1 || day === 2) pts = 5;
    else if (day === 3 || day === 4) pts = 10;
    else if (day === 5 || day === 6) pts = 15;
    return isPro ? pts * 2 : pts;
  };

  const handleCheckIn = async () => {
    if (isCheckedInToday || !data || isCheckingIn) return;
    setIsCheckingIn(true);
    try {
      const res = await api.post<{ streak: number; points: number }>('/api/rewards/checkin');
      alert(`Checked in! Day ${res.streak} — you earned ${res.points} pts.`);
      await Promise.all([loadRewards(), refreshWallet()]);
    } catch (err: any) {
      // 409 = already claimed today
      alert(err?.message || 'Check-in failed — please try again');
      await loadRewards();
    } finally {
      setIsCheckingIn(false);
    }
  };

  const handlePushMission = async () => {
    if (loadingMission || !data) return;
    if (data.missions.push.claimed) return;
    setLoadingMission('push');
    try {
      if (!('Notification' in window)) {
        alert('Push notifications are not supported in this browser.');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert('You must allow notifications to earn this reward.');
        return;
      }
      const res = await api.post<{ points: number }>('/api/rewards/push');
      alert(`You enabled notifications and earned ${res.points} pts!`);
      await Promise.all([loadRewards(), refreshWallet()]);
    } catch (err: any) {
      alert(err?.message || 'Failed to claim the reward.');
      await loadRewards();
    } finally {
      setLoadingMission(null);
    }
  };

  const handleVideoMission = () => {
    if (loadingMission || !data) return;
    if (data.missions.video.claimed) return;
    if (!data.missions.video.available || !data.missions.video.videoUrl) {
      alert('No ad video is available today. Please check back later.');
      return;
    }
    setIsVideoFinished(false);
    setShowVideoModal(true);
  };

  const handleVideoClaim = async () => {
    setLoadingMission('video_claim');
    try {
      const res = await api.post<{ points: number }>('/api/rewards/video');
      alert(`You watched the ad and earned ${res.points} pts!`);
      await Promise.all([loadRewards(), refreshWallet()]);
    } catch (err: any) {
      alert(err?.message || 'Failed to claim the reward.');
      await loadRewards();
    } finally {
      setLoadingMission(null);
      setShowVideoModal(false);
    }
  };

  const handleBrowseMission = async () => {
    if (loadingMission || !data) return;
    if (data.missions.browse.claimed) return;
    setLoadingMission('browse');
    try {
      await api.post('/api/rewards/browse/start');
      window.dispatchEvent(new Event('levo_mission_start'));
      alert(`Mission started! Browse our products for ${Math.round(data.missions.browse.required_seconds / 60)} minutes — progress is tracked automatically and pauses if you're inactive.`);
      navigate('/');
    } catch (err: any) {
      alert(err?.message || 'Failed to start the mission.');
      await loadRewards();
    } finally {
      setLoadingMission(null);
    }
  };

  const startDay = Math.max(1, Math.floor((Math.max(1, currentDay) - 1) / 7) * 7 + 1);

  const days = Array.from({ length: 7 }, (_, i) => {
    const dayNum = startDay + i;
    const points = getPointsForDay(dayNum);
    let status = 'upcoming';

    if (dayNum <= currentStreak) {
      status = 'checked';
    } else if (dayNum === currentStreak + 1 && !isCheckedInToday) {
      status = 'today';
    }

    return { day: dayNum, points, status };
  });

  const missions = data?.missions;
  const allDailyDone = !!missions && missions.push.claimed && missions.video.claimed && missions.browse.claimed;

  return (
    <div data-testid="rewards-root" className="w-full bg-black min-h-screen font-sans flex flex-col text-white pb-24 overflow-y-auto relative">
      {/* Background layers ONLY (mandate §4.1): the olive-green wash and its
          green card layers are replaced by the base dark LEVONIS surfaces
          (black → zinc), keeping this page's own structure and identity. The
          dot texture kept mix-blend-multiply, which on a dark ground darkens
          instead of lighting — it is now a plain low-opacity overlay. */}
      <div
        aria-hidden="true"
        className="absolute top-0 left-0 w-full h-[800px] pointer-events-none"
        style={{
          background: 'linear-gradient(to bottom, #141416 0%, #0d0d0f 45%, #000000 100%)',
        }}
      ></div>
      <div
        aria-hidden="true"
        className="absolute top-0 left-0 w-full h-96 opacity-[0.07] pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(#ffffff 1.5px, transparent 1.5px)',
          backgroundSize: '16px 16px',
          maskImage: 'linear-gradient(to bottom, black, transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)'
        }}
      ></div>

      {/* Header */}
      <div className="flex items-center px-4 py-4 sticky top-0 z-10 relative">
        <button
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="w-11 h-11 -ms-2 flex items-center justify-center rounded-full hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold transition-colors"
        >
          <ChevronLeft aria-hidden="true" className="w-6 h-6 text-gold" strokeWidth={2.5} />
        </button>
        <h1 className="text-[17px] font-bold text-center flex-1">Rewards</h1>
        {/* PRO status comes from the server-side subscription — display only */}
        {isPro ? (
          <span className="p-1 px-3 text-[12px] font-bold rounded-full bg-gold text-black">PRO</span>
        ) : (
          <span className="w-[52px]"></span>
        )}
      </div>

      <div className="px-5 relative z-10 mt-2">
        {authLoaded && !isAuthenticated ? (
          <div className="text-center py-20">
            <Star aria-hidden="true" className="w-10 h-10 mx-auto mb-3 text-gold/70" />
            <p className="text-zinc-300 font-medium mb-4">Sign in to earn and track your points</p>
            <button onClick={() => navigate('/auth')} className="px-6 py-2.5 bg-gold text-black rounded-full font-bold text-sm">
              Sign in
            </button>
          </div>
        ) : (
        <>
        {loadError && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-2xl p-3 text-center mb-4">
            {loadError}
          </div>
        )}

        {/* Balance Section */}
        <div className="flex justify-between items-center mb-8 relative">
          <div className="pt-2">
            <div className="text-[14px] text-gold mb-0.5 font-medium">My Balance</div>
            <div aria-live="polite" className="text-[56px] leading-[1.1] font-black tracking-tight tabular-nums">
              {(data?.point_balance ?? pointBalance).toLocaleString()}
            </div>
          </div>
          <div className="relative right-2">
            {/* 3D Coin */}
            <div className="w-24 h-24 rounded-full relative z-10 transform -rotate-12">
              <div className="absolute inset-0 rounded-full bg-[#6b5f3c] transform translate-x-[3px] translate-y-[4px]"></div>
              <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-[#BAA369] to-[#ffe55c] border-[4px] border-[#ffe55c] flex items-center justify-center shadow-[inset_-3px_-3px_12px_rgba(0,0,0,0.15)]">
                <div className="text-black drop-shadow-[1px_2px_2px_rgba(0,0,0,0.25)] relative top-[-1px]">
                  <svg viewBox="0 0 24 24" fill="white" className="w-[44px] h-[44px] transform rotate-12">
                     <path d="M12 0C12 6.627 17.373 12 24 12C17.373 12 12 17.373 12 24C12 17.373 6.627 12 0 12C6.627 12 12 6.627 12 0Z"/>
                  </svg>
                </div>
              </div>
            </div>
            <div className="absolute inset-0 w-24 h-24 rounded-full bg-black/20 blur-md transform translate-y-6 -translate-x-0 z-0"></div>
          </div>
        </div>

        {/* Check-in Card */}
        <div className="relative mb-6 mx-1">
          {/* Background Card */}
          <div className="absolute inset-0 bg-gradient-to-br from-[#18181b] to-[#27272a] rounded-[28px] transform -rotate-[2deg] translate-y-1 -translate-x-1 shadow-sm"></div>

          {/* Main Card */}
          <div className="bg-[#111113] rounded-[24px] p-4 shadow-[0_8px_30px_rgba(0,0,0,0.06)] relative z-10">
            {/* Perforated Edge */}
            <div className="absolute top-5 bottom-5 left-2 flex flex-col justify-between opacity-50">
              {[...Array(12)].map((_, i) => (
                <div key={i} className="w-1.5 h-1.5 rounded-full bg-black/50 shadow-inner"></div>
              ))}
            </div>

            <div className="absolute -top-3 right-3 text-zinc-400 transform rotate-[30deg] z-20 drop-shadow-md">
              <Paperclip aria-hidden="true" className="w-6 h-6" strokeWidth={1.5} />
            </div>

            <div className="pl-3">
              <h2 className="text-[16px] font-bold mb-4 flex items-center gap-1.5">
                You've checked in for {currentStreak} Day{currentStreak !== 1 ? 's' : ''} <span aria-hidden="true" className="w-[14px] h-[14px] rounded-full border-[1.5px] border-white/25 flex items-center justify-center text-[9px] text-zinc-400 font-bold">?</span>
              </h2>

              <div className="flex justify-between mb-5 overflow-x-auto pb-2 pt-1 -mx-1 px-1 hide-scrollbar items-end gap-1">
                {days.map((d, i) => (
                  <div key={i} className={`flex flex-col items-center flex-shrink-0 relative ${
                    d.status === 'today' ? 'w-[48px] pb-1.5 border border-gold rounded-[14px] shadow-[0_4px_12px_rgba(186,163,105,0.15)] bg-[#27272a] transform -translate-y-1 overflow-hidden animate-day-pop' :
                    d.status === 'checked' ? 'w-[42px] pt-1 pb-1.5 bg-gradient-to-b from-[#18181b] to-[#27272a] rounded-[14px]' :
                    'w-[42px] pt-1 pb-1.5 bg-[#18181b] rounded-[14px]'
                  }`}>
                    {d.status === 'today' ? (
                       <div className="w-full bg-gold text-black text-[9px] font-bold text-center py-1 mb-1.5 tracking-wide">
                         Today
                       </div>
                    ) : (
                       <span className={`text-[10px] font-bold tracking-tight mb-1.5 ${
                         d.status === 'checked' ? 'text-gold' : 'text-zinc-400'
                       }`}>
                         Day {d.day}
                       </span>
                    )}

                    <div className="flex items-center justify-center mb-1 h-[24px]">
                      {d.status === 'checked' ? (
                        <div className="w-[20px] h-[20px] bg-gold rounded-full flex items-center justify-center shadow-sm">
                          <Check aria-hidden="true" className="w-3.5 h-3.5 text-black" strokeWidth={4} />
                        </div>
                      ) : (d.status === 'today' || (d.day % 7 === 0 && d.status === 'upcoming')) ? (
                        <div className="relative">
                          <svg viewBox="0 0 24 24" fill="#9a8553" className="w-[18px] h-[18px] absolute -top-[3px] -right-[5px]">
                             <circle cx="12" cy="12" r="10" />
                             <path d="M12 6C12 8.5 15.5 11 18 11C15.5 11 12 13.5 12 16C12 13.5 8.5 11 6 11C8.5 11 12 8.5 12 6Z" fill="white"/>
                          </svg>
                          <svg viewBox="0 0 24 24" fill="#BAA369" className="w-[18px] h-[18px] relative z-10">
                             <circle cx="12" cy="12" r="10" />
                             <path d="M12 6C12 8.5 15.5 11 18 11C15.5 11 12 13.5 12 16C12 13.5 8.5 11 6 11C8.5 11 12 8.5 12 6Z" fill="white"/>
                          </svg>
                        </div>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="#BAA369" className="w-[20px] h-[20px]">
                           <circle cx="12" cy="12" r="10" />
                           <path d="M12 6C12 8.5 15.5 11 18 11C15.5 11 12 13.5 12 16C12 13.5 8.5 11 6 11C8.5 11 12 8.5 12 6Z" fill="white"/>
                        </svg>
                      )}
                    </div>

                    <span className={`text-[11px] font-bold ${
                      d.status === 'today' || (d.day % 7 === 0 && d.status === 'upcoming') ? 'text-white' :
                      d.status === 'checked' ? 'text-gold' :
                      'text-zinc-400'
                    }`}>{d.points}</span>
                  </div>
                ))}
              </div>

              <button
                onClick={handleCheckIn}
                disabled={isCheckedInToday || isCheckingIn || !data}
                className={`w-full min-h-[48px] py-3.5 rounded-[20px] font-bold text-[15px] transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold
                ${isCheckedInToday || !data ? 'bg-[#18181b] text-zinc-400' : 'bg-gold text-black'}`}>
                {isCheckingIn ? <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin mx-auto" /> : (isCheckedInToday ? 'Checked in' : 'Check in')}
              </button>
            </div>
          </div>
        </div>


        {/* Earn Rewards Section */}
        <div className="mt-8 mb-8">
          <h2 className="text-[17px] font-bold mb-4 px-1 text-white">Earn Points</h2>
          <div className="space-y-3 px-1">
            {!data && !loadError && (
              <div className="flex justify-center py-6">
                <div className="w-6 h-6 border-2 border-gold/20 border-t-gold rounded-full animate-spin" />
              </div>
            )}
            {allDailyDone && <div className="text-zinc-400 text-center py-4 text-sm">You're all caught up for today!</div>}

            {missions && !missions.push.claimed && (
            <button
              type="button"
              onClick={handlePushMission}
              disabled={loadingMission === 'push'}
              className="w-full text-start bg-[#18181b] rounded-[20px] p-4 flex items-center justify-between shadow-sm hover:bg-[#27272a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-60 transition-colors">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                  {loadingMission === 'push' ? <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" /> : <Bell aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />}
                </div>
                <div>
                  <h4 className="text-white font-bold text-[14px]">Enable Notifications</h4>
                  <span className="text-zinc-400 font-medium text-[12px]">Stay updated</span>
                </div>
              </div>
              <div className="text-gold font-bold text-[16px]">
                +{missions.push.points} pts
              </div>
            </button>
            )}

            {missions && !missions.video.claimed && (
            <button
              type="button"
              onClick={handleVideoMission}
              disabled={!missions.video.available || loadingMission === 'video'}
              className={`w-full text-start bg-[#18181b] rounded-[20px] p-4 flex items-center justify-between shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold transition-colors ${missions.video.available ? 'hover:bg-[#27272a]' : 'opacity-60 cursor-not-allowed'}`}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                  {loadingMission === 'video' ? <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" /> : <PlayCircle aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />}
                </div>
                <div>
                  <h4 className="text-white font-bold text-[14px]">Watch Ad</h4>
                  <span className="text-zinc-400 font-medium text-[12px]">
                    {missions.video.available ? 'Daily reward' : 'No ad video today'}
                  </span>
                </div>
              </div>
              <div className="text-gold font-bold text-[16px]">
                +{missions.video.points} pts
              </div>
            </button>
            )}

            {missions && !missions.browse.claimed && (
            <button
              type="button"
              onClick={handleBrowseMission}
              disabled={loadingMission === 'browse'}
              className="w-full text-start bg-[#18181b] rounded-[20px] p-4 flex items-center justify-between shadow-sm hover:bg-[#27272a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-60 transition-colors">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                  {loadingMission === 'browse' ? <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" /> : <ShoppingBag aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />}
                </div>
                <div>
                  <h4 className="text-white font-bold text-[14px]">Browse Products</h4>
                  <span className="text-zinc-400 font-medium text-[12px]">
                    {Math.round(missions.browse.required_seconds / 60)} mins • Daily reward
                    {missions.browse.progress_seconds > 0 && ` • ${missions.browse.progress_seconds}/${missions.browse.required_seconds}s done`}
                  </span>
                </div>
              </div>
              <div className="text-gold font-bold text-[16px]">
                +{missions.browse.points} pts
              </div>
            </button>
            )}
          </div>
        </div>

        {/* Points History Section */}
        <div className="mt-8 mb-8">
          <h2 className="text-[17px] font-bold mb-4 px-1 text-white">Points History</h2>
          <div className="space-y-3 px-1">
            {pointTransactions.length === 0 && (
              <div className="text-zinc-400 text-center py-4 text-sm">No recent activity</div>
            )}
            {pointTransactions.slice(0, 10).map((tx, i) => (
              <div key={tx.id || i} className="bg-[#18181b] rounded-[20px] p-4 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                    <Star aria-hidden="true" className="w-5 h-5 text-gold" fill="currentColor" />
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-[14px] capitalize">{tx.note || (tx.type === 'deposit' ? 'Points Earned' : 'Points Spent')}</h4>
                    <span className="text-zinc-400 font-medium text-[12px]">{new Date(tx.date).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className={`font-bold text-[16px] ${tx.type === 'deposit' ? 'text-gold' : 'text-[#B03142]'}`}>
                  {tx.type === 'deposit' ? '+' : '-'}{tx.amount} pts
                </div>
              </div>
            ))}
          </div>
        </div>
        </>
        )}
      </div>


      {/* Video Modal */}
      {showVideoModal && data?.missions.video.videoUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm">
          <div className="bg-[#111113] w-full max-w-md rounded-3xl p-6 border border-[#27272a] shadow-2xl relative flex flex-col items-center">
            <h3 className="text-white font-bold text-lg mb-2">Watch Video to Earn</h3>
            <p className="text-zinc-300 text-sm text-center mb-6">Please watch the entire video to receive your points.</p>

            <div className="w-full aspect-video bg-black rounded-xl mb-6 relative overflow-hidden flex items-center justify-center border border-white/5">
              <video
                src={data.missions.video.videoUrl}
                autoPlay
                controls={false}
                playsInline
                className="w-full h-full object-contain"
                onEnded={() => setIsVideoFinished(true)}
              />
            </div>

            {isVideoFinished ? (
              <button
                className="w-full py-3.5 rounded-xl font-bold bg-gold text-black hover:bg-gold/90 transition-colors"
                onClick={handleVideoClaim}
                disabled={loadingMission === 'video_claim'}
              >
                {loadingMission === 'video_claim' ? 'Claiming...' : `Claim ${data.missions.video.points} pts`}
              </button>
            ) : (
              <div className="w-full flex items-center justify-between">
                <span className="text-gold font-bold text-sm">Video is playing...</span>
                <button
                  className="px-4 py-2 rounded-lg font-bold text-zinc-300 hover:text-white hover:bg-white/10 transition-colors text-sm"
                  onClick={() => setShowVideoModal(false)}
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
