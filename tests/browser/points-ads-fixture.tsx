/**
 * «اجمع النقاط» MOUNTED: the real points page, the real ad window, the real
 * browse clock over the real bottom nav and cart, and the real admin tab, with
 * explicit API fixtures (docs/DECISIONS.md row 300). Against Vite:
 * /tests/browser/points-ads.html?view=…
 *
 *   ?view=points&state=ready|watched|used|none|legacy   the mission cards
 *        &wait=<seconds>  what the server's countdown answers (default 45)
 *        &video=<url>     the film to play (a bad address shows the failure)
 *   ?view=clock[&idle=1|&award=1]   the browse clock in the shop, over the nav
 *   ?view=cart                      the clock clear of the cart's summary bar
 *   ?view=admin                     Admin → المكافآت (open «الإعلانات»)
 *   &lang=ar|en|ckb  &theme=dark|light
 *
 * Every API the screens call is answered here; anything else answers 404 and is
 * kept on `window.pointsUnstubbed`, so a screen that starts calling something new
 * shows up. The requests are kept on `window.pointsRequests`.
 */
// First: the fixture's API must be in place before the app's modules evaluate.
import { lang, view } from './points-ads-api';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import Rewards from '../../src/pages/Rewards';
import Cart from '../../src/pages/Cart';
import BrowseMissionTimer from '../../src/components/BrowseMissionTimer';
import BottomNav from '../../src/components/BottomNav';
import ToasterGate from '../../src/components/ui/ToasterGate';
import AdminRewards from '../../src/components/adminRewards/AdminRewards';
import '../../src/components/adminProducts/theme.css';
import '../../src/index.css';


/** A shop page to browse: only the clock, the nav and the toast above it are under test. */
function ShopPage() {
  return (
    <div id="main-scroll-container" className="p-4 grid grid-cols-2 gap-3">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="lv-surface h-48" />
      ))}
    </div>
  );
}

function Shell() {
  if (view === 'admin') {
    return (
      <div dir={lang === 'en' ? 'ltr' : 'rtl'} className="min-h-screen bg-canvas text-text-primary p-4">
        <AdminRewards />
      </div>
    );
  }
  if (view === 'clock' || view === 'cart') {
    return (
      <div className="lv-canvas overflow-hidden flex flex-col text-text-primary" style={{ height: '100vh' }}>
        <div className="flex-1 overflow-y-auto">{view === 'cart' ? <Cart /> : <ShopPage />}</div>
        <ToasterGate aboveNav />
        <BottomNav />
        <BrowseMissionTimer />
      </div>
    );
  }
  return (
    <div className="lv-canvas min-h-screen text-text-primary">
      <Routes>
        <Route path="/points" element={<Rewards />} />
        <Route path="*" element={<p data-left-points>left the points page</p>} />
      </Routes>
      <ToasterGate />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <WalletProvider>
        <CurrencyProvider>
          <MemoryRouter initialEntries={[view === 'cart' ? '/cart' : view === 'clock' ? '/products' : '/points']}>
            <Shell />
          </MemoryRouter>
        </CurrencyProvider>
      </WalletProvider>
    </LanguageProvider>
  </AuthProvider>
);
