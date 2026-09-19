import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { startInstallPromptCapture } from './hooks/useInstallApp';
import { watchForUpdates } from './components/pwa/UpdateReadyToast';

/**
 * NO GOOGLE PROVIDER HERE ANY MORE.
 *
 * `GoogleOAuthProvider` used to wrap the whole app with
 * `import.meta.env.VITE_GOOGLE_CLIENT_ID || "YOUR_GOOGLE_CLIENT_ID"` — a
 * build-time value with a placeholder fallback, mounted on every page whether
 * or not anyone was signing in. A build made without that repository secret
 * shipped the literal placeholder, and the auth page told customers Google
 * was "not enabled on this deployment" even when the Worker was configured
 * correctly.
 *
 * The client id now comes from `/api/auth/capabilities` at runtime, and the
 * provider is mounted by the auth surface itself, only when there is a real
 * id to give it. The bundle carries no provider configuration at all.
 */

/**
 * THE INSTALL EVENT IS CAUGHT BEFORE REACT EXISTS.
 *
 * Chromium fires `beforeinstallprompt` once and early — frequently before the
 * first component mounts. A listener added inside a `useEffect` therefore
 * wins the race on a slow connection and loses it on a fast one, and the
 * install button appears on some visits and not others, on the same phone.
 * The listener lives in a module-scope store instead, and this line is where
 * it is armed: the earliest statement in the application that runs at all.
 * The call is idempotent, so importing the store from anywhere else is safe.
 */
startInstallPromptCapture();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * THE SERVICE WORKER — registered last, on purpose, and only in a build.
 *
 * AFTER `render`, AFTER `load`. Registration kicks off a network request and
 * a fresh JavaScript realm for the worker, and both compete with the first
 * screen for the same connection on the Iraqi mobile links this shop is built
 * for. Nothing about the shop needs the worker to be running on the first
 * visit — it governs the NEXT navigation — so it waits for the page to finish
 * loading and costs the first paint nothing. That is the same argument
 * `useIdlePrefetch` in src/App.tsx makes for the route chunks.
 *
 * `import.meta.env.PROD` IS A DELIBERATE EXCEPTION, and it is the only one in
 * `src/`. The two other `import.meta.env` mentions in this repository are
 * comments explaining why a build-time value was DELETED, and the argument
 * above still stands: a deployment fact belongs to the server, not to the
 * bundle. This is not a deployment fact. It is a fact about the dev server —
 * `npm run dev:web` serves `public/sw.js` happily, and a worker registered
 * there caches the dev server's own module URLs and then answers Vite's HMR
 * requests from that cache, which presents as edits that do not appear until
 * site data is cleared. The guard is about the tool, not the environment.
 *
 * A FAILED REGISTRATION IS INVISIBLE. Every failure mode here — the file not
 * deployed yet, a browser with service workers disabled, a private window,
 * an insecure origin, an embedded webview that refuses — leaves a shop that
 * works exactly as it did before this feature existed. None of them is worth
 * a single pixel of a customer's screen.
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const register = () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        // The toast is the only thing that may tell a waiting worker to take
        // over; see src/components/pwa/UpdateReadyToast.tsx for why sw.js
        // refuses to do it by itself.
        watchForUpdates(registration);
      })
      .catch(() => {
        // Silent by design — see above.
      });
  };

  if (document.readyState === 'complete') {
    register();
    return;
  }
  window.addEventListener('load', register, { once: true });
}

registerServiceWorker();
