/**
 * Mounts the serial-inventory surfaces for a browser: the admin panel
 * (`?view=admin`) and the customer's «إضافة طابعة» card (`?view=user`), in
 * either theme (`?theme=light|dark`) and language (`?lang=ar|en`). Requests go
 * to whatever serves `/api` (a stand-in running the REAL worker routes); the
 * `x-as` header names the signed-in account (`?as=boss|buyer`).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { Toaster } from '../../src/components/ui/Toast';
import AdminWarranties from '../../src/components/adminWarranty/AdminWarranties';
import { AddDevicePanel } from '../../src/components/warranty/AddDevicePanel';
import { WARRANTY_STRINGS } from '../../src/components/warranty/strings';
import '../../src/index.css';

const q = new URLSearchParams(location.search);
const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
const lang = q.get('lang') === 'en' ? 'en' : 'ar';
document.documentElement.setAttribute('data-theme', theme);
document.documentElement.setAttribute('dir', lang === 'en' ? 'ltr' : 'rtl');
document.documentElement.lang = lang;
try {
  localStorage.setItem('levo_lang', lang);
  if (q.get('view') === 'admin') localStorage.setItem('levonis.admin.warrantyView', 'serials');
} catch {
  /* private mode */
}

const as = q.get('as') ?? (q.get('view') === 'user' ? 'buyer' : 'boss');
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('x-as', as);
  return realFetch(input as RequestInfo, { ...init, headers });
}) as typeof window.fetch;

function Fixture() {
  return (
    <MemoryRouter>
      <LanguageProvider>
        <div dir={lang === 'en' ? 'ltr' : 'rtl'} className="min-h-screen bg-canvas text-white p-4 sm:p-6">
          {q.get('view') === 'user' ? (
            <div className="max-w-2xl mx-auto">
              <AddDevicePanel lang={lang} s={WARRANTY_STRINGS[lang]} refreshKey={0} onLinked={() => undefined} />
            </div>
          ) : (
            <div className="max-w-[1280px] mx-auto">
              <AdminWarranties />
            </div>
          )}
          <Toaster />
        </div>
      </LanguageProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
