/**
 * THE APPEARANCE — «فاتح» / «داكن» / «حسب الجهاز».
 *
 * One theme at a time, for the whole app (src/index.css, THE TWO THEMES). The
 * choice is a DEVICE preference, like the display currency: it works signed
 * out, it lives in this browser, and nothing about it reaches the server —
 * there is no user-preferences API to sync it to, and inventing one for a
 * colour would be a backend for nothing.
 *
 * WHO SETS WHAT, AND WHEN.
 *  - Before the first paint, the inline script in index.html reads the same
 *    key and writes `data-theme`, `color-scheme` and the theme-color meta, so
 *    the first frame is already the right colour. That script is a copy of
 *    `resolveTheme` + `applyTheme` below in eleven lines of ES5, pinned by
 *    worker/lib/securityPolicy.ts (its CSP hash) and tests/themeSystem.test.ts.
 *  - After that this module owns it: `setThemePreference` from Settings, and
 *    the `prefers-color-scheme` listener for «حسب الجهاز».
 *
 * NO CHOICE MEANS THE DEVICE. The owner: «اجعل الثيم الفاتح والثيم الغامق يتبع
 * افتراضيا … نظام السيستم (حسب الجهاز)». A visitor who never opened Settings
 * gets whatever their phone is set to; «فاتح» and «داكن» are the explicit
 * overrides. Somebody who already chose keeps the choice — it is stored — and
 * somebody who never chose has nothing stored, so they simply start following
 * the device. (It used to be light for everyone, which is why the owner's
 * screenshot shows «فاتح» selected on an untouched account.)
 *
 * THE CHANGE IS ANIMATED, never the first paint. A tap on a theme control
 * reveals the new theme as a circle growing from the finger (View Transitions);
 * a change nobody tapped for — the device flipping at sunset — cross-fades.
 * The header's «اللغة والمظهر» sheet asks for `{ origin: 'center' }`: it
 * closes first, and only then does the new theme open as a spot in the middle
 * of the screen that widens calmly until it fills it (the owner: «يظهر التغيير
 * السلس بهدوء من منتصف الشاشة كبقعة وتتمدد كدائرة شيئا فشيئا»).
 * Without View Transitions it is a short colour transition on the page, and
 * under reduced motion it is instant. The CSS for all three is in
 * src/index.css, THE THEME SWITCH.
 */
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'levonis.theme.v1';
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

/** The browser chrome (address bar, status area) takes the page's own ground. */
export const THEME_COLOR: Record<Theme, string> = { light: '#e3dacb', dark: '#0b0c0f' };

const DARK_QUERY = '(prefers-color-scheme: dark)';
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

function isPreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function readThemePreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(raw) ? raw : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/** Whether this browser holds an explicit choice — «حسب الجهاز» counts once it was picked. */
export function hasStoredThemePreference(): boolean {
  try {
    return isPreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return false;
  }
}

function systemIsDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePreference, deviceDark: boolean = systemIsDark()): Theme {
  if (pref === 'system') return deviceDark ? 'dark' : 'light';
  return pref;
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
  // Read by iOS when the installed app launches: an opaque bar in the page's
  // own ground — dark text on ivory, light text on black.
  const bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (bar) bar.setAttribute('content', theme === 'dark' ? 'black' : 'default');
}

// ------------------------------------------------------------ the switch
/** Where the reveal grows from, in viewport pixels. */
export interface ThemeOrigin {
  x: number;
  y: number;
}

/**
 * How a change is shown.
 *  - `origin`: a point, `'center'` (the middle of the viewport, measured when
 *    the reveal starts — after whatever closed before it), `null` for a plain
 *    cross-fade, or left out for the control just tapped.
 *  - `duration`: the reveal's length in ms (default 480; the centre reveal
 *    from the header sheet asks for a calmer 800).
 */
export interface ThemeSwitchOptions {
  origin?: ThemeOrigin | 'center' | null;
  duration?: number;
}

/** What `paintTheme` grows from: a point, the centre, or nothing (a fade). */
type RevealFrom = ThemeOrigin | 'center' | null;

type ViewTransitionLike = { ready: Promise<void>; finished: Promise<void> };
type DocumentWithViewTransition = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionLike;
};

/** False until the first frame has painted: the first paint is never animated. */
let animationsReady = false;
let lastPointer: (ThemeOrigin & { t: number }) | null = null;
const REVEAL_MS = 480;
/** The centre reveal: a spot that widens «شيئا فشيئا», not a flash. */
export const CENTER_REVEAL_MS = 800;
const FADE_MS = 300;
/** The fallback cross-fade for a calm (centre) change, without View Transitions. */
const CALM_FADE_MS = 600;
/** Tap reveal: fast out of the finger. Centre reveal: ease-in-out, calm at both ends. */
const TAP_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const CENTER_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)';

