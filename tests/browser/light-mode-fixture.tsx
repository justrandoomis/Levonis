/**
 * THE TWO PAGES THE OWNER PHOTOGRAPHED, RENDERED WITH THE OS SET TO LIGHT.
 *
 * «صفحة المحادثات + صفحة الحساب بال light mode حل المشكلة.»
 *
 * This app has no light theme: `html` is pinned `color-scheme: dark` and
 * `#0b0c0f`, and every shared component is tokenised for that one ground. But
 * /chats and /profile were written as a hand-rolled light/dark PAIR, and
 * Tailwind v4 with no config file compiles `dark:` to
 * `@media (prefers-color-scheme: dark)`. So on a phone set to LIGHT the dark
 * half evaporated and these two pages repainted themselves cream inside a
 * permanently black app — with every shared component still painting dark on
 * top of them. That is the grey-on-grey in the screenshots.
 *
 * A source test can assert that no `dark:` class survives. Only a render under
 * an EMULATED light preference proves the page is actually dark for the person
 * holding the phone, which is the thing that was broken.
 *
 * The pages are mounted whole, with the API stubbed empty — an empty account
 * is the state that shows the most chrome and the least data, so it is the
 * strictest ground to measure.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { AuthProvider } from '../../src/AuthContext';
import Chats from '../../src/pages/Chats';
import '../../src/index.css';

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
