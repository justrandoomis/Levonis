/**
 * THE INSTALL EVENT ARRIVES BEFORE REACT DOES. That is the whole reason this
 * file is shaped the way it is.
 *
 * Chromium fires `beforeinstallprompt` ONCE, early, and — this is the part
 * that bites — often before the entry bundle has finished evaluating, let
 * alone before a component has mounted. A listener added inside a `useEffect`
 * is registered hundreds of milliseconds too late on a fast connection and
 * just in time on a slow one, so the install button appears on some visits and
 * not on others, on the same phone, in the same browser. It reads as a browser
 * quirk and it is not one: it is a race the page loses.
 *
 * So the listener is attached at MODULE EVALUATION TIME, in a module-scope
 * store, and React reads that store through `useSyncExternalStore`. By the
 * time any component asks, the answer is already sitting here. This is the
 * same shape `src/lib/appBootstrap.ts` uses for the other fact the shell
 * cannot discover from inside a render, and for the same reason.
 *
 * THE EVENT IS SINGLE-USE. `prompt()` may be called exactly once per captured
 * event; a second call rejects. `<StrictMode>` double-invokes effects in
 * development and a customer can double-tap a button, so the event is handed
 * out by clearing it first — the second caller gets `unavailable`, never a
 * rejected promise thrown into a click handler.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  clearInstallDismissal,
  detectPlatform,
  installGuidance,
  isInAppWebView,
  isMobilePlatform,
  isStandalone,
  readDismissedUntil,
  recordInstallDismissal,
  type InstallGuidance,
  type Platform,
  type PlatformProbe,
  type StorageLike,
} from '../lib/pwa';

/**
 * Chromium's event. It is not in TypeScript's DOM library because it is not a
 * standard — which is itself the reason the rest of this feature exists: half
 * the world's browsers have no equivalent at all.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export type PromptOutcome = 'accepted' | 'dismissed' | 'unavailable';

interface PromptSnapshot {
  /** A usable, unspent `beforeinstallprompt` event is held. */
  readonly hasPrompt: boolean;
  /** The browser told us the install completed, in this page's lifetime. */
  readonly installed: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;

// The snapshot object is replaced only when something actually changes, never
// rebuilt per read: `useSyncExternalStore` compares snapshots by identity and
// a fresh object every call is an infinite render loop.
let snapshot: PromptSnapshot = { hasPrompt: false, installed: false };
const listeners = new Set<() => void>();

function publish(next: PromptSnapshot): void {
  if (next.hasPrompt === snapshot.hasPrompt && next.installed === snapshot.installed) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export const installPromptStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot(): PromptSnapshot {
    return snapshot;
  },
  serverSnapshot(): PromptSnapshot {
    return snapshot;
  },
};

/**
 * `localStorage` is reached through a function, and the ACCESS ITSELF is in
 * the try: it is not only reading a key that throws in a Safari private
 * window or in an iframe with third-party storage blocked — touching the
 * property does.
 */
function safeStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function probe(): PlatformProbe {
  if (typeof navigator === 'undefined') return { userAgent: '', maxTouchPoints: 0 };
  return { userAgent: navigator.userAgent || '', maxTouchPoints: navigator.maxTouchPoints || 0 };
}

function standaloneNow(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { standalone?: boolean }) : undefined;
  return isStandalone({
    matchMedia: typeof window.matchMedia === 'function' ? (q: string) => window.matchMedia(q) : null,
    appleStandalone: nav?.standalone,
  });
}

let captureStarted = false;

/**
 * Attaches the two window listeners. Idempotent, because it is called both at
 * import time (the guarantee) and explicitly from `src/main.tsx` (so the
 * ordering is visible to a reader of the entry point, and survives a future
 * refactor that stops importing this module from the component tree).
 */
