import { useEffect, useState } from 'react';

/**
 * Has `el` scrolled up and out from under the 56 px top bar?
 * The category page fades its title into the bar at that moment (§6 item 1).
 * One IntersectionObserver, no scroll handler; the answer is false until the
 * element exists. Pass the element itself (a callback-ref state), so the
 * observer starts when a page's skeleton is replaced by the real hero.
 */
export function useScrolledPast(el: Element | null, topInset = 56): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') {
      setPast(false);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setPast(!entry.isIntersecting && entry.boundingClientRect.top < topInset),
      { rootMargin: `-${topInset}px 0px 0px 0px`, threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, topInset]);
  return past;
}
