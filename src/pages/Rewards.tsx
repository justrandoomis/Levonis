import React, { useState, useEffect } from 'react';
import { ChevronLeft, Bell, PlayCircle, Paperclip, Check, Star, ShoppingBag } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../WalletContext';

export default function Rewards() {
  const navigate = useNavigate();
  const { pointBalance, pointTransactions, addReward, adVideoUrl } = useWallet();
  const [streak, setStreak] = useState(0);
  const [lastCheckIn, setLastCheckIn] = useState('');
  const [isPro, setIsPro] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [loadingMission, setLoadingMission] = useState<string | null>(null);
  const [showVideoModal, setShowVideoModal] = useState(false);
  const [isVideoFinished, setIsVideoFinished] = useState(false);
      const [pushEarned, setPushEarned] = useState(() => !!localStorage.getItem('levo_push_earned'));
  const [videoEarned, setVideoEarned] = useState(() => !!localStorage.getItem('levo_video_earned_' + new Date().toISOString().split('T')[0]));
  const [browseEarned, setBrowseEarned] = useState(() => !!localStorage.getItem('levo_browse_earned_' + new Date().toISOString().split('T')[0]));

  const getBaghdadDate = (offsetDays = 0) => {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  };

  const todayStr = getBaghdadDate(0);
  const yesterdayStr = getBaghdadDate(-1);

  useEffect(() => {
    const storedStreak = parseInt(localStorage.getItem('levo_streak') || '0', 10);
    const storedLastCheckIn = localStorage.getItem('levo_last_checkin') || '';
    const storedPro = localStorage.getItem('levo_is_pro') === 'true';
    // const storedBalance removed
    
    
    setStreak(storedStreak);
    setLastCheckIn(storedLastCheckIn);
    setIsPro(storedPro);
    
    setHasLoaded(true);
  }, []);





  let currentStreak = streak;
  if (lastCheckIn !== todayStr && lastCheckIn !== yesterdayStr && lastCheckIn !== '') {
    currentStreak = 0;
  }

  const isCheckedInToday = lastCheckIn === todayStr;
  const currentDay = currentStreak + (isCheckedInToday ? 0 : 1);

  const getPointsForDay = (day) => {
    let pts = 20;
    if (day === 1 || day === 2) pts = 5;
    else if (day === 3 || day === 4) pts = 10;
    else if (day === 5 || day === 6) pts = 15;
    else pts = 20;
    return isPro ? pts * 2 : pts;
  };

  const handleCheckIn = async () => {
    if (isCheckedInToday || !hasLoaded || isCheckingIn) return;
    setIsCheckingIn(true);
    // simulate network
    await new Promise(r => setTimeout(r, 800));
    const newStreak = currentStreak + 1;
    const pointsEarned = getPointsForDay(newStreak);
    
    setStreak(newStreak);
    setLastCheckIn(todayStr);
    
    localStorage.setItem('levo_streak', newStreak.toString());
    localStorage.setItem('levo_last_checkin', todayStr);
    
    try {
      await addReward(pointsEarned, `Daily Check-in (Day ${newStreak})`);
    } catch (e) {
      console.error(e);
    } finally {
      setIsCheckingIn(false);
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

  return (
    <div className="w-full bg-black min-h-screen font-sans flex flex-col text-white pb-24 overflow-y-auto relative">
      <div 
        className="absolute top-0 left-0 w-full h-[800px] pointer-events-none" 
        style={{ 
          background: 'linear-gradient(to bottom, #0A1F18 0%, #0F2F25 40%, black 100%)', 
          opacity: 0.8
        }}
      ></div>
      <div 
        className="absolute top-0 left-0 w-full h-96 opacity-[0.15] pointer-events-none mix-blend-multiply" 
        style={{ 
          backgroundImage: 'radial-gradient(#ffffff 1.5px, transparent 1.5px)', 
          backgroundSize: '16px 16px', 
          maskImage: 'linear-gradient(to bottom, black, transparent)', 
          WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)' 
        }}
      ></div>

      {/* Header */}
      <div className="flex items-center px-4 py-4 sticky top-0 z-10 relative">
        <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-white/10 transition-colors">
          <ChevronLeft className="w-6 h-6 text-gold" strokeWidth={2.5} />
        </button>
        <h1 className="text-[17px] font-bold text-center flex-1">Rewards</h1>
        <button onClick={() => {
           const newPro = !isPro;
           setIsPro(newPro);
           localStorage.setItem('levo_is_pro', newPro.toString());
        }} className={`p-1 px-3 text-[12px] font-bold rounded-full transition-colors ${isPro ? 'bg-gold text-[#0A1F18]' : 'bg-white/10 text-white/50'}`}>
          PRO
        </button>
      </div>

      <div className="px-5 relative z-10 mt-2">
        {/* Balance Section */}
        <div className="flex justify-between items-center mb-8 relative">
          <div className="pt-2">
            <div className="text-[14px] text-gold/60 mb-0.5 font-medium">My Balance</div>
            <div className="text-[56px] leading-[1.1] font-black tracking-tight">{pointBalance.toLocaleString()}</div>
          </div>
          <div className="relative right-2">
            {/* 3D Coin */}
            <div className="w-24 h-24 rounded-full relative z-10 transform -rotate-12">
              <div className="absolute inset-0 rounded-full bg-[#8A784B] transform translate-x-[3px] translate-y-[4px]"></div>
              <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-[#BAA369] to-[#ffe55c] border-[4px] border-[#ffe55c] flex items-center justify-center shadow-[inset_-3px_-3px_12px_rgba(0,0,0,0.15)]">
                <div className="text-[#0A1F18] drop-shadow-[1px_2px_2px_rgba(0,0,0,0.25)] relative top-[-1px]">
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
          <div className="absolute inset-0 bg-gradient-to-br from-[#0F2F25] to-[#184235] rounded-[28px] transform -rotate-[2deg] translate-y-1 -translate-x-1 shadow-sm"></div>
          
          {/* Main Card */}
          <div className="bg-[#0A1F18] rounded-[24px] p-4 shadow-[0_8px_30px_rgba(0,0,0,0.06)] relative z-10">
            {/* Perforated Edge */}
            <div className="absolute top-5 bottom-5 left-2 flex flex-col justify-between opacity-50">
              {[...Array(12)].map((_, i) => (
                <div key={i} className="w-1.5 h-1.5 rounded-full bg-black/50 shadow-inner"></div>
              ))}
            </div>

            <div className="absolute -top-3 right-3 text-white/40 transform rotate-[30deg] z-20 drop-shadow-md">
              <Paperclip className="w-6 h-6" strokeWidth={1.5} />
            </div>
            
            <div className="pl-3">
              <h2 className="text-[16px] font-bold mb-4 flex items-center gap-1.5">
                You've checked in for {currentStreak} Day{currentStreak !== 1 ? 's' : ''} <span className="w-[14px] h-[14px] rounded-full border-[1.5px] border-white/20 flex items-center justify-center text-[9px] text-white/40 font-bold">?</span>
              </h2>

              <div className="flex justify-between mb-5 overflow-x-auto pb-2 pt-1 -mx-1 px-1 hide-scrollbar items-end gap-1">
                {days.map((d, i) => (
                  <div key={i} className={`flex flex-col items-center flex-shrink-0 relative ${
                    d.status === 'today' ? 'w-[48px] pb-1.5 border border-gold rounded-[14px] shadow-[0_4px_12px_rgba(186,163,105,0.15)] bg-[#184235] transform -translate-y-1 overflow-hidden animate-day-pop' :
                    d.status === 'checked' ? 'w-[42px] pt-1 pb-1.5 bg-gradient-to-b from-[#0F2F25] to-[#184235] rounded-[14px]' :
                    'w-[42px] pt-1 pb-1.5 bg-[#0F2F25] rounded-[14px]'
                  } ${d.status === 'missed' ? 'opacity-60 bg-black/20' : ''}`}>
                    {d.status === 'today' ? (
                       <div className="w-full bg-gold text-[#0A1F18] text-[9px] font-bold text-center py-1 mb-1.5 tracking-wide">
                         Today
                       </div>
                    ) : (
                       <span className={`text-[10px] font-bold tracking-tight mb-1.5 ${
                         d.status === 'checked' ? 'text-gold' : 'text-white/40'
                       }`}>
                         Day {d.day}
                       </span>
                    )}
                    
                    <div className="flex items-center justify-center mb-1 h-[24px]">
                      {d.status === 'checked' ? (
                        <div className="w-[20px] h-[20px] bg-gold rounded-full flex items-center justify-center shadow-sm">
                          <Check className="w-3.5 h-3.5 text-[#0A1F18]" strokeWidth={4} />
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
                        <svg viewBox="0 0 24 24" fill={d.status === 'missed' ? '#333333' : '#BAA369'} className="w-[20px] h-[20px]">
                           <circle cx="12" cy="12" r="10" />
                           <path d="M12 6C12 8.5 15.5 11 18 11C15.5 11 12 13.5 12 16C12 13.5 8.5 11 6 11C8.5 11 12 8.5 12 6Z" fill="white"/>
                        </svg>
                      )}
                    </div>
                    
                    <span className={`text-[11px] font-bold ${
                      d.status === 'today' || (d.day % 7 === 0 && d.status === 'upcoming') ? 'text-white' : 
                      d.status === 'checked' ? 'text-gold' : 
                      'text-white/40'
                    }`}>{d.points}</span>
                  </div>
                ))}
              </div>

              <button 
                onClick={handleCheckIn}
                disabled={isCheckedInToday || isCheckingIn}
                className={`w-full py-3.5 rounded-[20px] font-bold text-[15px] transition-all active:scale-[0.98]
                ${isCheckedInToday ? 'bg-[#0F2F25] text-white/40' : 'bg-gold text-[#0A1F18]'}`}>
                {isCheckingIn ? <div className="w-5 h-5 border-2 border-[#0A1F18]/20 border-t-[#0A1F18] rounded-full animate-spin mx-auto" /> : (isCheckedInToday ? 'Checked in' : 'Check in')}
              </button>
            </div>
          </div>
        </div>


        {/* Earn Rewards Section */}
        <div className="mt-8 mb-8">
          <h2 className="text-[17px] font-bold mb-4 px-1 text-white">Earn Points</h2>
          <div className="space-y-3 px-1">
            {pushEarned && videoEarned && browseEarned && <div className="text-white/40 text-center py-4 text-sm">You're all caught up for today!</div>}
            
            {!pushEarned && (
            <div className="bg-[#0F2F25] rounded-[20px] p-4 flex items-center justify-between shadow-sm cursor-pointer hover:bg-[#184235] transition-colors"
                 onClick={async () => {
                   if (loadingMission) return;
                   const earned = localStorage.getItem('levo_push_earned');
                   if (earned) {
                     alert('You have already claimed this reward.');
                     return;
                   }
                   setLoadingMission('push');
                   try {
                     if (!('Notification' in window)) {
                       alert('Push notifications are not supported in this browser.');
                       setLoadingMission(null);
                       return;
                     }
                     const permission = await Notification.requestPermission();
                     if (permission === 'granted') {
                       await addReward(50, 'Enabled Push Notifications');
                       localStorage.setItem('levo_push_earned', 'true');
                       setPushEarned(true);
                       alert('You have successfully enabled push notifications and earned 50 pts!');
                     } else {
                       alert('You must allow notifications to earn this reward.');
                     }
                   } catch (e) {
                     console.error(e);
                     alert('Failed to request notification permission.');
                   } finally {
                     setLoadingMission(null);
                   }
                 }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                  {loadingMission === 'push' ? <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" /> : <Bell className="w-5 h-5 text-gold" fill="currentColor" />}
                </div>
                <div>
                  <h4 className="text-white font-bold text-[14px]">Enable Notifications</h4>
                  <span className="text-white/40 font-medium text-[12px]">Stay updated</span>
                </div>
              </div>
              <div className="text-gold font-bold text-[16px]">
                +50 pts
              </div>
            </div>
            )}
            
            {!videoEarned && (
            <div className="bg-[#0F2F25] rounded-[20px] p-4 flex items-center justify-between shadow-sm cursor-pointer hover:bg-[#184235] transition-colors"
                 onClick={() => {
                   if (loadingMission) return;
                   const today = new Date().toISOString().split('T')[0];
                   const earned = localStorage.getItem('levo_video_earned_' + today);
                   if (earned) {
                     alert('You have already claimed this daily reward.');
                     return;
                   }
                   if (!adVideoUrl) {
                     alert('No ad video available today. Please check back later.');
                     return;
                   }
                   setIsVideoFinished(false);
                   setShowVideoModal(true);
                 }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                  {loadingMission === 'video' ? <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" /> : <PlayCircle className="w-5 h-5 text-gold" fill="currentColor" />}
                </div>
                <div>
                  <h4 className="text-white font-bold text-[14px]">Watch Ad</h4>
                  <span className="text-white/40 font-medium text-[12px]">Daily reward</span>
                </div>
              </div>
              <div className="text-gold font-bold text-[16px]">
                +20 pts
              </div>
            </div>
            )}

            {!browseEarned && (
            <div className="bg-[#0F2F25] rounded-[20px] p-4 flex items-center justify-between shadow-sm cursor-pointer hover:bg-[#184235] transition-colors"
                 onClick={() => {
                   if (loadingMission) return;
                   const today = new Date().toISOString().split('T')[0];
                   const earned = localStorage.getItem('levo_browse_earned_' + today);
                   if (earned) {
                     alert('You have already claimed this daily reward.');
                     return;
                   }
                   
                   // Start timer
                   const savedProgress = localStorage.getItem('levo_browse_progress_' + today);
                   if (!savedProgress) {
                     localStorage.setItem('levo_browse_progress_' + today, '0');
                   }
                   window.dispatchEvent(new Event('levo_mission_start'));
                   alert('Mission started! Browse our products for 3 minutes, then the reward will be automatically added. Timer pauses if inactive!');
                   navigate('/');
                 }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                  {loadingMission === 'browse' ? <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" /> : <ShoppingBag className="w-5 h-5 text-gold" fill="currentColor" />}
                </div>
                <div>
                  <h4 className="text-white font-bold text-[14px]">Browse Products</h4>
                  <span className="text-white/40 font-medium text-[12px]">3 mins • Daily reward</span>
                </div>
              </div>
              <div className="text-gold font-bold text-[16px]">
                +20 pts
              </div>
            </div>
            )}
          </div>
        </div>

        {/* Points History Section */}
        <div className="mt-8 mb-8">
          <h2 className="text-[17px] font-bold mb-4 px-1 text-white">Points History</h2>
          <div className="space-y-3 px-1">
            {pointTransactions.length === 0 && (
              <div className="text-white/40 text-center py-4 text-sm">No recent activity</div>
            )}
            {pointTransactions.slice(0, 10).map((tx, i) => (
              <div key={tx.id || i} className="bg-[#0F2F25] rounded-[20px] p-4 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                    <Star className="w-5 h-5 text-gold" fill="currentColor" />
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-[14px] capitalize">{tx.note || 'Points Earned'}</h4>
                    <span className="text-white/40 font-medium text-[12px]">{new Date(tx.date).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="text-gold font-bold text-[16px]">
                  +{tx.amount} pts
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>


      {/* Video Modal */}
      {showVideoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm">
          <div className="bg-[#0A1F18] w-full max-w-md rounded-3xl p-6 border border-[#184235] shadow-2xl relative flex flex-col items-center">
            <h3 className="text-white font-bold text-lg mb-2">Watch Video to Earn</h3>
            <p className="text-white/50 text-sm text-center mb-6">Please watch the entire video to receive your points.</p>
            
            <div className="w-full aspect-video bg-black rounded-xl mb-6 relative overflow-hidden flex items-center justify-center border border-white/5">
              <video 
                src={adVideoUrl || undefined} 
                autoPlay 
                controls={false}
                playsInline
                className="w-full h-full object-contain"
                onEnded={() => setIsVideoFinished(true)}
              />
            </div>
            
            {isVideoFinished ? (
              <button 
                className="w-full py-3.5 rounded-xl font-bold bg-gold text-[#0A1F18] hover:bg-gold/90 transition-colors"
                onClick={async () => {
                  try {
                    setLoadingMission('video_claim');
                    await addReward(20, 'Watched Ad');
                    localStorage.setItem('levo_video_earned_' + new Date().toISOString().split('T')[0], 'true');
                    setVideoEarned(true);
                    alert('You successfully watched the ad and earned 20 pts!');
                  } catch(e) {
                    console.error(e);
                  } finally {
                    setLoadingMission(null);
                    setShowVideoModal(false);
                  }
                }}
              >
                {loadingMission === 'video_claim' ? 'Claiming...' : 'Claim 20 pts'}
              </button>
            ) : (
              <div className="w-full flex items-center justify-between">
                <span className="text-gold font-bold text-sm">Video is playing...</span>
                <button 
                  className="px-4 py-2 rounded-lg font-bold text-white/50 hover:text-white hover:bg-white/10 transition-colors text-sm"
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
