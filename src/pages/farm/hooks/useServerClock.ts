/**
 * The client's estimate of the SERVER clock.
 *
 * Every countdown on the farm is `ends_at − now`, where `ends_at` came from the
 * server. Using the phone's own clock for `now` would show a print "done" a
 * minute before the server agrees, or a minute after. So every response's
 * `now` field is recorded against `Date.now()` and the offset is applied to
 * every local tick. The tick itself runs once a second, only while the page is
 * visible, and decides nothing: when a countdown reaches zero the caller asks
 * the server what actually happened.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ServerClock {
  /** Estimated server time, ms since epoch, updated once a second while visible. */
  now: number;
  /** Record a server `now` (ISO) from a fresh response. */
  sync: (serverIso: string) => void;
}

export function useServerClock(): ServerClock {
  const offsetRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  const sync = useCallback((serverIso: string) => {
    const t = new Date(serverIso).getTime();
    if (Number.isNaN(t)) return;
    offsetRef.current = t - Date.now();
    setNow(Date.now() + offsetRef.current);
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => setNow(Date.now() + offsetRef.current), 1000);
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now() + offsetRef.current);
        start();
      } else stop();
    };
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return { now, sync };
}
