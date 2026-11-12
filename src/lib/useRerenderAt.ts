/**
 * RENDER AGAIN ONCE A KNOWN INSTANT HAS PASSED — for words a screen draws from
 * the wall clock while it renders (DECISIONS row 324, the review).
 *
 * The checkout's courier note says «أتمم طلبك قبل الساعة ٧ مساءً ليُسلَّم …
 * اليوم» until the handover and «فات تسليم اليوم …» after it, and «غدًا»
 * becomes «اليوم» at Baghdad's midnight. The caller reads `Date.now()` WHILE
 * RENDERING — as the delivery-day picker beside it reads its «today» — and
 * hands this hook the next instant its words change. The hook only makes sure
 * a render happens once that instant is behind us. It holds no clock of its
 * own: a clock kept in state is the defect it replaces (a page opened at 18:40
 * and woken at 20:15 kept promising tonight's handover, through re-renders).
 *
 *   - A TIMER for the instant, plus a second — and RE-ARMED rather than trusted:
 *     one that fires while the wall clock still reads before the instant (the
 *     clock stepped back) waits again instead of rendering the same words.
 *   - THE PAGE COMING BACK: `visibilitychange` to visible, `focus`, `pageshow`
 *     (a bfcache restore). Timer delays run on a clock that stops while a phone
 *     sleeps and while a tab is frozen, so the timer alone can be late by the
 *     whole sleep. On a wake the instant is checked against the wall clock: past
 *     it, the page renders now; before it, the timer is re-armed from the wall
 *     clock, so a short sleep does not push the change late either.
 *
 * `null` arms nothing. One render per instant, never one per wake.
 */
import { useEffect, useReducer } from 'react';

export function useRerenderAt(atMs: number | null): void {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (atMs === null) return;
    let timer: number | undefined;
    const check = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      const wait = atMs - Date.now();
      // At or past the instant (19:00:00 is already «after 7 pm»): render, and
      // the caller hands back the next instant. The same instant handed back
      // re-runs nothing, so this cannot loop.
      if (wait <= 0) {
        rerender();
        return;
      }
      timer = window.setTimeout(check, Math.max(1_000, wait + 1_000));
    };
    const onWake = () => {
      if (document.visibilityState === 'visible') check();
    };
    check();
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('pageshow', onWake);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('pageshow', onWake);
    };
  }, [atMs]);
}