function reducedMotion(): boolean {
  try {
    return window.matchMedia(REDUCE_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * The control the change came from: the last tap if it was just now (the
 * Settings pill and the sheet's cards both change the theme on the tap), else
 * the focused control for a keyboard change, else nothing — a cross-fade.
 */
function guessOrigin(): ThemeOrigin | null {
  if (lastPointer && performance.now() - lastPointer.t < 1500) return { x: lastPointer.x, y: lastPointer.y };
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) {
    const r = el.getBoundingClientRect();
    if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return null;
}

/**
 * Put `theme` on screen, animated when that is wanted and possible.
 *
 * View Transitions snapshot the page, apply the change, and animate the old
 * snapshot to the new one: with an origin the new theme is clipped to a circle
 * that grows from the finger to the far corner; without one the two cross-fade
 * (the browser's default, shortened in index.css). Only a class on <html> and
 * the Web Animations API are used — no style is written into the document, so
 * the CSP is exactly what it was.
 */
function paintTheme(theme: Theme, from: RevealFrom, duration: number = REVEAL_MS): void {
  const root = document.documentElement;
  const onScreen: Theme = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  if (onScreen === theme || !animationsReady || reducedMotion() || document.visibilityState === 'hidden') {
    applyTheme(theme);
    return;
  }
  const doc = document as DocumentWithViewTransition;
  if (typeof doc.startViewTransition === 'function') {
    const mode = from ? 'lv-theme-reveal' : 'lv-theme-fade';
    root.classList.add(mode);
    let vt: ViewTransitionLike;
    try {
      // The update runs a frame later, so the listeners hear about it again
      // then — `useTheme` reads the theme off <html>.
      vt = doc.startViewTransition(() => {
        applyTheme(theme);
        notify();
      });
    } catch {
      root.classList.remove(mode);
      applyTheme(theme);
      return;
    }
    if (from) {
      vt.ready
        .then(() => {
          const w = window.innerWidth;
          const h = window.innerHeight;
          // The centre is read NOW, not when the change was asked for: the
          // viewport may have rotated or resized while the sheet was closing.
          const origin = from === 'center' ? { x: w / 2, y: h / 2 } : from;
          const radius = Math.hypot(Math.max(origin.x, w - origin.x), Math.max(origin.y, h - origin.y));
          const at = `at ${origin.x}px ${origin.y}px`;
          root.animate(
            { clipPath: [`circle(0px ${at})`, `circle(${radius}px ${at})`] },
            {
              duration,
              easing: from === 'center' ? CENTER_EASING : TAP_EASING,
              fill: 'both',
              pseudoElement: '::view-transition-new(root)',
            }
          );
        })
        .catch(() => {
          /* skipped (a second change arrived): the theme is applied anyway */
        });
    }
    vt.finished.finally(() => root.classList.remove(mode)).catch(() => {});
    return;
  }
  // No View Transitions (older Safari): the colours ease instead of snapping —
  // and for the calm centre change, ease a little longer.
  const calm = from === 'center';
  const classes = calm ? ['lv-theme-fading', 'lv-theme-fading--calm'] : ['lv-theme-fading'];
  root.classList.add(...classes);
  applyTheme(theme);
  window.setTimeout(() => root.classList.remove(...classes), (calm ? CALM_FADE_MS : FADE_MS) + 40);
}

// ------------------------------------------------------------ the store
let preference: ThemePreference | null = null;
const listeners = new Set<() => void>();
let mediaBound = false;

function notify() {
  for (const l of listeners) l();
}

function current(): ThemePreference {
  if (preference === null) preference = readThemePreference();
  return preference;
}

function bindDeviceListener() {
  if (mediaBound || typeof window === 'undefined' || !window.matchMedia) return;
  mediaBound = true;
  const mq = window.matchMedia(DARK_QUERY);
  const onChange = () => {
    if (current() !== 'system') return;
    paintTheme(resolveTheme('system', mq.matches), null);
    notify();
  };
  mq.addEventListener?.('change', onChange);
}

/** Called once from main.tsx: re-asserts what the inline script set and starts following the device. */
export function initTheme(): void {
  applyTheme(resolveTheme(current()));
  bindDeviceListener();
  // Only after the first frame is on screen may a change be animated.
  requestAnimationFrame(() => requestAnimationFrame(() => (animationsReady = true)));
  window.addEventListener(
    'pointerdown',
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
    },
    { capture: true, passive: true }
  );
  // Another tab changed it: follow, so two open tabs never disagree.
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    preference = readThemePreference();
    paintTheme(resolveTheme(preference), null);
    notify();
  });
}

function isOrigin(v: unknown): v is ThemeOrigin {
  return !!v && typeof v === 'object' && typeof (v as ThemeOrigin).x === 'number' && typeof (v as ThemeOrigin).y === 'number';
}

/**
 * Choose, store and show. The second argument is where the reveal grows from —
 * a point, or `null` for a cross-fade — or the options `{ origin, duration }`
 * (`origin: 'center'` for the header sheet). Left out, it is the control just
 * tapped (or focused).
 *
 * A choice that resolves to the theme already on screen («حسب الجهاز» on a
 * device that is already in that mode) is stored and nothing moves.
 */
export function setThemePreference(next: ThemePreference, how?: ThemeOrigin | null | ThemeSwitchOptions): void {
  preference = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* private mode: the choice holds for this visit */
  }
  let from: RevealFrom;
  let duration = REVEAL_MS;
  if (how === undefined) from = guessOrigin();
  else if (how === null) from = null;
  else if (isOrigin(how)) from = { x: how.x, y: how.y };
  else {
    from = how.origin === undefined ? guessOrigin() : how.origin;
    if (typeof how.duration === 'number' && how.duration > 0) duration = how.duration;
  }
  paintTheme(resolveTheme(next), from, duration);
  notify();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The stored choice, and the theme actually on screen. */
export function useTheme(): { preference: ThemePreference; theme: Theme } {
  const pref = useSyncExternalStore(subscribe, current, () => DEFAULT_THEME_PREFERENCE);
  const theme = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light') as Theme,
    () => 'light' as Theme
  );
  return { preference: pref, theme };
}
