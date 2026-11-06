import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useWallet } from '../WalletContext';
import { useLanguage } from '../LanguageContext';
import { api } from '../lib/api';
import { toast } from '../lib/toastStore';
import {
  CLOCK_HIDDEN,
  browseAwardText,
  clockText,
  createBrowseClock,
  type BrowsePing,
  type BrowseView,
  type ClockState,
} from '../lib/browseMissionClock';

/**
 * Server-driven browse-mission clock. The server tracks and credits the elapsed
 * time via /api/rewards/browse/ping; this only displays the progress and stops
 * pinging when the tab is hidden or the customer idle. The whole logic is
 * src/lib/browseMissionClock.ts, which says why it shows and how it was broken.
 *
 * In the shop's language, above the bottom nav and clear of the cart's summary
 * bar (`.lv-browse-clock`, src/index.css), and on the reading end of the screen.
 */
export default function BrowseMissionTimer() {
  const { isAuthenticated } = useAuth();
  const { refreshWallet } = useWallet();
  const { loc } = useLanguage();
  const [state, setState] = useState<ClockState>(CLOCK_HIDDEN);

  // The clock outlives a language change or a new wallet callback: it reads the current ones.
  const latest = useRef({ loc, refreshWallet });
  useEffect(() => {
    latest.current = { loc, refreshWallet };
  }, [loc, refreshWallet]);

  useEffect(() => {
    if (!isAuthenticated) {
      setState(CLOCK_HIDDEN);
      return;
    }
    const clock = createBrowseClock({
      read: async () => (await api.get<{ missions: { browse: BrowseView } }>('/api/rewards')).missions.browse,
      ping: () => api.post<BrowsePing>('/api/rewards/browse/ping'),
      isHidden: () => document.hidden,
      onChange: setState,
      onAward: (reply) => {
        toast.success(browseAwardText(reply, latest.current.loc));
        void latest.current.refreshWallet();
      },
    });
    void clock.sync();

    const handleStart = () => void clock.sync(true);
    const handleActivity = () => clock.activity();
    // CAPTURE, because the page scrolls inside #main-scroll-container and a scroll
    // does not bubble to the window: a customer scrolling the shop read as idle.
    const options = { capture: true, passive: true } as const;
    const events = ['pointerdown', 'pointermove', 'touchmove', 'wheel', 'scroll', 'keydown', 'click'] as const;
    window.addEventListener('levo_mission_start', handleStart);
    for (const name of events) window.addEventListener(name, handleActivity, options);
    return () => {
      window.removeEventListener('levo_mission_start', handleStart);
      for (const name of events) window.removeEventListener(name, handleActivity, options);
      clock.stop();
      setState(CLOCK_HIDDEN);
    };
  }, [isAuthenticated]);

  if (!isAuthenticated || !state.visible) return null;

  return (
    <div
      data-browse-clock
      role="timer"
      aria-label={loc('وقت مهمة التصفّح', 'Browse mission time', 'کاتی ئەرکی گەڕان')}
      className="lv-browse-clock fixed end-4 z-50"
    >
      {/* Opaque even when paused, and only its words go quiet: at reduced opacity
          the page's own text showed through and neither could be read. */}
      <div className="lv-surface-raised rounded-full px-4 py-2 flex items-center gap-2">
        <Clock aria-hidden="true" className={`w-4 h-4 ${state.paused ? 'text-text-muted' : 'text-gold animate-pulse'}`} />
        <span dir="ltr" className={`font-mono font-bold text-sm tabular-nums ${state.paused ? 'text-text-secondary' : 'text-text-primary'}`}>
          {clockText(state)}
        </span>
        {state.paused && (
          <span className="text-[10px] text-text-secondary font-medium">
            {loc('متوقف — لا نشاط', 'Paused — inactive', 'وەستاوە — بێ چالاکی')}
          </span>
        )}
      </div>
    </div>
  );
}
