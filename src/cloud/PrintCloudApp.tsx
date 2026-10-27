/**
 * LEVONIS PRINT CLOUD — the whole application of cloud.<root>
 * (docs/PRINT_CLOUD.md; the design reference is the owner's prototype, drawn
 * here in the house «layered clay»).
 *
 * src/App.tsx renders this, as its own chunk, when the SERVER classified the
 * host as the `cloud` system host. It sits inside the providers every shell
 * has — AuthProvider (the shared session), LanguageProvider (ar / en / ckb
 * and the direction), CurrencyProvider, the router and StoreProvider (whose
 * `mainSite` is the apex) — and beside the app-wide layers: the busy overlay
 * (AppBusy), the update line and the access-block notice. It mounts its own
 * toaster, as each shell does.
 *
 * WHAT IT DECIDES, from GET /status and the viewer (src/cloud/CloudContext.tsx):
 *   open        the full app: header with the four sections, the phone's tab
 *               bar, every screen;
 *   preview     the same for a platform admin while the service is closed,
 *               under a banner that says so on every screen;
 *   closed      a public landing, «How it works», and an honest «not open
 *               yet» everywhere else (every customer door would answer 503);
 *   unavailable the status could not be read: say so, offer a retry.
 *
 * THE ROUTE TABLE. The shell answers `/` (the customer's home when signed in,
 * the landing otherwise), `/printers`, `/printers/:id`, `/how-it-works`,
 * `/auth` (the sign-in handoff, src/cloud/auth.tsx) and the 404. Every path
 * under a section's prefixes goes to that section's module (src/cloud/routes.ts),
 * which renders its own `<Routes>` with full paths. Print and Account need an
 * account and are wrapped in `<RequireSignIn>` here; Store is public and asks
 * per screen. Every page module is a lazy chunk.
 */
import { Suspense, useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import ChunkBoundary from '../components/ChunkBoundary';
import ToasterGate from '../components/ui/ToasterGate';
import { prefetchable } from '../lib/routeReveal';
import { CloudAuthHandoff, RequireSignIn } from './auth';
import { CLOUD_TITLE } from './brand';
import { CloudProvider, useCloud } from './CloudContext';
import { cloudSection } from './routes';
import { CloudHeader } from './shell/CloudHeader';
import { CloudTabBar } from './shell/CloudTabBar';
import { ClosedNotice, CloudNotFound, PreviewBanner, ServiceUnreachable } from './shell/Notices';
import { CloudPageFallback } from './ui';

/**
 * THE UI KIT RIDES WITH THE SHELL. Every page below is a lazy chunk, and each
 * imports its own handful of the shared pieces (src/cloud/ui). Left to
 * Rollup, those small modules split by importer set into shared chunks —
 * several under 1 KB, one more request each, which tests/motionLazy.test.ts
 * caps — and more with every page added. Re-exported from this lazy entry,
 * they must stay in this chunk, which every page needs loaded first anyway.
 * (Not a manual chunk in vite.config.ts: Rollup would swallow the house
 * modules they import — src/lib/api.ts among them — and the main entry would
 * import this chunk back.) Pages keep importing from '../ui'; a piece added
 * to the ui barrel rides here by itself. The figures (format.ts) are left to
 * the pages that write them: one shared chunk well over 1 KB, and the dates
 * and digits it brings stay out of the shell's preload list in the entry.
 */
export * from './ui';

const Home = prefetchable(() => import('./pages/Home'));
const Landing = prefetchable(() => import('./pages/Landing'));
const Printers = prefetchable(() => import('./pages/Printers'));
const PrinterDetail = prefetchable(() => import('./pages/PrinterDetail'));
const HowItWorks = prefetchable(() => import('./pages/HowItWorks'));
const PrintRoutes = prefetchable(() => import('./pages/print/PrintRoutes'));
const StoreRoutes = prefetchable(() => import('./pages/store/StoreRoutes'));
const AccountRoutes = prefetchable(() => import('./pages/account/AccountRoutes'));

/**
 * «Levonis Print Cloud» is the document's name on this host, in every
 * language (the name a tab, a bookmark and an iPhone's home screen show);
 * the shop's own title comes back if the shell ever unmounts.
 */
function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** `/`: the customer's own home when signed in; what Print Cloud is otherwise. */
function HomeOrLanding() {
  const { authReady, signedIn } = useCloud();
  if (!authReady) return <CloudPageFallback />;
  return signedIn ? <Home /> : <Landing />;
}

function CloudRoutes() {
  const cloud = useCloud();
  const { pathname } = useLocation();

  if (cloud.access === 'loading') return <CloudPageFallback />;
  if (cloud.access === 'unavailable') return <ServiceUnreachable onRetry={cloud.reloadStatus} />;

  if (!cloud.canUse) {
    // Closed to this viewer: the public pages, the way to sign in, and an
    // honest «not open yet» at every other address.
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/how-it-works" element={<HowItWorks />} />
        <Route path="/auth" element={<CloudAuthHandoff />} />
        <Route path="*" element={<ClosedNotice />} />
      </Routes>
    );
  }

  const section = cloudSection(pathname);
  if (section === 'print') {
    return (
      <RequireSignIn>
        <PrintRoutes />
      </RequireSignIn>
    );
  }
  if (section === 'store') return <StoreRoutes />;
  if (section === 'account') {
    return (
      <RequireSignIn>
        <AccountRoutes />
      </RequireSignIn>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<HomeOrLanding />} />
      <Route path="/printers" element={<Printers />} />
      <Route path="/printers/:id" element={<PrinterDetail />} />
      <Route path="/how-it-works" element={<HowItWorks />} />
      <Route path="/auth" element={<CloudAuthHandoff />} />
      <Route path="*" element={<CloudNotFound />} />
    </Routes>
  );
}

function CloudShell() {
  const cloud = useCloud();
  // The full chrome — sections, tab bar, wallet, account — only where its doors answer.
  const full = cloud.canUse;
  return (
    <div className="h-[100dvh] min-h-0 flex flex-col font-sans overflow-hidden lv-canvas text-text-primary" data-print-cloud>
      <CloudHeader full={full} />
      {cloud.access === 'preview' ? <PreviewBanner notInstalled={cloud.status?.installed === false} /> : null}
      {/* The id is the shop's: the shell's scroll memory (src/App.tsx) and the
          bottom-chrome scroll padding (src/index.css) find this scroller by it. */}
      <main id="main-scroll-container" className="flex-1 flex flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
          {/* A page chunk that cannot be fetched shows the reload card here,
              under a header that keeps working. */}
          <ChunkBoundary>
            <Suspense fallback={<CloudPageFallback />}>
              <CloudRoutes />
            </Suspense>
          </ChunkBoundary>
        </div>
        {full ? <div aria-hidden="true" data-nav-clearance className="nav-clearance md:hidden" /> : null}
      </main>
      {full ? <CloudTabBar /> : null}
      <ToasterGate aboveNav={full} />
    </div>
  );
}

export default function PrintCloudApp() {
  useDocumentTitle(CLOUD_TITLE);
  return (
    <CloudProvider>
      <CloudShell />
    </CloudProvider>
  );
}
