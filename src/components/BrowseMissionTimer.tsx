import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWallet } from '../WalletContext';
import { Clock } from 'lucide-react';

export default function BrowseMissionTimer() {
  const location = useLocation();
  const navigate = useNavigate();
  const { addReward } = useWallet();
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const idleTimerRef = useRef<any>(null);
  const countdownIntervalRef = useRef<any>(null);
  
  const REQUIRED_SECS = 3 * 60; // 3 minutes

  const checkMissionStatus = () => {
    const today = new Date().toISOString().split('T')[0];
    const earned = localStorage.getItem('levo_browse_earned_' + today);
    if (earned) {
      setTimeLeft(null);
      return;
    }

    const savedProgress = localStorage.getItem('levo_browse_progress_' + today);
    if (savedProgress !== null) {
      const progress = parseInt(savedProgress, 10);
      if (progress < REQUIRED_SECS) {
        setTimeLeft(REQUIRED_SECS - progress);
      } else {
        setTimeLeft(0);
      }
    } else {
      setTimeLeft(null);
    }
  };

  useEffect(() => {
    checkMissionStatus();
    // Also listen to storage changes in case mission starts from Rewards
    const handleStorage = () => checkMissionStatus();
    window.addEventListener('storage', handleStorage);
    // Custom event
    window.addEventListener('levo_mission_start', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('levo_mission_start', handleStorage);
    };
  }, []);

  // Handle activity/idle
  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0) return;

    const resetIdleTimer = () => {
      setIsPaused(false);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        setIsPaused(true);
      }, 3000); // 3 seconds of inactivity pauses timer
    };

    // Attach listeners
    window.addEventListener('mousemove', resetIdleTimer);
    window.addEventListener('touchmove', resetIdleTimer);
    window.addEventListener('scroll', resetIdleTimer);
    window.addEventListener('keydown', resetIdleTimer);
    window.addEventListener('click', resetIdleTimer);

    resetIdleTimer();

    return () => {
      window.removeEventListener('mousemove', resetIdleTimer);
      window.removeEventListener('touchmove', resetIdleTimer);
      window.removeEventListener('scroll', resetIdleTimer);
      window.removeEventListener('keydown', resetIdleTimer);
      window.removeEventListener('click', resetIdleTimer);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [timeLeft]);

  // Handle countdown
  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0 || isPaused) {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      return;
    }

    countdownIntervalRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(countdownIntervalRef.current);
          return 0;
        }
        
        // Save progress every second
        const today = new Date().toISOString().split('T')[0];
        const progress = REQUIRED_SECS - (prev - 1);
        localStorage.setItem('levo_browse_progress_' + today, progress.toString());
        
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [timeLeft, isPaused]);

  // When timer reaches 0
  useEffect(() => {
    if (timeLeft === 0) {
      const claimReward = async () => {
        try {
          const today = new Date().toISOString().split('T')[0];
          const earned = localStorage.getItem('levo_browse_earned_' + today);
          if (earned) return; // already claimed
          
          await addReward(20, 'Browsed Products for 3 Mins');
          localStorage.setItem('levo_browse_earned_' + today, 'true');
          alert('Congratulations! You earned 20 pts for browsing products.');
          setTimeLeft(null);
          navigate('/rewards');
        } catch (e) {
          console.error(e);
        }
      };
      claimReward();
    }
  }, [timeLeft, addReward, navigate]);

  if (timeLeft === null) return null;

  const mins = Math.floor(timeLeft / 60);
  const secs = timeLeft % 60;

  return (
    <div className={`fixed bottom-24 right-4 z-50 transition-all duration-300 ${isPaused ? 'opacity-50' : 'opacity-100'}`}>
      <div className="bg-zinc-900/90 backdrop-blur border border-gold/30 rounded-full px-4 py-2 flex items-center gap-2 shadow-lg shadow-gold/10">
        <Clock className={`w-4 h-4 text-gold ${isPaused ? '' : 'animate-pulse'}`} />
        <span className="text-white font-mono font-bold text-sm">
          {mins}:{secs.toString().padStart(2, '0')}
        </span>
        {isPaused && <span className="text-[10px] text-zinc-400 font-medium ml-1">Paused (Inactive)</span>}
      </div>
    </div>
  );
}
