import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

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
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
