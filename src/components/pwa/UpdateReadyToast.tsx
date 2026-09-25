/**
 * «يتوفر تحديث للتطبيق» — the quiet line that lets a customer take a new
 * deploy, at a moment they choose.
 *
 * WHY THIS EXISTS AT ALL. `public/sw.js` deliberately does NOT call
 * `skipWaiting()` on install. A service worker that takes over mid-session
 * swaps the asset cache under a page that is still lazily loading route
 * chunks from the build it was served, and the visitor gets a chunk-load
 * error on the next screen they open — a shop that breaks when you navigate,
 * for everyone, at deploy time. So the new worker WAITS, and this is the only
 * thing in the application that can ask it to stop waiting: the page posts
 * `{type:'SKIP_WAITING'}`, which is the single message shape sw.js acts on.
 *
 * THE RELOAD IS GUARDED BY A MODULE-SCOPE FLAG. `controllerchange` can fire
 * more than once — a second worker activating, or another tab of the same
 * origin taking over — and `location.reload()` inside that handler without a
 * latch is the classic service-worker reload loop, which looks to the owner
 * like the shop refreshing itself forever. The flag is module-scope rather
 * than a ref so that `<StrictMode>`'s double-invoked effects and a remount of
 * this component share the same latch.
 *
 * MOUNTED ONCE, AT THE ROOT. It is a sibling of `AppBootstrapLayer` in
 * `src/App.tsx`, which is the only place that renders on all three shells —
 * the main site, the full-screen routes, and a merchant's storefront on its
 * own subdomain. A deploy reaches every one of them.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useState, useSyncExternalStore } from 'react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { UI_LAYERS } from '../ui/Overlay';

let waiting: ServiceWorker | null = null;
let snapshot = false;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export const updateReadyStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot(): boolean {
    return snapshot;
  },
  serverSnapshot(): boolean {
    return false;
  },
};

/**
 * Watches a registration for a worker that has installed and is waiting.
 * Called from `src/main.tsx` with the registration it just obtained.
 *
 * `navigator.serviceWorker.controller` is the test that separates an UPDATE
 * from a FIRST INSTALL. On a visitor's very first load the worker installs
 * and activates with no controller in play, and there is nothing to tell them
 * about — showing "an update is ready" to someone who has never had this app
 * before is nonsense. A controller exists only when a previous worker is
 * already driving the page, and that is exactly the case where a new one has
 * to wait for permission.
 */
export function watchForUpdates(registration: ServiceWorkerRegistration): void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;

  const offer = (worker: ServiceWorker | null) => {
    if (!worker) return;
    if (!navigator.serviceWorker.controller) return;
    waiting = worker;
    publish(true);
  };

  // A worker may already have been waiting since before this page loaded —
  // the visitor closed the tab mid-update and came back.
  offer(registration.waiting);

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') offer(registration.waiting || installing);
    });
  });
}

let reloading = false;

function onControllerChange(): void {
  if (reloading) return;
  reloading = true;
  try {
    window.location.reload();
  } catch {
    // Nothing useful is left to do if the browser refuses to reload; the new
    // worker takes over on the next navigation either way.
  }
}

export default function UpdateReadyToast() {
  const { t } = useLanguage();
  const m = useMotion();
  const ready = useSyncExternalStore(
    updateReadyStore.subscribe,
    updateReadyStore.snapshot,
    updateReadyStore.serverSnapshot
  );
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  const apply = () => {
    const worker = waiting;
    if (!worker || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    setBusy(true);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    try {
      worker.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      // The worker went away between the offer and the tap. The page is
      // already on a build that works; the next visit picks the new one up.
      setBusy(false);
    }
  };

  const visible = ready && !hidden;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          // `--nav-stack` is the single source of truth for how much of the
          // bottom edge the floating BottomNav owns (src/index.css). Guessing
          // a pixel offset here is precisely how the cart's summary bar ended
          // up inside the nav's gradient scrim, which is what
          // `bottom-[80px] sm:bottom-[100px]` was.
          style={{ bottom: 'calc(var(--nav-stack) + 0.5rem)', zIndex: UI_LAYERS.popover }}
          className="fixed inset-x-3 mx-auto max-w-sm rounded-xl border border-border-subtle bg-surface-raised px-4 py-3 shadow-2xl"
          role="status"
          data-update-toast
          initial={m.reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={m.reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={m.reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          transition={m.spring('ui')}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-[13px] font-bold text-white">{t('pwaUpdateReady')}</p>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setHidden(true)}
                disabled={busy}
                className="min-h-[36px] rounded-lg px-3 text-[12px] font-medium text-zinc-400 transition-colors hover:text-white disabled:opacity-50"
              >
                {t('pwaUpdateLater')}
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={busy}
                className="min-h-[36px] rounded-lg bg-gold px-3 text-[12px] font-bold text-accent-contrast transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {busy ? t('pwaUpdateApplying') : t('pwaUpdateAction')}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
