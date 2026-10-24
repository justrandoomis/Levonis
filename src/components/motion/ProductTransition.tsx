// Lucian UX/UI Prompt #328 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#328
import React, { useLayoutEffect } from 'react';
import { Link, useLocation, type LinkProps } from 'react-router-dom';

type Box = { x: number; y: number; width: number; height: number };
type Picture = { rect: Box; plane: Box; url: string; width: number; height: number; background: string; radius: string };
type Journey = { href: string; origin: string; productId: string; photo: Picture; returning: boolean; cancel: () => void };
let journey: Journey | null = null;
const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const route = () => window.location.pathname + window.location.search;
const visible = (rect: Box) => rect.width > 4 && rect.height > 4 && rect.y + rect.height > 0 && rect.y < innerHeight;

/** The painted image, including cover crops, contain gutters and the card's top alignment. */
export function imagePlane(box: Box, width: number, height: number, fit: string, position: string, padding: number): Box {
  const w = Math.max(1, box.width - padding * 2), h = Math.max(1, box.height - padding * 2);
  const scale = fit === 'cover' ? Math.max(w / width, h / height) : Math.min(w / width, h / height);
  const drawnW = fit === 'fill' ? w : width * scale, drawnH = fit === 'fill' ? h : height * scale;
  const parts = position.split(' ');
  const offset = (value: string | undefined, space: number) => value?.endsWith('%') ? space * parseFloat(value) / 100 : Number.isFinite(parseFloat(value ?? '')) ? parseFloat(value!) : space / 2;
  return { x: box.x + padding + offset(parts[0], w - drawnW), y: box.y + padding + offset(parts[1], h - drawnH), width: drawnW, height: drawnH };
}

/** Freeze the already decoded candidate. Never clone SafeImage's skeleton, srcset or reveal layers. */
function take(el: HTMLElement, fallback?: Picture): Picture | undefined {
  const image = el.querySelector<HTMLImageElement>(fallback ? 'img[data-main-image]' : 'img[data-transition-picture],img[data-main-image]');
  if (!image || (!fallback && (!image.complete || !image.naturalWidth))) return;
  const rect = el.getBoundingClientRect();
  if (!visible(rect)) return;
  const css = getComputedStyle(image), surface = getComputedStyle(el);
  // Keep the pinned photo's ratio when the destination uses another crop.
  const width = fallback?.width ?? image.naturalWidth, height = fallback?.height ?? image.naturalHeight;
  return {
    rect, width, height, url: fallback?.url ?? (image.currentSrc || image.src),
    plane: imagePlane(image.getBoundingClientRect(), width, height, css.objectFit, css.objectPosition, parseFloat(css.paddingTop) || 0),
    background: surface.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'var(--color-surface)' : surface.backgroundColor,
    radius: surface.borderRadius,
  };
}

function targetPicture(target: HTMLElement, photo: Picture): Picture {
  const picture = take(target, photo);
  if (picture) return picture;
  const rect = target.getBoundingClientRect();
  const card = target.hasAttribute('data-motion-photo');
  return { ...photo, rect, plane: imagePlane(rect, photo.width, photo.height, card ? 'cover' : 'contain', target.closest('[data-product-card="compact"]') ? '50% 4%' : '50% 50%', card ? 0 : 12) };
}

function returnToCard(saved: Journey, photo?: Picture) {
  if (journey !== saved || saved.returning) return;
  saved.cancel();
  if (!photo || reduce()) { journey = null; return; }
  journey = { ...saved, photo, returning: true, cancel: () => {} };
  travel(journey);
}

