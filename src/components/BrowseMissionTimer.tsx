import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';
import { Clock } from 'lucide-react';

const PING_INTERVAL_MS = 15_000;
const IDLE_LIMIT_MS = 30_000;

/**
 * Server-driven browse-mission timer. The server tracks and credits the
 * elapsed time via /api/rewards/browse/ping; this component only displays
 * the progress and pauses pinging when the tab is hidden or the user idle.
 */
export default function BrowseMissionTimer() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const [active, setActive] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [requiredSeconds, setRequiredSeconds] = useState(180);
  const [isPaused, setIsPaused] = useState(false);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneRef = useRef(false);

  const checkMissionStatus = useCallback(async (startedNow: boolean) => {
    if (!isAuthenticated) {
      setActive(false);
      return;
    }
    try {
      const res = await api.get<{
        missions: { browse: { claimed: boolean; required_seconds: number; progress_seconds: number } };
      }>('/api/rewards');
      const browse = res.missions.browse;
      if (browse.claimed) {
        setActive(false);
        return;
      }
      setRequiredSeconds(browse.required_seconds);
      setSeconds(browse.progress_seconds);
      // Show the timer when the mission was just started, or when there is
      // real in-progress time recorded on the server.
      if (startedNow || browse.progress_seconds > 0) {
        doneRef.current = false;
        setActive(true);
      }
    } catch {
      /* not signed in or transient failure — keep the timer hidden */
    }
  }, [isAuthenticated]);

  useEffect(() => {
    checkMissionStatus(false);
    const handleStart = () => checkMissionStatus(true);
    window.addEventListener('levo_mission_start', handleStart);
    return () => {
      window.removeEventListener('levo_mission_start', handleStart);
    };
  }, [checkMissionStatus]);

  useEffect(() => {
    if (!isAuthenticated) setActive(false);
  }, [isAuthenticated]);

  // Activity / idle tracking — pause after 30s without user activity.
  useEffect(() => {
    if (!active) return;

    const resetIdleTimer = () => {
      setIsPaused(false);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        setIsPaused(true);
      }, IDLE_LIMIT_MS);
    };

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
  }, [active]);

  // Server pings every 15s while visible and not idle.
  useEffect(() => {
    if (!active) return;

    const ping = async () => {
      if (document.hidden || isPaused || doneRef.current) return;
      try {
        const res = await api.post<{ done: boolean; seconds: number }>('/api/rewards/browse/ping');
        setSeconds(res.seconds);
        if (res.done && !doneRef.current) {
          doneRef.current = true;
          setActive(false);
          alert('Congratulations! You completed the browse mission and earned your points.');
          navigate('/points');
        }
      } catch {
        // Session missing (not started / new day) — hide rather than pretend.
        setActive(false);
      }
    };

    const interval = setInterval(ping, PING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active, isPaused, navigate]);

  // Smooth local display tick between pings (display only — the server
  // remains the source of truth and re-syncs on every ping).
  useEffect(() => {
    if (!active || isPaused) return;
    const tick = setInterval(() => {
      if (document.hidden) return;
      setSeconds((prev) => Math.min(prev + 1, requiredSeconds));
    }, 1000);
    return () => clearInterval(tick);
  }, [active, isPaused, requiredSeconds]);

  if (!isAuthenticated || !active) return null;

  const timeLeft = Math.max(0, requiredSeconds - seconds);
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
