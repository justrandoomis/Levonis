/** Check a long-lived tab when its owner returns, without navigating it or
 * applying a waiting worker. The existing update toast owns consent/reload. */
export const SW_UPDATE_CHECK_INTERVAL_MS = 60_000;

type UpdateRegistration = Pick<ServiceWorkerRegistration, 'update' | 'waiting' | 'installing'>;
type UpdateWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type UpdateDocument = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;

export function watchServiceWorkerUpdates(
  registration: UpdateRegistration,
  page: UpdateWindow = window,
  documentState: UpdateDocument = document,
  now: () => number = Date.now,
): () => void {
  // register() has just checked. Avoid another network request at first paint.
  let lastCheck = now();
  let inFlight = false;
  let stopped = false;
  const check = async () => {
    if (stopped || inFlight || documentState.visibilityState !== 'visible' || registration.waiting || registration.installing) return;
    const at = now();
    if (at - lastCheck < SW_UPDATE_CHECK_INTERVAL_MS) return;
    lastCheck = at;
    inFlight = true;
    try {
      await registration.update();
    } catch {
      // Offline or an unsupported update check must not interrupt the page.
    } finally {
      inFlight = false;
    }
  };
  const onReturn = () => { void check(); };
  page.addEventListener('focus', onReturn);
  documentState.addEventListener('visibilitychange', onReturn);
  return () => {
    stopped = true;
    page.removeEventListener('focus', onReturn);
    documentState.removeEventListener('visibilitychange', onReturn);
  };
}