/** One image survives the route, the data skeleton and the larger image's decode, in both directions. */
function travel(saved: Journey) {
  const layer = document.createElement('div'), image = document.createElement('img');
  layer.dataset.productTransition = saved.returning ? 'back' : 'open';
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
  image.dataset.transitionPicture = '';
  image.src = saved.photo.url;
  image.alt = '';
  image.referrerPolicy = 'no-referrer';
  image.draggable = false;
  Object.assign(layer.style, { position: 'fixed', margin: '0', zIndex: '60', pointerEvents: 'none', transformOrigin: '0 0', overflow: 'hidden' });
  Object.assign(image.style, { position: 'absolute', maxWidth: 'none', maxHeight: 'none', margin: '0', padding: '0', objectFit: 'fill', transformOrigin: '0 0' });
  layer.appendChild(image);

  let current = saved.photo, target: HTMLElement | null = null, finished = false, disposed = false;
  let frame = 0, nextFrame = 0, seenDestination = false, armed = false;
  let animations: Animation[] = [];
  const covered = new Map<HTMLImageElement, string>();
  const expected = saved.returning ? saved.origin : saved.href;
  const matches = () => saved.returning ? route() === expected : window.location.pathname === expected.split('?')[0];
  const place = (photo: Picture, docked = false) => {
    current = photo;
    Object.assign(layer.style, { position: docked ? 'absolute' : 'fixed', left: `${docked ? 0 : photo.rect.x}px`, top: `${docked ? 0 : photo.rect.y}px`, width: `${photo.rect.width}px`, height: `${photo.rect.height}px`, background: photo.background, borderRadius: photo.radius });
    Object.assign(image.style, { left: `${photo.plane.x - photo.rect.x}px`, top: `${photo.plane.y - photo.rect.y}px`, width: `${photo.plane.width}px`, height: `${photo.plane.height}px` });
  };
  place(current);
  document.body.appendChild(layer);

  const observer = new MutationObserver(() => schedule());
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame); cancelAnimationFrame(nextFrame);
    clearTimeout(timeout);
    observer.disconnect();
    mq.removeEventListener('change', cleanup);
    window.removeEventListener('resize', settle);
    document.removeEventListener('scroll', settle, true);
    animations.forEach((animation) => animation.cancel());
    covered.forEach((visibility, photo) => { photo.style.visibility = visibility; });
    layer.remove();
  };
  saved.cancel = cleanup;
  const settledImage = () => {
    const actual = target?.querySelector<HTMLImageElement>('img[data-main-image]');
    return actual?.closest('[data-image-state]')?.getAttribute('data-image-state') === 'error'
      || !!(actual?.complete && actual.naturalWidth && actual.closest('[data-image-state="loaded"]'))
      || !!target?.querySelector('[data-image-state="error"]');
  };
  const finish = () => {
    if (!finished || !settledImage()) return;
    cleanup();
    if (saved.returning && journey === saved) journey = null;
  };
  function settle() {
    if (disposed || !target?.isConnected) return;
    animations.forEach((animation) => animation.cancel());
    animations = [];
    place(targetPicture(target, saved.photo), true);
    target.appendChild(layer);
    finished = true;
    finish();
  }
  function update() {
    frame = 0;
    if (disposed || journey !== saved) return;
    if (!matches()) {
      if (!seenDestination && !saved.returning && route() === saved.origin) return;
      if (!saved.returning && route() === saved.origin) return returnToCard(saved, take(layer) ?? current);
      cleanup();
      if (journey === saved) journey = null;
      return;
    }
    seenDestination = true;
    const card = saved.returning ? Array.from(document.querySelectorAll<HTMLElement>('[data-product-id]')).find((el) => el.dataset.productId === saved.productId) : null;
    const next = saved.returning ? card?.querySelector<HTMLElement>('[data-motion-photo]') : document.querySelector<HTMLElement>('[data-gallery-hero],[data-product-gallery-placeholder]');
    if (!next || !visible(next.getBoundingClientRect())) return;
    // A cached destination must not appear as a second photo behind the flight.
    const actual = next.querySelector<HTMLImageElement>('img[data-main-image]');
    if (actual && !covered.has(actual)) { covered.set(actual, actual.style.visibility); actual.style.visibility = 'hidden'; }
    if (target === next) { finish(); return; }
    const previousTarget = target;
    target = next;
    if (finished) { settle(); return; }
    // A loading hero becoming the real hero uses the same flight, not a second entrance.
    if (previousTarget && animations.length) return;
    const to = targetPicture(next, saved.photo), from = take(layer) ?? current;
    const sx = from.rect.width / to.rect.width, sy = from.rect.height / to.rect.height;
    place(to);
    const css = getComputedStyle(document.documentElement);
    const timing = { duration: parseFloat(css.getPropertyValue('--duration-ui')) || 250, easing: css.getPropertyValue('--ease-move').trim() || 'cubic-bezier(0.77, 0, 0.175, 1)', fill: 'both' as const };
    if (!layer.animate || reduce()) { settle(); return; }
    animations = [
      layer.animate([{ transform: `translate(${from.rect.x - to.rect.x}px,${from.rect.y - to.rect.y}px) scale(${sx},${sy})` }, { transform: 'none' }], timing),
      image.animate([{ transform: `translate(${(from.plane.x - from.rect.x) / sx - (to.plane.x - to.rect.x)}px,${(from.plane.y - from.rect.y) / sy - (to.plane.y - to.rect.y)}px) scale(${from.plane.width / to.plane.width / sx},${from.plane.height / to.plane.height / sy})` }, { transform: 'none' }], timing),
    ];
    animations[0].onfinish = settle;
    if (saved.returning && card) (card.matches('a') ? card : card.querySelector<HTMLAnchorElement>('a[href]'))?.focus({ preventScroll: true });
  }
  function schedule() {
    if (armed && !frame && !disposed) frame = requestAnimationFrame(update);
  }
  const timeout = window.setTimeout(cleanup, 10_000);
  observer.observe(document.getElementById('main-scroll-container') ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-image-state'] });
  mq.addEventListener('change', cleanup);
  window.addEventListener('resize', settle);
  document.addEventListener('scroll', settle, true);
  // Scroll restoration gets its own frame before measuring the returning card.
  nextFrame = requestAnimationFrame(() => { nextFrame = requestAnimationFrame(() => { armed = true; schedule(); }); });
}

/** A normal link: keyboard, modifiers and new tabs retain normal navigation without a flight. */
export function ProductTransitionLink({ onClick, ...props }: LinkProps) {
  const location = useLocation();
  return <Link {...props} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || (props.target && props.target !== '_self')) return;
    if (typeof props.to !== 'string' || !props.to.startsWith('/product/')) return;
    journey?.cancel();
    journey = null;
    if (event.detail === 0 || reduce()) return;
    const card = event.currentTarget.closest<HTMLElement>('[data-product-id]');
    const el = card?.querySelector<HTMLElement>('[data-motion-photo]');
    const photo = el ? take(el) : undefined;
    if (!photo || !card) return;
    journey = { href: props.to, origin: location.pathname + location.search, productId: card.dataset.productId ?? '', photo, returning: false, cancel: () => {} };
    travel(journey);
  }} />;
}

/** Layout cleanup captures the visible, decoded hero before React removes it on Back. */
export function useProductEntrance(hero: React.RefObject<HTMLDivElement | null>, ready: boolean) {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    if (!ready || !journey || journey.returning || journey.href.split('?')[0] !== pathname) return;
    const saved = journey, el = hero.current;
    return () => {
      // StrictMode replay and data refresh stay on this route; neither is a return journey.
      if (window.location.pathname === pathname) return;
      if (route() === saved.origin) returnToCard(saved, el ? take(el) : undefined);
      else if (journey === saved) { saved.cancel(); journey = null; }
    };
  }, [hero, ready, pathname]);
}
