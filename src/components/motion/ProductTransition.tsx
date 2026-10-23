// Lucian UX/UI Prompt #328 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#328
import React, { useLayoutEffect, useRef } from 'react';
import { Link, useLocation, type LinkProps } from 'react-router-dom';

type Picture = { rect: DOMRect; copy: HTMLElement };
type Journey = { href: string; origin: string; photo: Picture; title?: Picture; at: number; returning?: boolean };
let journey: Journey | null = null;
const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const take = (el: HTMLElement | null): Picture | undefined => {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.top > innerHeight) return;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.removeAttribute('id');
  copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  return { rect, copy };
};

function fly(from: Picture, target: HTMLElement) {
  const to = target.getBoundingClientRect();
  if (reduce() || !target.animate || to.width < 4 || to.height < 4) return () => {};
  const { copy, rect } = from;
  Object.assign(copy.style, { position: 'fixed', left: `${to.x}px`, top: `${to.y}px`, width: `${to.width}px`, height: `${to.height}px`, margin: '0', zIndex: '60', pointerEvents: 'none', transformOrigin: '0 0', overflow: 'hidden' });
  document.body.appendChild(copy);
  const motion = copy.animate([
    { transform: `translate(${rect.x - to.x}px,${rect.y - to.y}px) scale(${rect.width / to.width},${rect.height / to.height})`, borderRadius: '20px' },
    { transform: 'none', borderRadius: getComputedStyle(target).borderRadius },
  ], { duration: 560, easing: 'cubic-bezier(.3,1.05,.35,1)' });
  const hidden = target.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 560 });
  const cleanup = () => { motion.cancel(); hidden.cancel(); copy.remove(); };
  motion.onfinish = cleanup;
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', cleanup, { once: true });
  motion.finished.catch(() => {}).finally(() => mq.removeEventListener('change', cleanup));
  return cleanup;
}

/** A normal router link: modifiers, new tabs, copied URLs and keyboard navigation keep their behavior. */
export function ProductTransitionLink({ onClick, ...props }: LinkProps) {
  const ref = useRef<HTMLAnchorElement>(null);
  const location = useLocation();
  const origin = location.pathname + location.search;
  useLayoutEffect(() => {
    if (!journey?.returning || journey.origin !== origin || journey.href !== props.to) return;
    const saved = journey;
    let cleanup: (() => void) | undefined;
    // The shell restores scroll on Back before the next frame.
    const frame = requestAnimationFrame(() => {
      const card = ref.current?.closest<HTMLElement>('[data-product-id]');
      const photo = card?.querySelector<HTMLElement>('[data-motion-photo]');
      if (journey !== saved || !photo || Date.now() - saved.at >= 10_000) return;
      const rect = photo.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) return;
      journey = null;
      cleanup = fly(saved.photo, photo);
      ref.current?.focus({ preventScroll: true });
    });
    return () => { cancelAnimationFrame(frame); cleanup?.(); };
  }, [origin, props.to]);
  return <Link {...props} ref={ref} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.detail === 0 || reduce() || (props.target && props.target !== '_self')) return;
    if (typeof props.to !== 'string' || !props.to.startsWith('/product/')) return;
    const card = event.currentTarget.closest<HTMLElement>('[data-product-id]');
    const photo = take(card?.querySelector<HTMLElement>('[data-motion-photo]') ?? null);
    if (photo) journey = { href: props.to, origin, photo, title: take(card?.querySelector('h3') ?? null), at: Date.now() };
  }} />;
}

/** Called once the real product has rendered; route/data loading is never delayed for motion. */
export function useProductEntrance(hero: React.RefObject<HTMLDivElement | null>, ready: boolean) {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    const el = hero.current;
    if (!ready || !el || !journey || journey.href.split('?')[0] !== pathname || journey.returning || Date.now() - journey.at > 10_000) return;
    const saved = journey;
    const cleanups: Array<() => void> = [];
    let started = false;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => cleanups.forEach((cleanup) => cleanup());
    mq.addEventListener('change', stop);
    // StrictMode may replay the effect before this frame: do not consume the journey until it runs.
    const frame = requestAnimationFrame(() => {
      if (journey !== saved) return;
      journey = null;
      started = true;
      cleanups.push(fly(saved.photo, el));
      // Desktop shows the buy-column copy while the semantic h1 is visually hidden.
      const title = Array.from(document.querySelectorAll<HTMLElement>('h1,[data-product-buy-identity] > p:first-child'))
        .find((heading) => heading.getBoundingClientRect().width > 4);
      if (saved.title && title) cleanups.push(fly(saved.title, title));
      if (!reduce()) document.querySelector('[data-product-detail]')?.querySelectorAll<HTMLElement>(':scope > *').forEach((child, index) => {
        if (index === 0 || index > 3 || !child.animate) return;
        const animation = child.animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { duration: 600, delay: 560 + (index - 1) * 60, easing: 'cubic-bezier(.34,1.45,.64,1)', fill: 'backwards' });
        cleanups.push(() => animation.cancel());
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      mq.removeEventListener('change', stop);
      stop();
      if (!started) return;
      const photo = take(el);
      if (photo && !reduce()) journey = { ...saved, photo, title: undefined, at: Date.now(), returning: true };
    };
  }, [ready, pathname, hero]);
}
