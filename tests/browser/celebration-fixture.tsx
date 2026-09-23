/**
 * Local fixture for the order celebration and the busy overlay — the real
 * NavigationRouter, AppIntro, AppBusy, OrderCelebration and busy store, with
 * no API behind them. Driven by scripts/e2e-celebration.mjs.
 *
 *   /             a checkout-shaped page: a header dock, a long tree, and a
 *                 Place button that holds `order` for ORDER_MS and then swaps
 *                 the page for the confirmation (the same commit the real
 *                 checkout makes).
 *   /slow         a lazy page whose chunk takes SLOW_MS to arrive, reached by
 *                 an in-shell Link — the navigation BrowserRouter used to leave
 *                 silent and tappable.
 *
 * On load the shell holds a `route` wait until the intro is ready, the way
 * RouteFallback does while the host and the session resolve.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import NavigationRouter from '../../src/components/NavigationRouter';
import { LanguageProvider } from '../../src/LanguageContext';
import AppIntro from '../../src/components/bloub/AppIntro';
import AppBusy from '../../src/components/ui/AppBusy';
import { MotionCharacterHome } from '../../src/components/bloub/MotionCharacterAnchor';
import OrderCelebration from '../../src/components/bloub/OrderCelebration';
import { useBusy } from '../../src/lib/busy';
import { mascot } from '../../src/lib/mascot';
import '../../src/index.css';

const params = new URLSearchParams(window.location.search);
const ORDER_MS = Number(params.get('order') ?? 900);
const SLOW_MS = Number(params.get('slow') ?? 1500);
const BOOT_MS = Number(params.get('boot') ?? 900);

window.fetch = async () => Response.json({ success: true });

function SlowPage() {
  return <main data-page="slow" className="p-6 text-text-primary">Slow page arrived</main>;
}
const Slow = React.lazy(
  () => new Promise<{ default: React.ComponentType }>((resolve) => setTimeout(() => resolve({ default: SlowPage }), SLOW_MS))
);

function Checkout() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = React.useState(false);
  const [placed, setPlaced] = React.useState(false);
  useBusy(submitting, 'order');
  const place = () => {
    setSubmitting(true);
    window.setTimeout(() => {
      (window as unknown as { __placedAt?: number }).__placedAt = performance.now();
      setPlaced(true);
      setSubmitting(false);
      mascot.outcome('ordered');
    }, ORDER_MS);
  };
  if (placed) {
    return (
      <div data-page="confirmation" className="h-full min-h-dvh w-full overflow-y-auto bg-canvas text-text-primary flex flex-col">
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <div className="mb-8 flex items-center justify-center">
            <OrderCelebration />
          </div>
          <h2 className="text-2xl font-normal mb-3">تم استلام طلبك بنجاح</h2>
          <div className="bg-[#0a0a0a] border border-white/5 rounded-xl p-6 max-w-xs w-full mb-10">
            <div className="text-lg font-mono tracking-widest text-white">ord_fixture_1</div>
          </div>
          <button id="home" onClick={() => navigate('/elsewhere')} className="bg-white text-black py-3 px-8 rounded-xl">
            العودة للرئيسية
          </button>
        </div>
      </div>
    );
  }
  return (
    <div data-page="checkout" className="min-h-dvh bg-canvas text-text-primary">
      <div className="lv-character-header sticky top-0 z-10 bg-canvas px-3 py-2 items-center">
        <button type="button" aria-label="Back">Back</button>
        <MotionCharacterHome compact />
        <h1 className="text-white font-bold text-[15px]">إتمام الطلب</h1>
      </div>
      <main className="p-4 flex flex-col gap-3">
        <Link id="slow" to="/slow">Slow page</Link>
        <button id="place" type="button" className="lv-button lv-button-primary" onClick={place} disabled={submitting}>
          تأكيد الطلب
        </button>
        {/* A tree with some weight, so unmounting it costs something. */}
        {Array.from({ length: 300 }, (_, i) => (
          <div key={i} className="lv-surface p-3 flex justify-between text-[12px]">
            <span>بند {i}</span>
            <span dir="ltr">{(i * 1250).toLocaleString('en-US')} IQD</span>
          </div>
        ))}
      </main>
    </div>
  );
}

function Elsewhere() {
  return (
    <div data-page="elsewhere" className="min-h-dvh bg-canvas text-text-primary">
      <div className="lv-character-header sticky top-0 bg-canvas px-3 py-2 items-center">
        <span />
        <MotionCharacterHome compact />
        <span />
      </div>
      <main className="p-6">Home</main>
    </div>
  );
}

function BootWait({ done }: { done: boolean }) {
  useBusy(!done, 'route');
  return null;
}

function Fixture() {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setReady(true), BOOT_MS);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <>
      <BootWait done={ready} />
      <React.Suspense fallback={<div data-page="fallback" className="min-h-dvh bg-black" />}>
        <Routes>
          <Route path="/slow" element={<Slow />} />
          <Route path="/elsewhere" element={<Elsewhere />} />
          <Route path="*" element={<Checkout />} />
        </Routes>
      </React.Suspense>
      <AppIntro ready={ready} />
      <AppBusy />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      <NavigationRouter>
        <Fixture />
      </NavigationRouter>
    </LanguageProvider>
  </React.StrictMode>
);
