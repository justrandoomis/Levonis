/** Browser-only fixture. Real production character, anchors, router, locale
 * provider and CSS; no network data, sessions or production writes. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import AppIntro from '../../src/components/bloub/AppIntro';
import { MotionCharacterAnchor, MotionCharacterFallbackHeader, MotionCharacterHome, useCharacterBusy } from '../../src/components/bloub/MotionCharacterAnchor';
import '../../src/index.css';

function Fixture() {
  const location = useLocation();
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [showHeader, setShowHeader] = React.useState(true);
  useCharacterBusy(busy);
  const focused = location.pathname !== '/';
  return <>
    <div className="min-h-dvh bg-canvas text-text-primary">
      {focused && <MotionCharacterFallbackHeader />}
      {focused && showHeader && <header className="lv-character-header sticky top-0 px-4 py-3 items-center">
        <button type="button" aria-label="Back">Back</button>
        <MotionCharacterHome busy={busy} />
        <button type="button" aria-label="Cart">Cart</button>
      </header>}
      <main className="p-4 flex flex-col gap-4">
        <h1 data-route>{location.pathname}</h1>
        <button id="ready" type="button" onClick={() => setReady(true)}>Resolve actual loading</button>
        <Link id="product" to="/product/test">Product</Link>
        <Link id="checkout" to="/checkout">Checkout</Link>
        <Link id="home" to="/">Home</Link>
        <button id="busy" type="button" onClick={() => setBusy(v => !v)}>Toggle work</button>
        <button id="header" type="button" onClick={() => setShowHeader(v => !v)}>Toggle header</button>
        <input aria-label="Focus probe" className="max-w-full bg-surface" />
      </main>
      {!focused && <nav data-bottom-nav className="fixed inset-x-0 bottom-4 flex justify-center">
        <Link to="/" data-bloub-home-button aria-label="Home" className="flex h-16 w-16 items-center justify-center">
          <MotionCharacterAnchor kind="bottom-home" />
        </Link>
      </nav>}
    </div>
    <AppIntro ready={ready} />
  </>;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><LanguageProvider><MemoryRouter><Fixture /></MemoryRouter></LanguageProvider></React.StrictMode>
);