export function startInstallPromptCapture(): void {
  if (captureStarted || typeof window === 'undefined') return;
  captureStarted = true;

  window.addEventListener('beforeinstallprompt', (event: Event) => {
    // WITHOUT THIS, CHROME DECIDES WHEN TO ASK. The default action is the
    // browser's own mini-infobar, which appears over the shop at a moment
    // nobody chose, in English, and is dismissed for months by one stray tap.
    // Preventing it is what moves the decision to «تحميل التطبيق» in
    // Settings — the customer asks, and then the browser's real dialog opens.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    publish({ hasPrompt: true, installed: snapshot.installed });
  });

  window.addEventListener('appinstalled', () => {
    // Spent, and there will not be another for this origin until the app is
    // removed from the device.
    deferred = null;
    publish({ hasPrompt: false, installed: true });
    // A device that installed the app has answered the question permanently
    // well, so the "not now" memory is retired rather than left to expire —
    // otherwise an uninstall thirty days from now would find a stale silence.
    clearInstallDismissal(safeStorage());
  });
}

// The guarantee. Import order decides nothing if the side effect is here.
startInstallPromptCapture();

/**
 * Opens the browser's own install dialog, once.
 *
 * `deferred` is cleared BEFORE `prompt()` is awaited, so a double tap, a
 * StrictMode double-invoke, or two components both offering the button can
 * never call `prompt()` twice on one event — the second caller is told
 * `unavailable` instead of being handed a rejected promise.
 */
export async function promptInstall(): Promise<PromptOutcome> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  publish({ hasPrompt: false, installed: snapshot.installed });
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    // The event was already consumed, or the browser refused to show the
    // dialog. Neither is something to report to a customer; the manual
    // instructions in the sheet remain a working path.
    return 'unavailable';
  }
}

export interface InstallApp {
  /** A real one-tap install is available right now. */
  canPrompt: boolean;
  promptInstall: () => Promise<PromptOutcome>;
  platform: Platform;
  /** Running as an installed app already — every affordance must hide. */
  standalone: boolean;
  /** This browser is embedded in another app and can install nothing. */
  inAppWebView: boolean;
  /** The customer said «ليس الآن» and the quiet period has not expired. */
  dismissed: boolean;
  dismiss: () => void;
  /** Exactly one of five states for the sheet to render. */
  guidance: InstallGuidance;
}

export function useInstallApp(): InstallApp {
  const store = useSyncExternalStore(
    installPromptStore.subscribe,
    installPromptStore.snapshot,
    installPromptStore.serverSnapshot
  );

  // Read once, in the state initialiser rather than in an effect. The
  // user-agent does not change while the page is open, and defaulting to
  // "unknown" and correcting afterwards is what makes an install button
  // appear and then swap its own label a frame later — the flash
  // `src/hooks/useCapabilities.ts` argues against for the same reason.
  const [platform] = useState<Platform>(() => detectPlatform(probe()));
  const [mobile] = useState<boolean>(() => isMobilePlatform(probe()));
  const [inAppWebView] = useState<boolean>(() => isInAppWebView(probe().userAgent));

  // This one DOES change: a customer can install the app from the browser's
  // own menu while this page is open, and the display mode flips under it.
  const [displayStandalone, setDisplayStandalone] = useState<boolean>(standaloneNow);
  const [dismissedUntil, setDismissedUntil] = useState<number>(() => readDismissedUntil(safeStorage()));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(display-mode: standalone)');
    } catch {
      // A webview that cannot parse the feature. There is nothing to watch.
      return;
    }
    const onChange = () => setDisplayStandalone(standaloneNow());
    // `addListener` is the deprecated form, and it is the only one Safari
    // below 14 has — the same two-path subscription
    // `src/lib/mascotMotionPreference.ts` already carries.
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    const legacy = query as MediaQueryList & {
      addListener?: (cb: () => void) => void;
      removeListener?: (cb: () => void) => void;
    };
    legacy.addListener?.(onChange);
    return () => legacy.removeListener?.(onChange);
  }, []);

  const dismiss = useCallback(() => {
    setDismissedUntil(recordInstallDismissal(safeStorage(), Date.now()));
  }, []);

  const standalone = displayStandalone || store.installed;
  const guidance = installGuidance({
    platform,
    mobile,
    inAppWebView,
    hasPrompt: store.hasPrompt,
    standalone,
  });

  return {
    canPrompt: store.hasPrompt && !standalone,
    promptInstall,
    platform,
    standalone,
    inAppWebView,
    dismissed: Date.now() < dismissedUntil,
    dismiss,
    guidance,
  };
}
