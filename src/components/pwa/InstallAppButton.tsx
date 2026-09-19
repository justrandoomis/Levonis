/**
 * The one entry point to «تحميل التطبيق».
 *
 * IT DISAPPEARS WHEN THE APP IS ALREADY INSTALLED. Offering to install the
 * thing the customer is currently standing inside is the clearest possible
 * signal that a feature does not know what it is doing, and on iOS it is not
 * even detectable from the display-mode query — `navigator.standalone` is the
 * only signal there, which is why `src/lib/pwa.ts` checks it first.
 *
 * THE SHEET IS LAZY, THE BUTTON IS NOT. `tests/bundleBudget.test.ts` holds the
 * entry chunk to 120 KB gzip and the whole first payload to 240 KB, and this
 * button is reachable from Settings — a lazy route — but the update toast
 * beside it is mounted at the root of the app. Keeping the sheet's markup,
 * its icon set and its five branches behind `React.lazy` means none of it is
 * a static dependency of the entry, while the trigger stays synchronous so it
 * never flashes in after the page has settled.
 *
 * ONCE OPENED IT STAYS MOUNTED. Unmounting the sheet the instant `open` goes
 * false would skip its exit animation entirely — `AnimatePresence` inside the
 * primitive needs the element to survive the close in order to animate it
 * out, and a window that vanishes is the defect Overlay.tsx exists to remove.
 *
 * `offered` IS THE DIFFERENCE BETWEEN AN OFFER AND A CONTROL, and the «ليس
 * الآن» memory only means anything because of it.
 *
 * The button sits in two kinds of place. In Settings the customer went
 * looking for it: they opened Settings, scrolled to Preferences and are
 * reading the row. Hiding that control because they once said "not now"
 * would be hiding a setting from the person who came to change it — the
 * "control with no effect" defect in reverse.
 *
 * On the Profile card and in the storefront the app VOLUNTEERS it. Nobody
 * asked; it is there because we put it there. That is the surface «ليس الآن»
 * is an answer to, and it is the surface that has to go quiet for the thirty
 * days `INSTALL_DISMISS_MS` argues for. Before this flag existed the
 * dismissal was written to `localStorage` and never read by anything, so the
 * sheet's own comment described a month of silence that did not happen.
 */
import { Download } from 'lucide-react';
import React, { Suspense, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { useInstallApp } from '../../hooks/useInstallApp';

const InstallAppSheet = React.lazy(() => import('./InstallAppSheet'));

export interface InstallAppButtonProps {
  /** Geometry and variant only; the caller owns where this sits. */
  className?: string;
  /**
   * True where the app volunteered this button rather than the customer going
   * looking for it. An offered button disappears for the month after «ليس
   * الآن»; a control the customer navigated to does not. See the header.
   */
  offered?: boolean;
}

export default function InstallAppButton({
  className = 'lv-button lv-button-secondary mt-2',
  offered = false,
}: InstallAppButtonProps) {
  const { t } = useLanguage();
  const { standalone, dismissed } = useInstallApp();
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);

  if (standalone) return null;
  // Read AFTER `everOpened`, so a sheet that is open when the customer taps
  // «ليس الآن» is not torn out from under its own exit animation: `dismissed`
  // flips synchronously, and unmounting here would take the window with it.
  if (offered && dismissed && !everOpened) return null;

  const show = () => {
    setEverOpened(true);
    setOpen(true);
  };

  return (
    <>
      <button type="button" onClick={show} className={className}>
        <Download aria-hidden="true" className="w-4 h-4" />
        {t('pwaInstallTitle')}
      </button>
      {everOpened ? (
        // No fallback: the sheet IS the window, so a spinner in its place
        // would be a second, differently-shaped window arriving first.
        <Suspense fallback={null}>
          <InstallAppSheet open={open} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
