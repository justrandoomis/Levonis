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
 * NO CHOICE MEANS LIGHT. The warm ivory system is the owner's new design; a
 * visitor who never opened Settings sees it whatever their phone is set to.
 * «حسب الجهاز» is the explicit opt-in to follow the device.
 */
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'levonis.theme.v1';
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light';

/** The browser chrome (address bar, status area) takes the page's own ground. */
export const THEME_COLOR: Record<Theme, string> = { light: '#f3f0ea', dark: '#0b0c0f' };

const DARK_QUERY = '(prefers-color-scheme: dark)';

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
    applyTheme(resolveTheme('system', mq.matches));
    notify();
  };
  mq.addEventListener?.('change', onChange);
}

/** Called once from main.tsx: re-asserts what the inline script set and starts following the device. */
export function initTheme(): void {
  applyTheme(resolveTheme(current()));
  bindDeviceListener();
  // Another tab changed it: follow, so two open tabs never disagree.
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    preference = readThemePreference();
    applyTheme(resolveTheme(preference));
    notify();
  });
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* private mode: the choice holds for this visit */
  }
  applyTheme(resolveTheme(next));
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
