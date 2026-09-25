/**
 * /chats — THE PAGE THE OWNER PHOTOGRAPHED — RENDERED UNDER BOTH OS SETTINGS
 * AND BOTH APP THEMES.
 *
 * «صفحة المحادثات + صفحة الحساب بال light mode حل المشكلة.» The defect was a
 * page that followed the PHONE (`dark:` compiles to prefers-color-scheme)
 * while the rest of the app did not. The app now has two themes, chosen in
 * Settings → «المظهر» and switched by `data-theme` on <html> (src/index.css,
 * THE TWO THEMES). This fixture takes `?theme=light|dark` and sets that
 * attribute the way index.html's pre-paint script does, so
 * scripts/e2e-light-mode.mjs can prove the page follows the CHOSEN theme at
 * every OS setting — cream never inside black, black never inside cream.
 *
 * The API is stubbed empty — an empty account shows the most chrome and the
 * least data, so it is the strictest ground to measure.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { AuthProvider } from '../../src/AuthContext';
import Chats from '../../src/pages/Chats';
import '../../src/index.css';

document.documentElement.setAttribute(
  'data-theme',
  new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
);

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('/api/')) {
    return new Response(
      JSON.stringify({ success: true, user: null, chats: [], threads: [], items: [] }),
      { headers: { 'content-type': 'application/json' } }
    );
  }
  return realFetch(input as RequestInfo, init);
}) as typeof window.fetch;

function Fixture() {
  return (
    <div data-page="chats">
      <Chats />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter>
      <AuthProvider>
        <LanguageProvider>
          <Fixture />
        </LanguageProvider>
      </AuthProvider>
    </MemoryRouter>
  </React.StrictMode>
);
