import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Mount nearby sections immediately, including an owner-reordered section
 * above the fold. Farther sections wait for the first screen to paint; then
 * all content mounts automatically, including for non-visual navigation. */
export default function DeferredHomeSection({ ready, fallback, children }: {
  ready: boolean; fallback: ReactNode; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || ready || near) return;
    const box = node.getBoundingClientRect();
    if (box.top < window.innerHeight + 200 && box.bottom > -200) { setNear(true); return; }
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: '200px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ready, near]);
  return <div ref={ref} data-home-deferred={ready || near ? 'ready' : 'waiting'}>{ready || near ? children : fallback}</div>;
}
